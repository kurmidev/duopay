// Test harness: an in-memory app, a controllable clock, and a "device" that signs
// requests exactly like the browser app (WebCrypto ECDSA P-256, same canonical string).
import { createServer } from 'node:http';
import { webcrypto, createHash, publicEncrypt, createPublicKey, constants, randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { setClock, resetClock } from '../src/lib/time.js';
import { canonical } from '../src/http/auth.js';
import { SIM_CARDS } from '../src/simulators/world.js';

const { subtle } = webcrypto;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha = (s) => createHash('sha256').update(s).digest('hex');
export const SIM = Object.fromEntries(SIM_CARDS.map((s, i) => ['ABCD'[i], s]));

export async function createTestApp(overrides = {}) {
  let t = Date.parse('2026-10-07T05:00:00Z');
  setClock(() => t);
  const app = createApp({ dbPath: ':memory:', quiet: true, enableSimulators: true, anthropic: { apiKey: '', model: 'x', timeoutMs: 800 }, ...overrides });
  const server = createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app, base,
    advance: (sec) => { t += sec * 1000; },
    nowMs: () => t,
    async close() { server.closeAllConnections(); await new Promise((r) => server.close(r)); app.close(); resetClock(); },
    async api(method, path, body) {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json() };
    },
  };
}

const genKey = () => subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);

/** A simulated phone with SIM slots, running the DuoPay app. */
export async function device(t, { slots = { 1: SIM.A, 2: SIM.B } } = {}) {
  const key = await genKey();
  const pub = await subtle.exportKey('jwk', key.publicKey);
  const reg = await t.api('POST', '/v1/installations', { publicKeyJwk: pub, deviceModel: 'TestPhone', integrityToken: 'ok', consentSimRead: true });
  if (reg.status !== 201) throw new Error(JSON.stringify(reg.body));
  const { installationId, simSalt } = reg.body;
  const d = {
    installationId, simSalt, slots: { ...slots }, airplane: false, profileKeys: {},
    fp: (iccid) => sha(`${simSalt}:${iccid}`),
    simHeader(override) {
      const s = override || { airplane: d.airplane, slots: [1, 2].map((n) => (d.slots[n] ? { slot: n, state: 'READY', fp: d.fp(d.slots[n].iccid), carrier: d.slots[n].mccMnc } : { slot: n, state: 'ABSENT' })) };
      return b64u(JSON.stringify(s));
    },
    /** Signed request. opts.profileKey adds X-Profile-Signature; opts.simHeader / nonce / ts to tamper. */
    async call(method, path, body, opts = {}) {
      const raw = body ? JSON.stringify(body) : '';
      const now = String(opts.ts ?? t.nowMs());
      const nonce = opts.nonce || b64u(randomBytes(18));
      const simHeader = opts.simHeader || d.simHeader();
      const sentSimHeader = opts.sendSimHeader || simHeader; // tests can send a header other than the one signed
      const data = canonical({ method, path, ts: now, nonce, body: raw, simHeader });
      const sig = b64u(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, (opts.installKey || key).privateKey, Buffer.from(data)));
      const headers = { 'content-type': 'application/json', 'x-install-id': installationId, 'x-timestamp': now, 'x-nonce': nonce, 'x-sim-state': sentSimHeader, 'x-signature': sig, ...(opts.headers || {}) };
      if (opts.profileKey) headers['x-profile-signature'] = b64u(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, opts.profileKey.privateKey, Buffer.from(data)));
      const res = await fetch(t.base + path, { method, headers, body: raw || undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json() };
    },
    /** Full binding for a slot: start, send SMS from that SIM, poll. Returns the profile. */
    async bind(slot, { smsFromIccid, delaySec = 0 } = {}) {
      const pk = await genKey();
      const r = await d.call('POST', '/v1/bindings', { slot, profilePublicKeyJwk: await subtle.exportKey('jwk', pk.publicKey) });
      if (r.status !== 201) return r;
      if (delaySec) t.advance(delaySec);
      await t.api('POST', '/sim/telecom/sms', { iccid: smsFromIccid || d.slots[slot].iccid, to: r.body.vmn, text: r.body.token });
      const s = await d.call('GET', `/v1/bindings/${r.body.bindingId}`);
      if (s.body.profile) d.profileKeys[s.body.profile.id] = pk;
      return { status: s.status, body: s.body, binding: r.body };
    },
    async discover(profileId, bankCode) {
      return d.call('POST', `/v1/profiles/${profileId}/accounts/discover`, { bankCode });
    },
    async profiles() { return (await d.call('GET', '/v1/profiles')).body.profiles; },
    /** Encrypt the PIN like the NPCI CL does (RSA-OAEP-256 with the issuer's public key). */
    async credBlock(bank, pin, amountPaise, payeeVpa, extra = {}) {
      const { body } = await t.api('GET', `/sim/npci/keys?bank=${bank}`);
      const key = createPublicKey({ key: Buffer.from(body.spki, 'base64'), format: 'der', type: 'spki' });
      const block = { pin, amountPaise, payeeVpa, nonce: b64u(randomBytes(12)), ts: t.nowMs(), ...extra };
      return publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(JSON.stringify(block))).toString('base64');
    },
    async pay({ account, profileId, amountPaise, payeeVpa = 'chaiwala@okpsp', pin, idem = randomUUID(), confirm, signWith, extra = {} }) {
      const cred = await d.credBlock(account.bank, pin, amountPaise, payeeVpa);
      return d.call('POST', '/v1/payments', { accountId: account.id, payeeVpa, amountPaise, credBlock: cred, ...(confirm ? { confirm: true } : {}), ...extra },
        { profileKey: signWith || d.profileKeys[profileId], headers: { 'idempotency-key': idem } });
    },
  };
  return d;
}

/** Binds both SIMs and links all their accounts. Returns {d, p1, p2, acc} where acc maps bank code → account. */
export async function onboardedDevice(t) {
  const d = await device(t);
  const b1 = await d.bind(1);
  const b2 = await d.bind(2);
  const p1 = b1.body.profile.id;
  const p2 = b2.body.profile.id;
  for (const bank of ['AARV', 'BHRT']) await d.discover(p1, bank);
  for (const bank of ['CSTL', 'DCCN']) await d.discover(p2, bank);
  const acc = {};
  for (const p of await d.profiles()) for (const a of p.accounts) acc[a.bank] = a;
  return { d, p1, p2, acc };
}

export const PINS = { AARV: '1111', BHRT: '2222', CSTL: '3333', DCCN: '4444' };
export const uuid = randomUUID;
