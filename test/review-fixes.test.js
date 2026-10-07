// Regression tests for the independent security review (findings H1, H2, M1, M3, M4, L1, L2, L4).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, device, onboardedDevice, SIM } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { verify } from '../src/modules/audit.js';

let t;
beforeEach(async () => { t = await createTestApp(); });
afterEach(async () => { await t.close(); });

const JWK = { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' };

test('H1: concurrent bindings cannot exceed the profile cap', async () => {
  const d = await device(t, { slots: { 1: SIM.A, 2: SIM.B } });
  d.slots[3] = SIM.C;
  const three = { airplane: false, slots: [1, 2, 3].map((n) => ({ slot: n, state: 'READY', fp: d.fp(d.slots[n].iccid), carrier: d.slots[n].mccMnc })) };
  const hdr = Buffer.from(JSON.stringify(three)).toString('base64url');
  const r1 = await d.call('POST', '/v1/bindings', { slot: 1, profilePublicKeyJwk: JWK }, { simHeader: hdr });
  const r2 = await d.call('POST', '/v1/bindings', { slot: 2, profilePublicKeyJwk: JWK }, { simHeader: hdr });
  assert.equal(r1.status, 201);
  assert.equal(r2.body.error.code, 'BINDING_IN_PROGRESS');
  // Even if pending bindings existed, completion re-checks the cap:
  await t.api('POST', '/sim/telecom/sms', { iccid: SIM.A.iccid, to: r1.body.vmn, text: r1.body.token });
  for (const slot of [2, 3]) {
    const r = await d.call('POST', '/v1/bindings', { slot, profilePublicKeyJwk: JWK }, { simHeader: hdr });
    if (r.status === 201) await t.api('POST', '/sim/telecom/sms', { iccid: d.slots[slot].iccid, to: r.body.vmn, text: r.body.token });
  }
  const live = t.app.ctx.db.get("SELECT COUNT(*) AS n FROM profiles WHERE state <> 'DEREGISTERED'").n;
  assert.equal(live, 2);
});

test('H2: rotating the SIM fingerprint does not reset the attempt limit', async () => {
  const d = await device(t);
  for (let i = 0; i < 3; i++) {
    const fake = { airplane: false, slots: [{ slot: 1, state: 'READY', fp: String(i).repeat(64), carrier: '404-10' }] };
    const r = await d.call('POST', '/v1/bindings', { slot: 1, profilePublicKeyJwk: JWK }, { simHeader: Buffer.from(JSON.stringify(fake)).toString('base64url') });
    assert.equal(r.status, 201);
    t.advance(46);
  }
  const fake = { airplane: false, slots: [{ slot: 1, state: 'READY', fp: '9'.repeat(64), carrier: '404-10' }] };
  const r = await d.call('POST', '/v1/bindings', { slot: 1, profilePublicKeyJwk: JWK }, { simHeader: Buffer.from(JSON.stringify(fake)).toString('base64url') });
  assert.equal(r.body.error.code, 'BINDING_LIMIT');
});

test('H2: the per-number limit survives re-installing the app', async () => {
  for (let i = 0; i < 3; i++) {
    const d = await device(t, { slots: { 1: SIM.A } });
    assert.equal((await d.bind(1)).body.status, 'VERIFIED');
  }
  const d = await device(t, { slots: { 1: SIM.A } });
  const r = await d.bind(1);
  assert.equal(r.body.status, 'FAILED');
  assert.equal(r.body.failReason, 'BINDING_LIMIT');
});

test('M1: account discovery needs the SIM present and airplane mode off', async () => {
  const d = await device(t);
  const p = (await d.bind(2)).body.profile;
  delete d.slots[2];
  assert.equal((await d.discover(p.id, 'CSTL')).body.error.code, 'SIM_ABSENT');
  d.slots[2] = SIM.B;
  d.airplane = true;
  assert.equal((await d.discover(p.id, 'CSTL')).body.error.code, 'AIRPLANE_MODE');
  assert.equal(t.app.ctx.db.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
  assert.equal(t.app.ctx.db.get('SELECT state FROM profiles WHERE id = ?', p.id).state, 'BOUND');
});

test('M3: simulators can never be enabled in production', () => {
  const prev = { NODE_ENV: process.env.NODE_ENV, ENABLE_SIMULATORS: process.env.ENABLE_SIMULATORS, DATA_KEY: process.env.DATA_KEY };
  Object.assign(process.env, { NODE_ENV: 'production', ENABLE_SIMULATORS: 'true', DATA_KEY: 'a'.repeat(64) });
  try {
    assert.equal(loadConfig({ quiet: true }).enableSimulators, false);
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('M4: VPAs are random, high-entropy and never reissued', async () => {
  const d = await device(t, { slots: { 1: SIM.A } });
  const first = (await d.bind(1)).body.profile;
  assert.match(first.vpa, /^dp[0-9a-z]{8,}\.1@duopay$/);
  await d.call('DELETE', `/v1/profiles/${first.id}`, null, { profileKey: d.profileKeys[first.id] });
  const again = (await d.bind(1)).body.profile;
  assert.notEqual(again.vpa, first.vpa);
});

test('L2: history limit is clamped', async () => {
  const { d } = await onboardedDevice(t);
  assert.equal((await d.call('GET', '/v1/payments?limit=-1')).status, 200);
  assert.equal((await d.call('GET', '/v1/payments?limit=1.5')).status, 200);
});

test('L4: re-chaining the audit log without the key is detected', async () => {
  await onboardedDevice(t);
  const { createHash } = await import('node:crypto');
  // Attacker edits a row and recomputes an UNKEYED chain from that point.
  const rows = t.app.ctx.db.all('SELECT * FROM audit_log ORDER BY seq');
  let prev = rows[1].hash;
  for (const r of rows.slice(2)) {
    const data = r.seq === 3 ? '{"slot":9}' : r.data;
    const h = createHash('sha256').update(`${prev}|${r.at}|${r.event}|${r.profile_id || ''}|${data}`).digest('hex');
    t.app.ctx.db.run('UPDATE audit_log SET data = ?, prev_hash = ?, hash = ? WHERE seq = ?', data, prev, h, r.seq);
    prev = h;
  }
  assert.equal(verify(t.app.ctx).ok, false);
});
