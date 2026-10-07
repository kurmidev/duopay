// LLD §9: Security
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestApp, onboardedDevice, device, PINS } from './helpers.js';
import { verify } from '../src/modules/audit.js';

let t;
beforeEach(async () => { t = await createTestApp(); });
afterEach(async () => { await t.close(); });

test('rejects missing, wrong-key and stale signatures', async () => {
  const d = await device(t);
  assert.equal((await t.api('GET', '/v1/profiles')).body.error.code, 'INVALID_SIGNATURE');
  const forged = await d.call('GET', '/v1/profiles', null, { headers: {}, installKey: await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) });
  assert.equal(forged.body.error.code, 'INVALID_SIGNATURE');
  assert.equal((await d.call('GET', '/v1/profiles', null, { ts: t.nowMs() - 300_000 })).body.error.code, 'REPLAY');
});

test('replayed nonce is rejected', async () => {
  const d = await device(t);
  const nonce = 'n'.repeat(24);
  assert.equal((await d.call('GET', '/v1/profiles', null, { nonce })).status, 200);
  assert.equal((await d.call('GET', '/v1/profiles', null, { nonce })).body.error.code, 'REPLAY');
});

test('tampering with X-Sim-State after signing breaks the signature', async () => {
  const { d } = await onboardedDevice(t);
  const bothPresent = d.simHeader();
  delete d.slots[2];
  // Signed while SIM 2 is absent, but an attacker swaps in a "both SIMs present" header in transit.
  const tampered = await d.call('GET', '/v1/profiles', null, { sendSimHeader: bothPresent });
  assert.equal(tampered.body.error.code, 'INVALID_SIGNATURE');
  assert.equal((await d.call('GET', '/v1/profiles')).status, 200);
});

test('PIN, credBlock and binding token never reach the DB or audit log', async () => {
  const o = await onboardedDevice(t);
  t.advance(25 * 3600);
  const cred = await o.d.credBlock('AARV', PINS.AARV, 12_300, 'chaiwala@okpsp');
  await o.d.call('POST', '/v1/payments', { accountId: o.acc.AARV.id, payeeVpa: 'chaiwala@okpsp', amountPaise: 12_300, credBlock: cred },
    { profileKey: o.d.profileKeys[o.p1], headers: { 'idempotency-key': crypto.randomUUID() } });
  const dump = JSON.stringify(['transactions', 'audit_log', 'bindings'].map((tb) => t.app.ctx.db.all(`SELECT * FROM ${tb}`)));
  assert.ok(!dump.includes(cred.slice(0, 40)));
  assert.ok(!/"pin"/i.test(dump));
});

test('audit chain verifies and detects tampering', async () => {
  await onboardedDevice(t);
  assert.equal(verify(t.app.ctx).ok, true);
  t.app.ctx.db.run("UPDATE audit_log SET data = '{\"slot\":9}' WHERE seq = 3");
  const v = verify(t.app.ctx);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 3);
});

test('security headers are set and simulator routes vanish when disabled', async () => {
  const res = await fetch(`${t.base}/`);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const prod = await createTestApp({ enableSimulators: false });
  assert.equal((await prod.api('GET', '/sim/world')).status, 404);
  assert.equal((await prod.api('GET', '/ops/audit')).status, 404);
  await prod.close();
});

test('the UI never injects data with innerHTML', () => {
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(!/\.innerHTML\s*=\s*[^'"`\s]/.test(js), 'innerHTML assigned from a variable');
});
