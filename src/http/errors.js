// Error codes → HTTP status (LLD §7).
export const STATUS = {
  INVALID_SIGNATURE: 401, REPLAY: 401,
  AIRPLANE_MODE: 409, SIM_ABSENT: 409, SIM_CHANGED: 409, SLOT_ALREADY_BOUND: 409, PROFILE_CAP: 409,
  BINDING_LIMIT: 429, PROFILE_NOT_ACTIVE: 409, QUOTA_EXCEEDED: 429,
  LIMIT_EXCEEDED: 422, COOLING_OFF_LIMIT: 422, CONFIRM_REQUIRED: 428, RISK_BLOCKED: 403,
  PAYEE_INVALID: 422, BANK_DOWN: 503, IDEMPOTENCY_CONFLICT: 409,
  STATUS_CHECK_TOO_SOON: 429, STATUS_CHECK_LIMIT: 429, INVALID_TRANSITION: 409,
  VALIDATION: 400, NOT_FOUND: 404, INTERNAL: 500,
};

export class AppError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.code = code;
    this.status = STATUS[code] || 500;
    this.extra = extra;
  }
}

export const fail = (code, message, extra) => { throw new AppError(code, message, extra); };
