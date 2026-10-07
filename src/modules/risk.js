// Deterministic risk rules (LLD §4.6). R1/R2 are device-level: several SIM numbers on
// one phone don't multiply what the phone can move (ADR-004 compensating controls).
import { isoMinus, nowMs } from '../lib/time.js';

const RUPEE = 100;

export function evaluate(ctx, { installationId, profile, payeeVpa, amountPaise }) {
  const rules = [];
  const recentCount = ctx.db.get(`SELECT COUNT(*) AS n FROM transactions WHERE installation_id = ? AND created_at > ? AND status IN ('INITIATED','SUCCESS','PENDING','DEEMED_PENDING')`,
    installationId, isoMinus(300)).n;
  if (recentCount >= 5) rules.push({ id: 'DEVICE_VELOCITY', decision: 'BLOCK', message: 'Too many payments from this device in 5 minutes' });

  const dayAmount = ctx.db.get(`SELECT COALESCE(SUM(amount_paise),0) AS amt FROM transactions WHERE installation_id = ? AND created_at > ? AND status IN ('INITIATED','SUCCESS','PENDING','DEEMED_PENDING')`,
    installationId, isoMinus(86_400)).amt;
  if (dayAmount + amountPaise > 200_000 * RUPEE) rules.push({ id: 'DEVICE_AMOUNT', decision: 'BLOCK', message: 'Device-wide 24h amount limit across all SIM profiles' });

  const paidBefore = ctx.db.get("SELECT 1 AS x FROM transactions WHERE installation_id = ? AND payee_vpa = ? AND status = 'SUCCESS' LIMIT 1", installationId, payeeVpa);
  if (!paidBefore && amountPaise > 20_000 * RUPEE) rules.push({ id: 'NEW_PAYEE_HIGH', decision: 'CONFIRM', message: 'First payment to this payee above ₹20,000' });

  if (profile.activated_at && nowMs() - new Date(profile.activated_at).getTime() < 3600_000 && amountPaise > 2_000 * RUPEE) {
    rules.push({ id: 'RECENT_REACTIVATION', decision: 'CONFIRM', message: 'This SIM was verified less than an hour ago' });
  }

  const decision = rules.some((r) => r.decision === 'BLOCK') ? 'BLOCK' : rules.length ? 'CONFIRM' : 'ALLOW';
  return { decision, rules };
}
