// LLD §9: SIM integrity + Accounts
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, device, onboardedDevice, SIM } from './helpers.js';

let t;
beforeEach(async () => { t = await createTestApp(); });
afterEach(async () => { await t.close(); });

const state = async (d, slot) => (await d.profiles()).find((p) => p.slot === slot)?.state;

test('linking accounts activates each profile; the unified list shows all banks', async () => {
  const { d } = await onboardedDevice(t);
  const ps = await d.profiles();
  assert.deepEqual(ps.map((p) => p.state), ['ACTIVE', 'ACTIVE']);
  assert.deepEqual(ps.flatMap((p) => p.accounts.map((a) => a.bank)).sort(), ['AARV', 'BHRT', 'CSTL', 'DCCN']);
});

test('removing SIM 2 suspends only profile 2; re-inserting reactivates it', async () => {
  const { d } = await onboardedDevice(t);
  delete d.slots[2];
  const r = await d.call('POST', '/v1/sim-state');
  assert.deepEqual(r.body.simCheck.map((x) => [x.slot, x.action, x.reason]), [[2, 'SUSPEND', 'SIM_ABSENT']]);
  assert.equal(await state(d, 1), 'ACTIVE');
  assert.equal(await state(d, 2), 'SUSPENDED');
  d.slots[2] = SIM.B;
  await d.call('POST', '/v1/sim-state');
  assert.equal(await state(d, 2), 'ACTIVE');
});

test('a different SIM in slot 2 deregisters profile 2', async () => {
  const { d } = await onboardedDevice(t);
  d.slots[2] = SIM.C;
  const r = await d.call('POST', '/v1/sim-state');
  assert.deepEqual(r.body.simCheck.map((x) => [x.slot, x.action, x.reason]), [[2, 'DEREGISTER', 'SIM_CHANGED']]);
  assert.equal((await d.profiles()).length, 1);
});

test('airplane mode suspends every profile', async () => {
  const { d } = await onboardedDevice(t);
  d.airplane = true;
  await d.call('POST', '/v1/sim-state');
  d.airplane = false;
  await d.call('POST', '/v1/sim-state');
  const ps = t.app.ctx.db.all("SELECT state FROM profiles WHERE state <> 'DEREGISTERED'");
  assert.ok(ps.every((p) => p.state === 'ACTIVE'));
  const events = t.app.ctx.db.all("SELECT data FROM audit_log WHERE event = 'PROFILE_SUSPENDED'").map((r) => JSON.parse(r.data).reason);
  assert.deepEqual(events, ['AIRPLANE_MODE', 'AIRPLANE_MODE']);
});

test('suspended for more than 7 days → deregistered', async () => {
  const { d } = await onboardedDevice(t);
  delete d.slots[2];
  await d.call('POST', '/v1/sim-state');
  t.advance(8 * 86_400);
  await d.call('POST', '/v1/sim-state');
  assert.equal((await d.profiles()).length, 1);
});

test('list-account quota (25/day) is shared by all profiles on the device (ADR-009)', async () => {
  const { d, p1, p2 } = await onboardedDevice(t); // used 4
  for (let i = 0; i < 21; i++) assert.equal((await d.discover(i % 2 ? p1 : p2, 'AARV')).status, 200);
  assert.equal((await d.discover(p2, 'CSTL')).body.error.code, 'QUOTA_EXCEEDED');
});

test('discovery is refused for a suspended profile', async () => {
  const { d, p2 } = await onboardedDevice(t);
  delete d.slots[2];
  assert.equal((await d.discover(p2, 'CSTL')).body.error.code, 'PROFILE_NOT_ACTIVE');
});

test('no balances, holder names, raw ICCIDs or clear numbers are stored', async () => {
  await onboardedDevice(t);
  const dump = JSON.stringify(['installations', 'profiles', 'bindings', 'accounts', 'audit_log'].map((tb) => t.app.ctx.db.all(`SELECT * FROM ${tb}`)));
  for (const leak of ['9876500001', '7012300002', SIM.A.iccid, SIM.B.iccid, '501000123401', 'balance']) assert.ok(!dump.includes(leak), `leaked ${leak}`);
});

test('a profile in a BOUND state with no accounts at that bank stays BOUND', async () => {
  const d = await device(t, { slots: { 1: SIM.D } });
  const p = (await d.bind(1)).body.profile;
  const r = await d.discover(p.id, 'AARV');
  assert.equal(r.body.accounts.length, 0);
  assert.equal(r.body.profileState, 'BOUND');
});
