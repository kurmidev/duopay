// Fictional world for the simulators: SIM cards, numbers, banks, accounts, payees.
// All names and numbers are invented. Never use real personal data here.
import { generateKeyPairSync } from 'node:crypto';

export const SIM_CARDS = [
  { iccid: '8991000000000000011', msisdn: '9876500001', operator: 'Op Alpha', mccMnc: '404-10', label: 'SIM A · personal' },
  { iccid: '8991000000000000022', msisdn: '7012300002', operator: 'Op Beta', mccMnc: '405-86', label: 'SIM B · work' },
  { iccid: '8991000000000000033', msisdn: '9123400003', operator: 'Op Delta', mccMnc: '405-52', label: 'SIM C · spare' },
  { iccid: '8991000000000000044', msisdn: '8000000004', operator: 'Op Gamma', mccMnc: '404-45', label: 'SIM D · no bank accounts' },
];

export const BANKS = [
  { code: 'AARV', name: 'Aarav Bank', ifscPrefix: 'AARV0', dailyLimitPaise: 10_000_000 },
  { code: 'BHRT', name: 'Bharat Co-op Bank', ifscPrefix: 'BHRT0', dailyLimitPaise: 2_500_000 },
  { code: 'CSTL', name: 'Coastal Bank', ifscPrefix: 'CSTL0', dailyLimitPaise: 10_000_000 },
  { code: 'DCCN', name: 'Deccan Bank', ifscPrefix: 'DCCN0', dailyLimitPaise: 10_000_000 },
];

// Accounts held at banks, keyed by the mobile number registered with the bank.
const ACCOUNTS = [
  { msisdn: '9876500001', bank: 'AARV', ref: 'AARV-1001', number: '501000123401', type: 'SAVINGS', pin: '1111', balance: 4_500_000 },
  { msisdn: '9876500001', bank: 'BHRT', ref: 'BHRT-2001', number: '402000567802', type: 'SAVINGS', pin: '2222', balance: 5_000_000 },
  { msisdn: '7012300002', bank: 'CSTL', ref: 'CSTL-3001', number: '303000901203', type: 'SAVINGS', pin: '3333', balance: 12_000_000 },
  { msisdn: '7012300002', bank: 'DCCN', ref: 'DCCN-4001', number: '204000345604', type: 'CURRENT', pin: '4444', balance: 30_000_000 },
  { msisdn: '9123400003', bank: 'AARV', ref: 'AARV-1002', number: '501000777705', type: 'SAVINGS', pin: '5555', balance: 1_000_000 },
];

export const PAYEES = [
  { vpa: 'chaiwala@okpsp', name: 'Ravi Tea Stall' },
  { vpa: 'freshmart@okpsp', name: 'FreshMart Grocers' },
  { vpa: 'sharma.rent@okpsp', name: 'Sharma Properties' },
  { vpa: 'anita.k@okpsp', name: 'Anita K' },
  { vpa: 'metro.card@okpsp', name: 'City Metro Recharge' },
];

export const VMN_POOL = Array.from({ length: 10 }, (_, i) => `+9190000000${String(i).padStart(2, '0')}`);

/** Creates a fresh, mutable world (bank balances, keys, modes). One per app instance / test. */
export function createWorld() {
  const keys = {};
  for (const b of BANKS) {
    keys[b.code] = generateKeyPairSync('rsa', { modulusLength: 2048 });
  }
  return {
    sims: SIM_CARDS.map((s) => ({ ...s })),
    banks: BANKS.map((b) => ({ ...b, mode: 'UP' })), // UP | DOWN | TIMEOUT
    accounts: ACCOUNTS.map((a) => ({ ...a })),
    payees: PAYEES.map((p) => ({ ...p })),
    keys,
    vmns: [...VMN_POOL],
  };
}
