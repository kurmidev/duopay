// Routing advisor (LLD §4.7, ADR-005): rules decide eligibility, a deterministic score always
// ranks, and Claude may re-rank and explain. Claude never sees PII or balances.
import { isoMinus } from '../lib/time.js';
import { callTool } from '../ai/claude.js';
import * as profiles from './profiles.js';
import * as limits from './limits.js';

const W = { payee: 0.45, success: 0.25, headroom: 0.2, recency: 0.1 };

/** Step 1: which accounts may pay this amount right now, and why not for the rest. */
export function eligibility(ctx, installationId, amountPaise) {
  const status = ctx.psp.bankStatus();
  const eligible = [];
  const ineligible = [];
  for (const p of profiles.liveForInstallation(ctx, installationId)) {
    for (const a of ctx.db.all('SELECT * FROM accounts WHERE profile_id = ? ORDER BY created_at', p.id)) {
      const base = { account: a, profile: p };
      let reason = null;
      const h = limits.headroom(ctx, a, p);
      if (p.state !== 'ACTIVE') reason = p.state_reason === 'AIRPLANE_MODE' ? 'AIRPLANE_MODE' : p.state === 'SUSPENDED' ? 'SIM_ABSENT' : 'PROFILE_NOT_ACTIVE';
      else if (status[a.bank_code] === 'DOWN') reason = 'BANK_DOWN';
      else if (h.countLeft <= 0 || amountPaise > h.amountLeftPaise) reason = 'DAILY_LIMIT';
      else if (h.coolingLeftPaise !== null && amountPaise > h.coolingLeftPaise) reason = 'COOLING_OFF';
      (reason ? ineligible : eligible).push({ ...base, headroom: h, reason });
    }
  }
  return { eligible, ineligible };
}

/** Step 2: anonymised features. No names, numbers, VPAs, notes or balances (HLD C4, security rules). */
export function features(ctx, installationId, payeeVpa, eligible) {
  const payeeRows = ctx.db.all("SELECT account_id, COUNT(*) AS n FROM transactions WHERE installation_id = ? AND payee_vpa = ? AND status = 'SUCCESS' GROUP BY account_id",
    installationId, payeeVpa);
  const payeeTotal = payeeRows.reduce((s, r) => s + r.n, 0);
  const bankNames = Object.fromEntries(ctx.psp.banks().map((b) => [b.code, b.name]));
  return eligible.map((e, i) => {
    const a = e.account;
    const sr = ctx.db.get("SELECT SUM(status = 'SUCCESS') AS ok, SUM(status = 'FAILURE') AS bad FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.bank_code = ? AND t.created_at > ?",
      a.bank_code, isoMinus(7 * 86_400));
    const n = (sr.ok || 0) + (sr.bad || 0);
    const successRate = n >= 5 ? sr.ok / n : 0.95;
    const last = ctx.db.get("SELECT MAX(created_at) AS at FROM transactions WHERE account_id = ? AND status = 'SUCCESS'", a.id).at;
    const daysAgo = last ? Math.floor((Date.parse(isoMinus(0)) - Date.parse(last)) / 86_400_000) : null;
    return {
      ref: `A${i + 1}`,
      bank: bankNames[a.bank_code] || a.bank_code,
      simSlot: e.profile.slot,
      payeeSharePct: payeeTotal ? Math.round((100 * (payeeRows.find((r) => r.account_id === a.id)?.n || 0)) / payeeTotal) : 0,
      bankSuccessPct: Math.round(successRate * 100),
      headroomPct: Math.round((100 * e.headroom.amountLeftPaise) / e.headroom.limitPaise),
      lastUsedDaysAgo: daysAgo,
    };
  });
}

/** Step 3: deterministic score (always computed; the fallback order). */
export function score(f) {
  const recency = f.lastUsedDaysAgo === null ? 0 : 1 / (1 + f.lastUsedDaysAgo);
  return W.payee * (f.payeeSharePct / 100) + W.success * (f.bankSuccessPct / 100) + W.headroom * (f.headroomPct / 100) + W.recency * recency;
}

