// LLD §9: Payments, Limits / risk
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, onboardedDevice, PINS, uuid } from './helpers.js';

let t;
let o;
beforeEach(async () => {
  t = await createTestApp({ statusCheckGapSec: 90 });
  o = await onboardedDevice(t);
  t.advance(25 * 3600); // past cooling-off unless a test needs it
});
afterEach(async () => { await t.close(); });

const payFrom = (bank, amountPaise, extra = {}) => {
  const profileId = ['AARV', 'BHRT'].includes(bank) ? o.p1 : o.p2;
  return o.d.pay({ account: o.acc[bank], profileId, amountPaise, pin: PINS[bank], ...extra });
};

test('pays from an account on SIM 1 and an account on SIM 2', async () => {
  const a = await payFrom('AARV', 25_000);
  const b = await payFrom('CSTL', 25_000);
  assert.equal(a.body.transaction.status, 'SUCCESS');
  assert.equal(a.body.transaction.fromSlot, 1);
  assert.equal(b.body.transaction.status, 'SUCCESS');
  assert.equal(b.body.transaction.fromSlot, 2);
});

test("SIM 2's account can't be debited while SIM 2 is absent", async () => {
  delete o.d.slots[2];
  const r = await payFrom('CSTL', 10_000);
  assert.equal(r.body.error.code, 'PROFILE_NOT_ACTIVE');
  assert.equal((await payFrom('AARV', 10_000)).body.transaction.status, 'SUCCESS'); // SIM 1 unaffected
});

test("SIM 1's key can't authorise a debit from SIM 2's account (ADR-007)", async () => {
  const r = await o.d.pay({ account: o.acc.CSTL, amountPaise: 10_000, pin: PINS.CSTL, signWith: o.d.profileKeys[o.p1] });
  assert.equal(r.body.error.code, 'INVALID_SIGNATURE');
  const none = await o.d.call('POST', '/v1/payments', { accountId: o.acc.CSTL.id, payeeVpa: 'chaiwala@okpsp', amountPaise: 10_000, credBlock: 'x'.repeat(200) }, { headers: { 'idempotency-key': uuid() } });
  assert.equal(none.body.error.code, 'INVALID_SIGNATURE');
});

test('wrong PIN is a FAILURE transaction (INCORRECT_PIN), not an HTTP error', async () => {
  const r = await o.d.pay({ account: o.acc.AARV, profileId: o.p1, amountPaise: 10_000, pin: '0000' });
  assert.equal(r.status, 201);
  assert.equal(r.body.transaction.status, 'FAILURE');
  assert.equal(r.body.transaction.failureCode, 'INCORRECT_PIN');
});

test('idempotent replay returns the same transaction without a second debit', async () => {
  const idem = uuid();
  const first = await payFrom('AARV', 30_000, { idem });
  const again = await payFrom('AARV', 30_000, { idem });
  assert.equal(again.status, 200);
  assert.equal(again.body.transaction.id, first.body.transaction.id);
  assert.equal(t.app.ctx.db.get('SELECT COUNT(*) AS n FROM transactions').n, 1);
  const conflict = await payFrom('AARV', 31_000, { idem });
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
});

test('cooling-off caps a newly verified SIM at ₹5,000 for 24h', async () => {
  delete o.d.slots[2];
  await o.d.call('POST', '/v1/sim-state');
  o.d.slots[2] = (await import('./helpers.js')).SIM.B;
  await o.d.call('POST', '/v1/sim-state'); // re-activated → cooling-off restarts
  t.advance(2 * 3600);
  const r = await payFrom('CSTL', 600_000);
  assert.equal(r.body.error.code, 'COOLING_OFF_LIMIT');
  assert.equal((await payFrom('CSTL', 400_000)).body.transaction.status, 'SUCCESS');
});

