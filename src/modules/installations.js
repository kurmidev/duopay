// App installation registration (API spec: POST /v1/installations).
import { randomBytes } from 'node:crypto';
import { newId, validP256Jwk } from '../lib/crypto.js';
import { nowIso } from '../lib/time.js';
import { fail } from '../http/errors.js';
import * as audit from './audit.js';

export function register(ctx, { publicKeyJwk, deviceModel, integrityToken, consentSimRead }) {
  if (!validP256Jwk(publicKeyJwk)) fail('VALIDATION', 'publicKeyJwk must be a public EC P-256 JWK');
  if (consentSimRead !== true) fail('VALIDATION', 'Consent to read SIM information is required for UPI device binding (DPDP)');
  const id = newId('ins');
  const simSalt = randomBytes(16).toString('hex');
  // Prototype: any non-empty token counts as attested. Production verifies Play Integrity server-side.
  const verdict = integrityToken ? 'MEETS_DEVICE_INTEGRITY' : 'UNVERIFIED';
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO installations (id, public_key_jwk, sim_salt, device_model, integrity_verdict, consent_sim_read, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      id, JSON.stringify(publicKeyJwk), simSalt, String(deviceModel || '').slice(0, 64), verdict, nowIso());
    audit.append(ctx, 'INSTALLATION_REGISTERED', { installationId: id, state: verdict });
  });
  return { installationId: id, simSalt };
}

export const get = (ctx, id) => ctx.db.get('SELECT * FROM installations WHERE id = ?', id);