function templateReason(top) {
  if (top.payeeSharePct >= 50) return `${top.bank}: you usually pay this payee from it`;
  if (top.lastUsedDaysAgo !== null && top.lastUsedDaysAgo <= 2) return `${top.bank}: your most recently used account`;
  if (top.headroomPct >= 90) return `${top.bank}: reliable bank with plenty of daily limit left`;
  return `${top.bank}: best mix of reliability and daily limit left`;
}

export const RANK_TOOL = {
  name: 'rank_accounts',
  description: 'Rank the eligible bank accounts for this UPI payment.',
  input_schema: {
    type: 'object',
    properties: {
      ranking: { type: 'array', items: { type: 'string' }, description: 'All account refs (A1, A2…), best first' },
      reason: { type: 'string', description: 'One short reason for the top choice, max 90 characters, naming its bank' },
    },
    required: ['ranking', 'reason'],
  },
};

export const SYSTEM = `You help a user choose which of their bank accounts to pay from in a UPI app.
All accounts given are already allowed to make this payment; you only order them.
Prefer the account the user habitually uses for this payee, then a reliable bank, then more daily limit left.
Use only the given features. Do not mention numbers that are not in the input. Reason: max 90 characters, name the bank.`;

/** Guardrail: ranking must be a permutation of the eligible refs; reason must not invent numbers. */
export function validateRanking(out, feats) {
  const refs = feats.map((f) => f.ref);
  if (!out || !Array.isArray(out.ranking) || typeof out.reason !== 'string') return null;
  if (out.ranking.length !== refs.length || new Set(out.ranking).size !== refs.length || !out.ranking.every((r) => refs.includes(r))) return null;
  const allowed = new Set(JSON.stringify(feats).match(/\d+/g) || []);
  if ((out.reason.match(/\d+/g) || []).some((n) => !allowed.has(n))) return null;
  return { ranking: out.ranking, reason: out.reason.slice(0, 90) };
}

export async function rank(ctx, installationId, { payeeVpa, amountPaise, payeeCategory = 'unknown' }) {
  const { eligible, ineligible } = eligibility(ctx, installationId, amountPaise);
  const feats = features(ctx, installationId, payeeVpa, eligible);
  const scored = feats.map((f, i) => ({ f, e: eligible[i], s: score(f) })).sort((a, b) => b.s - a.s);
  let order = scored;
  let source = 'rules';
  let reason = scored[0] ? templateReason(scored[0].f) : null;

  if (ctx.cfg.anthropic.apiKey && feats.length >= 2) {
    try {
      const out = await (ctx.callTool || callTool)({
        apiKey: ctx.cfg.anthropic.apiKey, model: ctx.cfg.anthropic.model, timeoutMs: ctx.cfg.anthropic.timeoutMs,
        system: SYSTEM, tool: RANK_TOOL,
        user: JSON.stringify({ payment: { amountBand: band(amountPaise), payeeCategory }, accounts: feats }),
      });
      const v = validateRanking(out, feats);
      if (v) {
        order = v.ranking.map((ref) => scored.find((x) => x.f.ref === ref));
        source = 'claude';
        reason = v.reason;
      } else {
        source = 'rules (AI output rejected)';
      }
    } catch {
      source = 'rules (AI unavailable)';
    }
  }

  return {
    source, reason,
    eligible: order.map(({ e, s }) => ({ ...accountView(ctx, e), score: Math.round(s * 100) / 100, headroom: e.headroom })),
    ineligible: ineligible.map((e) => ({ ...accountView(ctx, e), reason: e.reason })),
  };
}

const band = (p) => (p <= 50_000 ? 'small' : p <= 500_000 ? 'medium' : 'large'); // ≤₹500, ≤₹5,000, more

function accountView(ctx, e) {
  const bank = ctx.psp.banks().find((b) => b.code === e.account.bank_code);
  return {
    accountId: e.account.id, profileId: e.profile.id, slot: e.profile.slot, msisdnMasked: e.profile.msisdn_masked,
    bank: e.account.bank_code, bankName: bank?.name, maskedNumber: e.account.masked_number, type: e.account.account_type,
  };
}
