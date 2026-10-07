// Profile state machine (LLD §4.2). The ONLY place allowed to change profiles.state.
import { newId, encrypt, hmac, maskMsisdn, sha256 } from '../lib/crypto.js';
import { nowIso, nowMs } from '../lib/time.js';
import { AppError } from '../http/errors.js';
import * as audit from './audit.js';


const TRANSITIONS = {
  activate: { from: ['BOUND'], to: 'ACTIVE' },
  suspend: { from: ['ACTIVE'], to: 'SUSPENDED' },
  reactivate: { from: ['SUSPENDED'], to: 'ACTIVE' },
  deregister: { from: ['BOUND', 'ACTIVE', 'SUSPENDED'], to: 'DEREGISTERED' },
};

export function create(ctx, { installationId, slot, msisdn, simFp, publicKeyJwk }) {
  return ctx.db.tx(() => {
    const id = newId('prf');
    const msisdnHash = hmac(ctx.cfg.dataKey, msisdn);
    // VPA is deterministic per number but never contains it (LLD §4.1).
    const vpa = `${sha256(msisdnHash).slice(0, 4)}.${slot}@duopay`;
    const at = nowIso();
    ctx.db.run(`INSERT INTO profiles (id, installation_id, slot, msisdn_enc, msisdn_hash, msisdn_masked, sim_fp, public_key_jwk, vpa, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'BOUND', ?, ?)`,
    id, installationId, slot, encrypt(ctx.cfg.dataKey, msisdn), msisdnHash, maskMsisdn(msisdn), simFp, JSON.stringify(publicKeyJwk), vpa, at, at);
    audit.append(ctx, 'PROFILE_CREATED', { installationId, profileId: id, slot, msisdnMasked: maskMsisdn(msisdn), vpa });
    return get(ctx, id);
  });
}

export function transition(ctx, profileId, event, reason = null) {
  const t = TRANSITIONS[event];
  if (!t) throw new AppError('INVALID_TRANSITION', `unknown event ${event}`);
  return ctx.db.tx(() => {
    const p = get(ctx, profileId);
    if (!p || !t.from.includes(p.state)) throw new AppError('INVALID_TRANSITION', `${p?.state} -/-> ${t.to}`);
    const at = nowIso();
    const activatedAt = t.to === 'ACTIVE' ? at : p.activated_at; // cooling-off (re)starts on activation
    const suspendedAt = t.to === 'SUSPENDED' ? at : null;
    ctx.db.run('UPDATE profiles SET state = ?, state_reason = ?, activated_at = ?, suspended_at = ?, updated_at = ? WHERE id = ?',
      t.to, reason, activatedAt, suspendedAt, at, profileId);
    audit.append(ctx, `PROFILE_${t.to}`, { installationId: p.installation_id, profileId, from: p.state, to: t.to, reason, slot: p.slot });
    return get(ctx, profileId);
  });
}

export const get = (ctx, id) => ctx.db.get('SELECT * FROM profiles WHERE id = ?', id);

export const liveForInstallation = (ctx, installationId) =>
  ctx.db.all(`SELECT * FROM profiles WHERE installation_id = ? AND state <> 'DEREGISTERED' ORDER BY slot`, installationId);

export const liveBySlot = (ctx, installationId, slot) =>
  ctx.db.get(`SELECT * FROM profiles WHERE installation_id = ? AND slot = ? AND state <> 'DEREGISTERED'`, installationId, slot);

export const liveByMsisdn = (ctx, msisdn) =>
  ctx.db.get(`SELECT * FROM profiles WHERE msisdn_hash = ? AND state <> 'DEREGISTERED'`, hmac(ctx.cfg.dataKey, msisdn));

export function coolingOffUntil(ctx, p) {
  if (!p.activated_at) return null;
  const until = new Date(p.activated_at).getTime() + ctx.cfg.coolingOffHours * 3600_000;
  return until > nowMs() ? new Date(until).toISOString() : null;
}

/** Public view: never exposes ciphertext, hashes, keys or fingerprints. */
export function view(ctx, p) {
  return {
    id: p.id, slot: p.slot, msisdnMasked: p.msisdn_masked, vpa: p.vpa, state: p.state,
    stateReason: p.state_reason, coolingOffUntil: p.state === 'ACTIVE' ? coolingOffUntil(ctx, p) : null,
  };
}
