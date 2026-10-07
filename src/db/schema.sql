-- DuoPay schema (SQLite for the prototype; PostgreSQL-compatible types and constraints).
-- Money is stored in paise (INTEGER). Timestamps are ISO-8601 UTC strings.
-- Personal data: MSISDN is stored encrypted (AES-256-GCM) plus a keyed hash for lookups.
-- Balances are never stored (NPCI OC-95).

CREATE TABLE IF NOT EXISTS installations (
  id                TEXT PRIMARY KEY,                 -- ins_xxx
  public_key_jwk    TEXT NOT NULL,                    -- ECDSA P-256 public key (device keystore)
  sim_salt          TEXT NOT NULL,                    -- per-install salt the app uses for SIM fingerprints
  device_model      TEXT,
  integrity_verdict TEXT NOT NULL DEFAULT 'UNVERIFIED', -- MEETS_DEVICE_INTEGRITY | UNVERIFIED | FAILED
  consent_sim_read  INTEGER NOT NULL DEFAULT 0,       -- DPDP consent flag
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id               TEXT PRIMARY KEY,                  -- prf_xxx
  installation_id  TEXT NOT NULL REFERENCES installations(id),
  slot             INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 4),
  msisdn_enc       TEXT NOT NULL,                     -- AES-256-GCM(iv:tag:ciphertext)
  msisdn_hash      TEXT NOT NULL,                     -- HMAC-SHA256(data key, msisdn)
  msisdn_masked    TEXT NOT NULL,                     -- 98XXXXXX01
  sim_fp           TEXT NOT NULL,                     -- fingerprint bound at binding time
  public_key_jwk   TEXT NOT NULL,                     -- per-profile signing key
  vpa              TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('BOUND','ACTIVE','SUSPENDED','DEREGISTERED')),
  state_reason     TEXT,
  activated_at     TEXT,                              -- start of cooling-off window
  suspended_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
-- One live profile per SIM number across the whole system (a number is bound to one device at a time)
CREATE UNIQUE INDEX IF NOT EXISTS ux_profiles_live_msisdn ON profiles(msisdn_hash) WHERE state <> 'DEREGISTERED';
-- A VPA belongs to one live profile (re-binding the same number reuses its VPA)
CREATE UNIQUE INDEX IF NOT EXISTS ux_profiles_live_vpa ON profiles(vpa) WHERE state <> 'DEREGISTERED';
-- One live profile per slot per installation
CREATE UNIQUE INDEX IF NOT EXISTS ux_profiles_live_slot ON profiles(installation_id, slot) WHERE state <> 'DEREGISTERED';

CREATE TABLE IF NOT EXISTS bindings (
  id               TEXT PRIMARY KEY,                  -- bnd_xxx
  installation_id  TEXT NOT NULL REFERENCES installations(id),
  slot             INTEGER NOT NULL,
  sim_fp           TEXT NOT NULL,
  carrier          TEXT NOT NULL,                     -- MCC-MNC the device reported for this slot (ADR-010)
  token_hash       TEXT NOT NULL UNIQUE,              -- SHA-256 of the SMS token (token itself never stored)
  vmn              TEXT NOT NULL,
  profile_key_jwk  TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('PENDING','VERIFIED','FAILED','EXPIRED')),
  fail_reason      TEXT,
  received_msisdn_hash TEXT,
  profile_id       TEXT REFERENCES profiles(id),
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_bindings_attempts ON bindings(installation_id, sim_fp, created_at);

CREATE TABLE IF NOT EXISTS accounts (
  id               TEXT PRIMARY KEY,                  -- acc_xxx
  profile_id       TEXT NOT NULL REFERENCES profiles(id),
  bank_code        TEXT NOT NULL,
  account_ref      TEXT NOT NULL,                     -- opaque reference returned by the bank
  masked_number    TEXT NOT NULL,                     -- XXXXXX1234
  ifsc             TEXT NOT NULL,
  account_type     TEXT NOT NULL,                     -- SAVINGS | CURRENT | OD
  created_at       TEXT NOT NULL,
  UNIQUE (profile_id, bank_code, account_ref)
);

CREATE TABLE IF NOT EXISTS transactions (
  id               TEXT PRIMARY KEY,                  -- txn_xxx (also the UPI txn id sent to the PSP)
  installation_id  TEXT NOT NULL REFERENCES installations(id),
  profile_id       TEXT NOT NULL REFERENCES profiles(id),
  account_id       TEXT NOT NULL REFERENCES accounts(id),
  idempotency_key  TEXT NOT NULL,
  request_hash     TEXT NOT NULL,                     -- detects reuse of a key with a different body
  payee_vpa        TEXT NOT NULL,
  payee_name       TEXT,
  amount_paise     INTEGER NOT NULL CHECK (amount_paise > 0),
  status           TEXT NOT NULL CHECK (status IN ('INITIATED','SUCCESS','FAILURE','PENDING','DEEMED_PENDING')),
  rrn              TEXT,                              -- bank reference number
  failure_code     TEXT,
  suggested_rank   INTEGER,                           -- position of the chosen account in the suggestion (null = no suggestion)
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (installation_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS ix_txn_account_day ON transactions(account_id, created_at);
CREATE INDEX IF NOT EXISTS ix_txn_install_time ON transactions(installation_id, created_at);

CREATE TABLE IF NOT EXISTS status_checks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id   TEXT NOT NULL REFERENCES transactions(id),
  checked_at       TEXT NOT NULL,
  result           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_quotas (
  installation_id  TEXT NOT NULL,
  api              TEXT NOT NULL,                     -- LIST_ACCOUNT | BAL_ENQ
  day              TEXT NOT NULL,                     -- YYYY-MM-DD (IST)
  count            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (installation_id, api, day)
);

CREATE TABLE IF NOT EXISTS request_nonces (
  nonce            TEXT PRIMARY KEY,
  installation_id  TEXT NOT NULL,
  seen_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  at               TEXT NOT NULL,
  installation_id  TEXT,
  profile_id       TEXT,
  event            TEXT NOT NULL,                     -- e.g. PROFILE_SUSPENDED, PAYMENT_SUCCESS
  data             TEXT NOT NULL,                     -- JSON, no PII beyond masked values
  prev_hash        TEXT NOT NULL,
  hash             TEXT NOT NULL                      -- SHA-256(prev_hash || canonical row)
);