test("bank daily limit is enforced per account (Bharat Co-op: ₹25,000)", async () => {
  assert.equal((await payFrom('BHRT', 2_000_000)).body.transaction.status, 'SUCCESS');
  const r = await payFrom('BHRT', 600_000);
  assert.equal(r.body.error.code, 'LIMIT_EXCEEDED');
});

test('device velocity rule spans profiles: 6th payment in 5 minutes across both SIMs is blocked', async () => {
  for (const bank of ['AARV', 'CSTL', 'AARV', 'CSTL', 'DCCN']) assert.equal((await payFrom(bank, 1_000)).body.transaction.status, 'SUCCESS');
  assert.equal((await payFrom('CSTL', 1_000)).body.error.code, 'RISK_BLOCKED');
});

test('first high-value payment to a new payee needs explicit confirmation', async () => {
  const r = await payFrom('DCCN', 2_500_000, { payeeVpa: 'sharma.rent@okpsp' });
  assert.equal(r.status, 428);
  assert.equal(r.body.error.code, 'CONFIRM_REQUIRED');
  const ok = await payFrom('DCCN', 2_500_000, { payeeVpa: 'sharma.rent@okpsp', confirm: true });
  assert.equal(ok.body.transaction.status, 'SUCCESS');
});

test('PENDING: status checks are paced (≥90s, max 3) and ReqPay is never re-sent', async () => {
  await t.api('POST', '/sim/banks/CSTL/mode', { mode: 'TIMEOUT' });
  const p = await payFrom('CSTL', 50_000);
  assert.equal(p.body.transaction.status, 'PENDING');
  const id = p.body.transaction.id;
  assert.equal((await o.d.call('POST', `/v1/payments/${id}/check-status`)).body.error.code, 'STATUS_CHECK_TOO_SOON');
  t.advance(91);
  assert.equal((await o.d.call('POST', `/v1/payments/${id}/check-status`)).body.transaction.status, 'PENDING');
  t.advance(91);
  await o.d.call('POST', `/v1/payments/${id}/check-status`);
  t.advance(91);
  const third = await o.d.call('POST', `/v1/payments/${id}/check-status`);
  assert.equal(third.body.transaction.status, 'DEEMED_PENDING');
  assert.equal(t.app.ctx.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'PAYMENT_INITIATED'").n, 1);
});

test('PENDING resolves to SUCCESS once the bank recovers', async () => {
  await t.api('POST', '/sim/banks/CSTL/mode', { mode: 'TIMEOUT' });
  const id = (await payFrom('CSTL', 50_000)).body.transaction.id;
  await t.api('POST', '/sim/banks/CSTL/mode', { mode: 'UP' });
  t.advance(91);
  assert.equal((await o.d.call('POST', `/v1/payments/${id}/check-status`)).body.transaction.status, 'SUCCESS');
});

test('a bank that is DOWN is rejected before debit', async () => {
  await t.api('POST', '/sim/banks/DCCN/mode', { mode: 'DOWN' });
  assert.equal((await payFrom('DCCN', 10_000)).body.error.code, 'BANK_DOWN');
});

test('captured PIN block cannot be replayed for another payment', async () => {
  const cred = await o.d.credBlock('AARV', PINS.AARV, 10_000, 'chaiwala@okpsp');
  const send = () => o.d.call('POST', '/v1/payments', { accountId: o.acc.AARV.id, payeeVpa: 'chaiwala@okpsp', amountPaise: 10_000, credBlock: cred },
    { profileKey: o.d.profileKeys[o.p1], headers: { 'idempotency-key': uuid() } });
  assert.equal((await send()).body.transaction.status, 'SUCCESS');
  const again = await send();
  assert.equal(again.body.transaction.failureCode, 'CRED_BLOCK_REPLAYED');
});

test('unknown fields and bad amounts are rejected', async () => {
  const r = await payFrom('AARV', 10_000, { extra: { payerVpa: 'evil@x' } });
  assert.equal(r.body.error.code, 'VALIDATION');
  assert.equal((await payFrom('AARV', 50)).body.error.code, 'VALIDATION');
});
