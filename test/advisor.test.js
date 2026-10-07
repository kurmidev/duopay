// LLD §9: Advisor
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, onboardedDevice, PINS } from './helpers.js';
import { validateRanking } from '../src/modules/advisor.js';

let t;
afterEach(async () => { await t?.close(); t = null; });

const suggest = (d, amountPaise = 20_000, payeeVpa = 'chaiwala@okpsp') => d.call('POST', '/v1/payments/suggest', { payeeVpa, amountPaise });

test('rules ranking prefers the account habitually used for this payee', async () => {
  t = await createTestApp();
  const o = await onboardedDevice(t);
  t.advance(25 * 3600);
  for (let i = 0; i < 3; i++) await o.d.pay({ account: o.acc.DCCN, profileId: o.p2, amountPaise: 1_000, pin: PINS.DCCN });
  t.advance(600);
  const r = await suggest(o.d);
  assert.equal(r.body.source, 'rules');
  assert.equal(r.body.eligible[0].bank, 'DCCN');
  assert.match(r.body.reason, /usually pay this payee/);
  assert.equal(r.body.payee.name, 'Ravi Tea Stall');
});

test('ineligible accounts carry reasons: SIM absent, bank down, daily limit', async () => {
  t = await createTestApp();
  const o = await onboardedDevice(t);
  t.advance(25 * 3600);
  delete o.d.slots[2];
  await t.api('POST', '/sim/banks/AARV/mode', { mode: 'DOWN' });
  const r = await suggest(o.d, 3_000_000); // ₹30,000 > Bharat Co-op's ₹25,000 limit
  const reasons = Object.fromEntries(r.body.ineligible.map((x) => [x.bank, x.reason]));
  assert.deepEqual(reasons, { AARV: 'BANK_DOWN', BHRT: 'DAILY_LIMIT', CSTL: 'SIM_ABSENT', DCCN: 'SIM_ABSENT' });
  assert.equal(r.body.eligible.length, 0);
});

test('Claude ranking is used when valid; features contain no PII or balances', async () => {
  let seen;
  t = await createTestApp({
    anthropic: { apiKey: 'test', model: 'm', timeoutMs: 800 },
    callTool: async (req) => { seen = req; const refs = JSON.parse(req.user).accounts.map((a) => a.ref); return { ranking: refs.reverse(), reason: 'Deccan Bank: steady choice' }; },
  });
  const o = await onboardedDevice(t);
  t.advance(25 * 3600);
  const r = await suggest(o.d);
  assert.equal(r.body.source, 'claude');
  assert.equal(r.body.reason, 'Deccan Bank: steady choice');
  for (const leak of ['9876500001', '7012300002', 'XXXX', '@', 'balance', 'chaiwala', 'Ravi']) assert.ok(!seen.user.includes(leak), `PII/balance leaked to AI: ${leak}`);
});

test('Claude output with a foreign ref or invented number falls back to rules', async () => {
  for (const bad of [
    { ranking: ['A1', 'A2', 'A3', 'A9'], reason: 'x' },
    { ranking: ['A1', 'A2', 'A3', 'A4'], reason: 'Saves you 37% fees' },
    { ranking: ['A1', 'A1', 'A2', 'A3'], reason: 'dup' },
  ]) {
    t = await createTestApp({ anthropic: { apiKey: 'k', model: 'm', timeoutMs: 800 }, callTool: async () => bad });
    const o = await onboardedDevice(t);
    t.advance(25 * 3600);
    const r = await suggest(o.d);
    assert.equal(r.body.source, 'rules (AI output rejected)', JSON.stringify(bad));
    await t.close(); t = null;
  }
});

test('Claude timeout or error falls back to rules', async () => {
  t = await createTestApp({ anthropic: { apiKey: 'k', model: 'm', timeoutMs: 800 }, callTool: async () => { throw new Error('timeout'); } });
  const o = await onboardedDevice(t);
  t.advance(25 * 3600);
  const r = await suggest(o.d);
  assert.equal(r.body.source, 'rules (AI unavailable)');
  assert.equal(r.body.eligible.length, 4);
});

test('validateRanking unit cases', () => {
  const feats = [{ ref: 'A1', headroomPct: 62 }, { ref: 'A2', headroomPct: 100 }];
  assert.ok(validateRanking({ ranking: ['A2', 'A1'], reason: '62% limit left' }, feats));
  assert.equal(validateRanking({ ranking: ['A2'], reason: 'x' }, feats), null);
  assert.equal(validateRanking({ ranking: ['A2', 'A1'], reason: '₹500 cashback' }, feats), null);
  assert.equal(validateRanking(null, feats), null);
});
