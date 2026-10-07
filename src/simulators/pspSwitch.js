// PSP + NPCI + issuer-bank simulator. Stands in for ReqListAccount, ReqValAdd, ReqPay,
// ReqChkTxn, ListKeys and bank health. Balances and PINs live only here (the "bank side").
import { privateDecrypt, constants } from 'node:crypto';
import { nowMs } from '../lib/time.js';

const PIN_BLOCK_MAX_AGE_MS = 120_000;

export function createPspSwitch(world) {
  let smsHandler = () => {};
  const pending = new Map(); // txnId -> {account, amountPaise}
  const results = new Map(); // txnId -> final result
  const usedNonces = new Set();

  const bank = (code) => world.banks.find((b) => b.code === code);
  const requireUp = (code) => {
    const b = bank(code);
    if (!b) throw Object.assign(new Error('unknown bank'), { code: 'NOT_FOUND' });
    if (b.mode === 'DOWN') throw Object.assign(new Error(`${b.name} is unavailable`), { code: 'BANK_DOWN' });
    return b;
  };

  function decryptPinBlock(bankCode, credBlock) {
    try {
      const plain = privateDecrypt(
        { key: world.keys[bankCode].privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(credBlock, 'base64'));
      return JSON.parse(plain.toString('utf8'));
    } catch {
      return null;
    }
  }

  return {
    onSms(handler) { smsHandler = handler; },
    inboundSms(msg) { smsHandler(msg); },

    publicKey(bankCode) {
      const k = world.keys[bankCode];
      if (!k) return null;
      return k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    },

    // MNP lookup: which operator currently serves this number (stands in for the national MNP database).
    operatorOf(msisdn) {
      return world.sims.find((s) => s.msisdn === msisdn)?.mccMnc || null;
    },

    bankStatus() {
      return Object.fromEntries(world.banks.map((b) => [b.code, b.mode === 'DOWN' ? 'DOWN' : 'UP']));
    },

    banks() {
      return world.banks.map((b) => ({ code: b.code, name: b.name, dailyLimitPaise: b.dailyLimitPaise, status: b.mode === 'DOWN' ? 'DOWN' : 'UP' }));
    },

    // ReqListAccount: accounts registered with this mobile number at this bank.
    listAccounts({ msisdn, bankCode }) {
      const b = requireUp(bankCode);
      return world.accounts
        .filter((a) => a.msisdn === msisdn && a.bank === bankCode)
        .map((a) => ({ accountRef: a.ref, maskedNumber: `XXXXXX${a.number.slice(-4)}`, ifsc: `${b.ifscPrefix}${a.number.slice(0, 6)}`, type: a.type }));
    },

    // ReqValAdd
    validateAddress(vpa) {
      const p = world.payees.find((x) => x.vpa === vpa);
      return p ? { valid: true, name: p.name } : { valid: false };
    },

    // ReqPay (debit leg; the credit leg is assumed to succeed)
    pay({ txnId, bankCode, accountRef, payeeVpa, amountPaise, credBlock }) {
      if (results.has(txnId)) return results.get(txnId); // the switch is idempotent on txn id
      const b = requireUp(bankCode);
      const account = world.accounts.find((a) => a.ref === accountRef && a.bank === bankCode);
      if (!account) return finish(txnId, { status: 'FAILURE', code: 'ACCOUNT_NOT_FOUND' });

      const block = decryptPinBlock(bankCode, credBlock);
      if (!block || typeof block.nonce !== 'string') return finish(txnId, { status: 'FAILURE', code: 'INVALID_CRED_BLOCK' });
      if (usedNonces.has(block.nonce)) return finish(txnId, { status: 'FAILURE', code: 'CRED_BLOCK_REPLAYED' });
      usedNonces.add(block.nonce);
      if (Math.abs(nowMs() - Number(block.ts)) > PIN_BLOCK_MAX_AGE_MS) return finish(txnId, { status: 'FAILURE', code: 'CRED_BLOCK_EXPIRED' });
      if (block.amountPaise !== amountPaise || block.payeeVpa !== payeeVpa) return finish(txnId, { status: 'FAILURE', code: 'CRED_BLOCK_MISMATCH' });
      if (block.pin !== account.pin) return finish(txnId, { status: 'FAILURE', code: 'INCORRECT_PIN' });
      if (account.balance < amountPaise) return finish(txnId, { status: 'FAILURE', code: 'INSUFFICIENT_FUNDS' });

      if (b.mode === 'TIMEOUT') {
        pending.set(txnId, { account, amountPaise });
        return { status: 'PENDING' };
      }
      account.balance -= amountPaise;
      return finish(txnId, { status: 'SUCCESS', rrn: rrn() });
    },

    // ReqChkTxn
    checkTxn(txnId) {
      if (results.has(txnId)) return results.get(txnId);
      const p = pending.get(txnId);
      if (!p) return { status: 'FAILURE', code: 'TXN_NOT_FOUND' };
      if (bank(p.account.bank).mode === 'TIMEOUT') return { status: 'PENDING' };
      pending.delete(txnId);
      p.account.balance -= p.amountPaise;
      return finish(txnId, { status: 'SUCCESS', rrn: rrn() });
    },
  };

  function finish(txnId, r) { results.set(txnId, r); return r; }
}

let rrnSeq = 600000;
const rrn = () => `6280${++rrnSeq}`;
