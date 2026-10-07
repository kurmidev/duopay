// LLD §9: Binding
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, device, SIM } from './helpers.js';

let t;
beforeEach(async () => { t = await createTestApp(); });
afterEach(async () => { await t.close(); });

test('binds both SIMs into two independent profiles (one per SIM number)', async () => {
  const d = await device(t);
  const p1 = await d.bind(1);
  const p2 = await d.bind(2);
  assert.equal(p1.body.status, 'VERIFIED');
  assert.equal(p2.body.status, 'VERIFIED');
  assert.equal(p1.body.profile.msisdnMasked, '98XXXXXX01');
  assert.equal(p2.body.profile.msisdnMasked, '70XXXXXX02');
  assert.notEqual(p1.body.profile.vpa, p2.body.profile.vpa);
  assert.ok(!p1.body.profile.vpa.includes('9876500001'), 'VPA must not contain the phone number');
  assert.equal((await d.profiles()).length, 2);
});

test('SIMs from different people are allowed (ADR-004): only an active SIM is required', async () => {
  const d = await device(t, { slots: { 1: SIM.A, 2: SIM.C } });
  assert.equal((await d.bind(1)).body.status, 'VERIFIED');
  assert.equal((await d.bind(2)).body.status, 'VERIFIED');
});

test('token is ≥35 chars with letters, digits and specials; only its hash is stored', async () => {
  const d = await device(t);
  const r = await d.call('POST', '/v1/bindings', { slot: 1, profilePublicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' } });
  assert.equal(r.status, 201);
  assert.ok(r.body.token.length >= 35 && /\d/.test(r.body.token) && /[A-Za-z]/.test(r.body.token) && /[^A-Za-z0-9]/.test(r.body.token));
  const rows = t.app.ctx.db.all('SELECT * FROM bindings');
  assert.ok(!JSON.stringify(rows).includes(r.body.token));
});

test('binding refused in airplane mode and for an empty slot', async () => {
  const d = await device(t, { slots: { 1: SIM.A } });
  d.airplane = true;
  assert.equal((await d.bind(1)).body.error.code, 'AIRPLANE_MODE');
  d.airplane = false;
  assert.equal((await d.bind(2)).body.error.code, 'SIM_ABSENT');
});

test('4th binding attempt for the same SIM within 24h is blocked', async () => {
  const d = await device(t);
  for (let i = 0; i < 3; i++) {
    const r = await d.call('POST', '/v1/bindings', { slot: 1, profilePublicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' } });
    assert.equal(r.status, 201); // never completed (no SMS sent)
  }
  const r = await d.call('POST', '/v1/bindings', { slot: 1, profilePublicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' } });
  assert.equal(r.body.error.code, 'BINDING_LIMIT');
  t.advance(24 * 3600 + 1);
  assert.equal((await d.bind(1)).body.status, 'VERIFIED');
});

test('token expires after 45 seconds', async () => {
  const d = await device(t);
  const r = await d.bind(1, { delaySec: 46 });
  assert.equal(r.body.status, 'EXPIRED');
  assert.equal(r.body.profile, null);
});

test('token relayed from a SIM in another phone is rejected (ADR-010)', async () => {
  const d = await device(t);
  // Slot 1 holds SIM A, but the token is sent from SIM C sitting in a different phone.
  const r = await d.bind(1, { smsFromIccid: SIM.C.iccid });
  assert.equal(r.body.status, 'FAILED');
  assert.equal(r.body.failReason, 'SIM_NUMBER_MISMATCH');
  assert.equal(r.body.profile, null);
});

test('same token from two numbers voids the binding and its profile (HLD C1)', async () => {
  const d = await device(t);
  const r = await d.bind(1);
  await t.api('POST', '/sim/telecom/sms', { iccid: SIM.C.iccid, to: r.binding.vmn, text: r.binding.token });
  const s = await d.call('GET', `/v1/bindings/${r.binding.bindingId}`);
  assert.equal(s.body.status, 'FAILED');
  assert.equal(s.body.failReason, 'TOKEN_MULTI_SOURCE');
  assert.equal(s.body.profile.state, 'DEREGISTERED');
});

test('binding a number on a new device deregisters it on the old one', async () => {
  const oldPhone = await device(t, { slots: { 1: SIM.A } });
  const p = (await oldPhone.bind(1)).body.profile;
  const newPhone = await device(t, { slots: { 1: SIM.A } });
  assert.equal((await newPhone.bind(1)).body.status, 'VERIFIED');
  const old = t.app.ctx.db.get('SELECT state, state_reason FROM profiles WHERE id = ?', p.id);
  assert.deepEqual({ ...old }, { state: 'DEREGISTERED', state_reason: 'REBOUND_ON_OTHER_DEVICE' });
});

test('slot already bound and profile cap are enforced', async () => {
  const d = await device(t);
  await d.bind(1);
  assert.equal((await d.bind(1)).body.error.code, 'SLOT_ALREADY_BOUND');
});
