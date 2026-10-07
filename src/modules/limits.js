// Per-account limits, cooling-off and NPCI API quotas (LLD §4.5).
// Figures are "as seen by DuoPay"; the issuer bank enforces its own limits across all apps.
import { istDay, istDayStartIso, nowMs } from '../lib/time.js';
import { fail } from '../http/errors.js';


export function bankDailyLimit(ctx, bankCode) {
  const bank = ctx.psp.banks().find((b) => b.code === bankCode);
  return Math.min(ctx.cfg.dailyLimitPaise, bank?.dailyLimitPaise ?? Infinity);
}

/** Remaining headroom for one account; coolingLeft is null outside the cooling-off window. */
export function headroom(ctx, account, profile) {
  const today = ctx.db.get(`SELECT COALESCE(SUM(amount_paise),0) AS amt, COUNT(*) AS n FROM transactions
    WHERE account_id = ? AND created_at >= ? AND status IN ('INITIATED','SUCCESS','PENDING','DEEMED_PENDING')`, account.id, istDayStartIso());
  const limit = bankDailyLimit(ctx, account.bank_code);
  let coolingLeft = null;
  if (profile.activated_at) {
    const since = new Date(profile.activated_at).getTime();
    if (nowMs() - since < ctx.cfg.coolingOffHours * 3600_000) {
      const used = ctx.db.get(`SELECT COALESCE(SUM(amount_paise),0) AS amt FROM transactions
        WHERE profile_id = ? AND created_at >= ? AND status IN ('INITIATED','SUCCESS','PENDING','DEEMED_PENDING')`, profile.id, profile.activated_at).amt;
      coolingLeft = Math.max(0, ctx.cfg.coolingOffPaise - used);
    }
  }
  return {
    limitPaise: limit,
    amountLeftPaise: Math.max(0, limit - today.amt),
    countLeft: Math.max(0, ctx.cfg.dailyCount - today.n),
    coolingLeftPaise: coolingLeft,
  };
}

/** Throws if the amount doesn't fit. Call inside the same tx that inserts the transaction. */
export function assertFits(ctx, account, profile, amountPaise) {
  if (amountPaise > ctx.cfg.txnLimitPaise) fail('LIMIT_EXCEEDED', 'Amount exceeds the per-transaction UPI limit');
  const h = headroom(ctx, account, profile);
  if (h.countLeft <= 0) fail('LIMIT_EXCEEDED', 'Daily transaction count reached for this account');
  if (amountPaise > h.amountLeftPaise) fail('LIMIT_EXCEEDED', 'Daily amount limit reached for this account', { headroom: h });
  if (h.coolingLeftPaise !== null && amountPaise > h.coolingLeftPaise) {
    fail('COOLING_OFF_LIMIT', 'New or re-verified SIM: payments are capped for the first 24 hours', { headroom: h });
  }
  return h;
}

/** NPCI per-app quotas, counted per installation (ADR-009). */
export function consumeQuota(ctx, installationId, api, limit) {
  return ctx.db.tx(() => {
    const day = istDay();
    const row = ctx.db.get('SELECT count FROM api_quotas WHERE installation_id = ? AND api = ? AND day = ?', installationId, api, day);
    const used = row?.count || 0;
    if (used >= limit) fail('QUOTA_EXCEEDED', `Daily limit for ${api} reached (NPCI)`);
    ctx.db.run(`INSERT INTO api_quotas (installation_id, api, day, count) VALUES (?, ?, ?, 1)
      ON CONFLICT (installation_id, api, day) DO UPDATE SET count = count + 1`, installationId, api, day);
    return { used: used + 1, limit };
  });
}
