// SMS device binding, one per SIM (LLD §4.1, HLD C1).
import { randomInt } from 'node:crypto';
import { newId, sha256, bindingToken, hmac, validP256Jwk } from '../lib/crypto.js';
import { nowIso, nowMs, isoMinus } from '../lib/time.js';
import { fail } from '../http/errors.js';
import * as profiles from './profiles.js';
import * as audit from './audit.js';

export function start(ctx, installationId, { slot, profilePublicKeyJwk }, simState, vmnPool) {
  if (!Number.isInteger(slot) || slot < 1 || slot > 4) fail('VALIDATION', 'slot must be 1-4');
  if (!validP256Jwk(profilePublicKeyJwk)) fail('VALIDATION', 'profilePublicKeyJwk must be a public EC P-256 JWK');
  if (simState.airplane) fail('AIRPLANE_MODE', 'Turn off airplane mode to verify your SIM');
  const sim = simState.slots.find((s) => s.slot === slot);
  if (!sim || sim.state !== 'READY') fail('SIM_ABSENT', `No active SIM in slot ${slot}`);

  return ctx.db.tx(() => {
    if (profiles.liveBySlot(ctx, installationId, slot)) fail('SLOT_ALREADY_BOUND', `Slot ${slot} already has a profile`);
    if (profiles.liveForInstallation(ctx, installationId).length >= ctx.cfg.maxProfiles) fail('PROFILE_CAP', `At most ${ctx.cfg.maxProfiles} profiles per device`);
    const attempts = ctx.db.get('SELECT COUNT(*) AS n FROM bindings WHERE installation_id = ? AND sim_fp = ? AND created_at > ?',
      installationId, sim.fp, isoMinus(86_400)).n;
    if (attempts >= ctx.cfg.bindingMaxAttempts) fail('BINDING_LIMIT', 'Too many verification attempts for this SIM. Try again after 24 hours');

    const id = newId('bnd');
    const token = bindingToken(40);
    const vmn = vmnPool[randomInt(vmnPool.length)];
    const expiresAt = new Date(nowMs() + ctx.cfg.bindingTtlSec * 1000).toISOString();
    ctx.db.run(`INSERT INTO bindings (id, installation_id, slot, sim_fp, carrier, token_hash, vmn, profile_key_jwk, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`, id, installationId, slot, sim.fp, sim.carrier, sha256(token), vmn, JSON.stringify(profilePublicKeyJwk), expiresAt, nowIso());
    audit.append(ctx, 'BINDING_STARTED', { installationId, bindingId: id, slot, attempt: attempts + 1 });
    return { bindingId: id, token, vmn, expiresAt };
  });
}

/** Inbound SMS from the PSP (via the adapter). The network supplies originMsisdn; the app can't forge it. */
export function onSmsReceived(ctx, { vmn, text, originMsisdn }) {
  ctx.db.tx(() => {
    const b = ctx.db.get('SELECT * FROM bindings WHERE token_hash = ?', sha256(String(text).trim()));
    if (!b) { audit.append(ctx, 'BINDING_UNKNOWN_TOKEN', {}); return; }
    const fromHash = hmac(ctx.cfg.dataKey, originMsisdn);
    const failWith = (status, reason) => {
      ctx.db.run('UPDATE bindings SET status = ?, fail_reason = ?, received_msisdn_hash = COALESCE(received_msisdn_hash, ?) WHERE id = ?', status, reason, fromHash, b.id);
      audit.append(ctx, 'BINDING_FAILED', { installationId: b.installation_id, bindingId: b.id, reason });
    };

    // HLD C1: the same token arriving from a second number during the binding window voids the binding,
    // including a profile already created from the first SMS.
    if (b.received_msisdn_hash && b.received_msisdn_hash !== fromHash) {
      if (b.profile_id) {
        const p = profiles.get(ctx, b.profile_id);
        if (p && p.state !== 'DEREGISTERED') profiles.transition(ctx, p.id, 'deregister', 'TOKEN_MULTI_SOURCE');
      }
      return failWith('FAILED', 'TOKEN_MULTI_SOURCE');
    }
    if (b.status !== 'PENDING') return; // duplicate delivery of the same SMS
    if (nowMs() > new Date(b.expires_at).getTime()) return failWith('EXPIRED', 'TOKEN_EXPIRED');
    if (vmn !== b.vmn) return failWith('FAILED', 'VMN_MISMATCH');
    // ADR-010: the SMS must come from the SIM in THIS slot. The SMS proves possession of some SIM with that
    // number; the operator cross-check rejects a token relayed from another phone. Production adds a telco
    // number-verification API for same-operator cases.
    if (ctx.psp.operatorOf(originMsisdn) !== b.carrier) return failWith('FAILED', 'SIM_NUMBER_MISMATCH');

    // A number lives on one device at a time: binding it here retires it elsewhere (normal UPI device change).
    const existing = profiles.liveByMsisdn(ctx, originMsisdn);
    if (existing && existing.installation_id !== b.installation_id) profiles.transition(ctx, existing.id, 'deregister', 'REBOUND_ON_OTHER_DEVICE');
    if (existing && existing.installation_id === b.installation_id) return failWith('FAILED', 'NUMBER_ALREADY_BOUND_ON_THIS_DEVICE');

    const p = profiles.create(ctx, { installationId: b.installation_id, slot: b.slot, msisdn: originMsisdn, simFp: b.sim_fp, publicKeyJwk: JSON.parse(b.profile_key_jwk) });
    ctx.db.run("UPDATE bindings SET status = 'VERIFIED', received_msisdn_hash = ?, profile_id = ? WHERE id = ?", fromHash, p.id, b.id);
    audit.append(ctx, 'BINDING_VERIFIED', { installationId: b.installation_id, profileId: p.id, bindingId: b.id, slot: b.slot });
  });
}

export function get(ctx, installationId, bindingId) {
  let b = ctx.db.get('SELECT * FROM bindings WHERE id = ? AND installation_id = ?', bindingId, installationId);
  if (!b) fail('NOT_FOUND', 'binding not found');
  if (b.status === 'PENDING' && nowMs() > new Date(b.expires_at).getTime()) {
    ctx.db.run("UPDATE bindings SET status = 'EXPIRED', fail_reason = 'TOKEN_EXPIRED' WHERE id = ? AND status = 'PENDING'", b.id);
    b = { ...b, status: 'EXPIRED', fail_reason: 'TOKEN_EXPIRED' };
  }
  const p = b.profile_id ? profiles.get(ctx, b.profile_id) : null;
  return { status: b.status, failReason: b.fail_reason, profile: p ? profiles.view(ctx, p) : null };
}
