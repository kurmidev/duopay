// Suggest, pay, status check (LLD §4.8, ADR-007, ADR-008).
import { newId, sha256 } from '../lib/crypto.js';
import { nowIso, nowMs } from '../lib/time.js';
import { fail } from '../http/errors.js';
import * as profiles from './profiles.js';
import * as accounts from './accounts.js';
import * as limits from './limits.js';
import * as risk from './risk.js';
import * as advisor from './advisor.js';
import * as audit from './audit.js';

const VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;

function validateAmount(ctx, amountPaise) {
  if (!Number.isInteger(amountPaise) || amountPaise < 100 || amountPaise > ctx.cfg.txnLimitPaise) {
    fail('VALIDATION', 'amountPaise must be an integer between 100 (₹1) and the per-transaction limit');
  }
}

export async function suggest(ctx, installationId, { payeeVpa, amountPaise }) {
  if (typeof payeeVpa !== 'string' || !VPA_RE.test(payeeVpa)) fail('VALIDATION', 'invalid payeeVpa');
  validateAmount(ctx, amountPaise);
  const payee = ctx.psp.validateAddress(payeeVpa); // ReqValAdd
  if (!payee.valid) fail('PAYEE_INVALID', 'This UPI ID could not be verified');
  const ranked = await advisor.rank(ctx, installationId, { payeeVpa, amountPaise });
  return { payee: { vpa: payeeVpa, name: payee.name }, ...ranked };
}

const PAY_FIELDS = new Set(['accountId', 'payeeVpa', 'amountPaise', 'credBlock', 'confirm', 'suggestedRank', 'note']);

/**
 * @param verifyProfileSig (jwk) => boolean, provided by the HTTP layer from the signed request.
 */
export function pay(ctx, installationId, body, idempotencyKey, verifyProfileSig) {
  const unknown = Object.keys(body).filter((k) => !PAY_FIELDS.has(k));
  if (unknown.length) fail('VALIDATION', `unknown fields: ${unknown.join(', ')}`);
  const { accountId, payeeVpa, amountPaise, credBlock, confirm = false, suggestedRank = null, note = '' } = body;
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(idempotencyKey)) fail('VALIDATION', 'Idempotency-Key header (16-64 chars) is required');
  if (typeof payeeVpa !== 'string' || !VPA_RE.test(payeeVpa)) fail('VALIDATION', 'invalid payeeVpa');
  validateAmount(ctx, amountPaise);
  if (typeof credBlock !== 'string' || credBlock.length < 100 || credBlock.length > 2048) fail('VALIDATION', 'credBlock from the NPCI CL is required');
  const requestHash = sha256(JSON.stringify([accountId, payeeVpa, amountPaise, String(note).slice(0, 50)]));

  // Idempotent replay: return the stored transaction, never a second ReqPay (ADR-008).
  const existing = ctx.db.get('SELECT * FROM transactions WHERE installation_id = ? AND idempotency_key = ?', installationId, idempotencyKey);
  if (existing) {
    if (existing.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT', 'Idempotency-Key reused with a different request');
    return { transaction: view(ctx, existing), replayed: true };
  }

  const account = accounts.get(ctx, accountId);
  const profile = account && profiles.get(ctx, account.profile_id);
  if (!account || profile.installation_id !== installationId) fail('NOT_FOUND', 'account not found');
  if (profile.state !== 'ACTIVE') fail('PROFILE_NOT_ACTIVE', `SIM ${profile.slot} profile is ${profile.state}${profile.state_reason ? ` (${profile.state_reason})` : ''}`);
  // ADR-007: only the profile that owns the account may authorise its debit.
  if (!verifyProfileSig(JSON.parse(profile.public_key_jwk))) fail('INVALID_SIGNATURE', 'Payment must be signed by the SIM profile that owns this account');
  if (ctx.psp.bankStatus()[account.bank_code] === 'DOWN') fail('BANK_DOWN', 'The bank is not responding. Try another account');

  const txnId = newId('txn');
  const payee = ctx.psp.validateAddress(payeeVpa);
  if (!payee.valid) fail('PAYEE_INVALID', 'This UPI ID could not be verified');

  ctx.db.tx(() => {
    limits.assertFits(ctx, account, profile, amountPaise);
    const r = risk.evaluate(ctx, { installationId, profile, payeeVpa, amountPaise });
    if (r.decision === 'BLOCK') { audit.append(ctx, 'PAYMENT_RISK_BLOCKED', { installationId, profileId: profile.id, rules: r.rules.map((x) => x.id) }); fail('RISK_BLOCKED', r.rules[0].message, { rules: r.rules }); }
    if (r.decision === 'CONFIRM' && confirm !== true) fail('CONFIRM_REQUIRED', r.rules[0].message, { rules: r.rules });
    const at = nowIso();
    ctx.db.run(`INSERT INTO transactions (id, installation_id, profile_id, account_id, idempotency_key, request_hash, payee_vpa, payee_name, amount_paise, status, suggested_rank, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'INITIATED', ?, ?, ?)`,
    txnId, installationId, profile.id, account.id, idempotencyKey, requestHash, payeeVpa, payee.name, amountPaise,
    Number.isInteger(suggestedRank) ? suggestedRank : null, at, at);
    audit.append(ctx, 'PAYMENT_INITIATED', { installationId, profileId: profile.id, txnId, accountId: account.id, amountPaise, payeeVpa, suggestedRank });
  });

  // ReqPay outside the DB transaction. The credential block is passed through and never stored or logged.
  let r;
  try {
    r = ctx.psp.pay({ txnId, payerVpa: profile.vpa, bankCode: account.bank_code, accountRef: account.account_ref, payeeVpa, amountPaise, credBlock });
  } catch (e) {
    r = e.code === 'BANK_DOWN' ? { status: 'FAILURE', code: 'BANK_UNAVAILABLE' } : { status: 'PENDING' }; // unknown outcome → PENDING, never retry
  }
  ctx.db.tx(() => {
    ctx.db.run('UPDATE transactions SET status = ?, rrn = ?, failure_code = ?, updated_at = ? WHERE id = ?', r.status, r.rrn || null, r.code || null, nowIso(), txnId);
    audit.append(ctx, `PAYMENT_${r.status}`, { installationId, profileId: profile.id, txnId, status: r.status, code: r.code });
  });
  return { transaction: view(ctx, get(ctx, txnId)), replayed: false };
}

