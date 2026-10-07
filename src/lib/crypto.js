// Crypto helpers (LLD §3.1). Node built-ins only.
import { randomBytes, randomInt, createHash, createHmac, createCipheriv, createDecipheriv, createPublicKey, verify, timingSafeEqual } from 'node:crypto';

export const newId = (prefix) => `${prefix}_${randomBytes(16).toString('base64url')}`;
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const hmac = (keyHex, s) => createHmac('sha256', Buffer.from(keyHex, 'hex')).update(s).digest('hex');

const TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%*+=?@^_~';
/** Binding token: ≥35 chars, mixed alphanumeric + special (HLD C1). Guarantees at least one of each class. */
export function bindingToken(len = 40) {
  for (;;) {
    let t = '';
    for (let i = 0; i < len; i++) t += TOKEN_CHARS[randomInt(TOKEN_CHARS.length)];
    if (/[A-Za-z]/.test(t) && /\d/.test(t) && /[^A-Za-z0-9]/.test(t)) return t;
  }
}

export function encrypt(keyHex, plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join(':');
}

export function decrypt(keyHex, packed) {
  const [iv, tag, ct] = packed.split(':').map((s) => Buffer.from(s, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

export const maskMsisdn = (m) => `${m.slice(0, 2)}XXXXXX${m.slice(-2)}`;

/** Verify an ECDSA P-256 signature (IEEE-P1363 encoding, as WebCrypto produces). */
export function verifyEcdsa(jwk, data, signatureB64url) {
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    return verify('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signatureB64url, 'base64url'));
  } catch {
    return false;
  }
}

export function validP256Jwk(jwk) {
  return jwk && jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string' && !jwk.d;
}

export const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
