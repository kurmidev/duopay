// Signed-request verification (LLD §3.2) and SIM-state header parsing.
import { sha256, verifyEcdsa } from '../lib/crypto.js';
import { nowMs, nowIso, isoMinus } from '../lib/time.js';
import { fail } from './errors.js';
import * as installations from '../modules/installations.js';

export const canonical = ({ method, path, ts, nonce, body, simHeader }) =>
  [method, path, ts, nonce, sha256(body || ''), sha256(simHeader || '')].join('\n');

export function parseSimState(header) {
  let s;
  try { s = JSON.parse(Buffer.from(header || '', 'base64url').toString('utf8')); } catch { fail('VALIDATION', 'X-Sim-State is not valid base64url JSON'); }
  if (!s || typeof s.airplane !== 'boolean' || !Array.isArray(s.slots) || s.slots.length > 4) fail('VALIDATION', 'X-Sim-State must be {airplane, slots[]}');
  const slots = s.slots.map((x) => {
    if (!Number.isInteger(x.slot) || x.slot < 1 || x.slot > 4 || !['READY', 'ABSENT'].includes(x.state)) fail('VALIDATION', 'bad slot entry in X-Sim-State');
    if (x.state === 'READY' && !/^[0-9a-f]{64}$/.test(x.fp || '')) fail('VALIDATION', 'READY slots need a 64-hex fingerprint');
    if (x.state === 'READY' && !/^\d{3}-\d{2,3}$/.test(x.carrier || '')) fail('VALIDATION', 'READY slots need a carrier MCC-MNC');
    return { slot: x.slot, state: x.state, fp: x.state === 'READY' ? x.fp : null, carrier: x.state === 'READY' ? x.carrier : null };
  });
  return { airplane: s.airplane, slots };
}

/**
 * Verifies installation signature, timestamp window and nonce. Returns the request context,
 * including verifyProfileSig(jwk) for endpoints that need the owning profile's signature.
 */
export function authenticate(ctx, req, rawBody) {
  const h = req.headers;
  const installationId = h['x-install-id'];
  const ts = h['x-timestamp'];
  const nonce = h['x-nonce'];
  const sig = h['x-signature'];
  const simHeader = h['x-sim-state'];
  if (!installationId || !ts || !nonce || !sig || !simHeader) fail('INVALID_SIGNATURE', 'Missing signed-request headers');
  const inst = installations.get(ctx, String(installationId));
  if (!inst) fail('INVALID_SIGNATURE', 'Unknown installation');
  if (!/^\d{13}$/.test(ts) || Math.abs(nowMs() - Number(ts)) > ctx.cfg.clockSkewSec * 1000) fail('REPLAY', 'Timestamp outside the allowed window');
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(nonce)) fail('INVALID_SIGNATURE', 'Bad nonce');

  const url = new URL(req.url, 'http://x');
  const data = canonical({ method: req.method, path: url.pathname + url.search, ts, nonce, body: rawBody, simHeader });
  if (!verifyEcdsa(JSON.parse(inst.public_key_jwk), data, String(sig))) fail('INVALID_SIGNATURE', 'Signature check failed');

  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM request_nonces WHERE seen_at < ?', isoMinus(ctx.cfg.nonceTtlSec));
    if (ctx.db.get('SELECT 1 AS x FROM request_nonces WHERE nonce = ?', nonce)) fail('REPLAY', 'Nonce already used');
    ctx.db.run('INSERT INTO request_nonces (nonce, installation_id, seen_at) VALUES (?, ?, ?)', nonce, inst.id, nowIso());
  });

  const profileSig = h['x-profile-signature'];
  return {
    installation: inst,
    simState: parseSimState(simHeader),
    verifyProfileSig: (jwk) => Boolean(profileSig) && verifyEcdsa(jwk, data, String(profileSig)),
  };
}