export function checkStatus(ctx, installationId, txnId) {
  const t = get(ctx, txnId);
  if (!t || t.installation_id !== installationId) fail('NOT_FOUND', 'transaction not found');
  if (t.status !== 'PENDING') fail('VALIDATION', `Transaction is ${t.status}, not PENDING`);
  const checks = ctx.db.all('SELECT checked_at FROM status_checks WHERE transaction_id = ? ORDER BY id', txnId);
  const created = new Date(t.created_at).getTime();
  if (checks.length >= ctx.cfg.statusCheckMax || nowMs() - created > ctx.cfg.statusCheckWindowSec * 1000) fail('STATUS_CHECK_LIMIT', 'Status check limit reached (NPCI)');
  const last = checks.length ? new Date(checks[checks.length - 1].checked_at).getTime() : created;
  const nextAllowed = last + ctx.cfg.statusCheckGapSec * 1000;
  if (nowMs() < nextAllowed) fail('STATUS_CHECK_TOO_SOON', 'Please wait before checking again (NPCI pacing)', { nextAllowedAt: new Date(nextAllowed).toISOString() });

  const r = ctx.psp.checkTxn(txnId); // ReqChkTxn, never ReqPay
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO status_checks (transaction_id, checked_at, result) VALUES (?, ?, ?)', txnId, nowIso(), r.status);
    const used = checks.length + 1;
    const status = r.status === 'PENDING' && used >= ctx.cfg.statusCheckMax ? 'DEEMED_PENDING' : r.status;
    ctx.db.run('UPDATE transactions SET status = ?, rrn = COALESCE(?, rrn), failure_code = ?, updated_at = ? WHERE id = ?', status, r.rrn || null, r.code || null, nowIso(), txnId);
    audit.append(ctx, 'PAYMENT_STATUS_CHECKED', { installationId, profileId: t.profile_id, txnId, status, checks: used });
  });
  const used = checks.length + 1;
  return {
    transaction: view(ctx, get(ctx, txnId)),
    checksUsed: used,
    nextAllowedAt: used < ctx.cfg.statusCheckMax ? new Date(nowMs() + ctx.cfg.statusCheckGapSec * 1000).toISOString() : null,
  };
}

export const get = (ctx, id) => ctx.db.get('SELECT * FROM transactions WHERE id = ?', id);

export function history(ctx, installationId, limit = 20) {
  return ctx.db.all('SELECT * FROM transactions WHERE installation_id = ? ORDER BY created_at DESC LIMIT ?', installationId, Math.min(100, limit)).map((t) => view(ctx, t));
}

export function view(ctx, t) {
  const a = accounts.get(ctx, t.account_id);
  const p = profiles.get(ctx, t.profile_id);
  const bank = ctx.psp.banks().find((b) => b.code === a.bank_code);
  return {
    id: t.id, status: t.status, rrn: t.rrn, failureCode: t.failure_code, amountPaise: t.amount_paise,
    payeeVpa: t.payee_vpa, payeeName: t.payee_name, fromSlot: p.slot, fromMsisdnMasked: p.msisdn_masked,
    bankName: bank?.name, maskedNumber: a.masked_number, createdAt: t.created_at,
  };
}
