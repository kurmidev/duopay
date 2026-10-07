// The only boundary between DuoPay modules and the PSP (LLD §6).
// Today it wraps the simulator; a production adapter would speak UPI XML over mTLS.
import { AppError } from '../http/errors.js';

export function createPspAdapter(pspSwitch) {
  const wrap = (fn) => (...args) => {
    try {
      return fn(...args);
    } catch (e) {
      if (e.code === 'BANK_DOWN') throw new AppError('BANK_DOWN', e.message);
      if (e.code === 'NOT_FOUND') throw new AppError('NOT_FOUND', e.message);
      throw e;
    }
  };
  return {
    listAccounts: wrap(({ msisdn, bankCode }) => pspSwitch.listAccounts({ msisdn, bankCode })),
    validateAddress: wrap((vpa) => pspSwitch.validateAddress(vpa)),
    pay: wrap((req) => pspSwitch.pay(req)),
    checkTxn: wrap((txnId) => pspSwitch.checkTxn(txnId)),
    operatorOf: (msisdn) => pspSwitch.operatorOf(msisdn),
    bankStatus: () => pspSwitch.bankStatus(),
    banks: () => pspSwitch.banks(),
    onSms: (handler) => pspSwitch.onSms(handler),
  };
}
