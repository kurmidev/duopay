// Configuration with env overrides (LLD §8). Loads .env without a dependency.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parses one .env line like the common dotenv format: `KEY=value`, `KEY="quoted # kept"`,
 * `KEY=value   # inline comment` (comment dropped), blank lines and `# comments` ignored, CRLF safe.
 * Returns [key, value] or null.
 */
export function parseDotEnvLine(line) {
  const m = line.replace(/\r$/, '').match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) return null;
  let v = m[2];
  const q = v.match(/^(["'])(.*?)\1/);
  if (q) v = q[2];
  else v = v.replace(/(^|\s+)#.*$/, '').trim(); // unquoted: drop inline comment
  return [m[1], v];
}

function loadDotEnv() {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const kv = parseDotEnvLine(line);
    if (kv && process.env[kv[0]] === undefined) process.env[kv[0]] = kv[1];
  }
}
loadDotEnv();

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const int = (k, d) => Number.parseInt(env(k, String(d)), 10);

// Dev only: persist a generated key next to the dev DB so encrypted numbers survive restarts.
function devDataKey(overrides) {
  if (overrides.dbPath === ':memory:') return randomBytes(32).toString('hex');
  const p = join(ROOT, 'data', 'dev-data-key');
  if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  mkdirSync(dirname(p), { recursive: true });
  const k = randomBytes(32).toString('hex');
  writeFileSync(p, k, { mode: 0o600 });
  if (!overrides.quiet) console.warn('[duopay] DATA_KEY not set: generated a dev key in data/dev-data-key (never use in production).');
  return k;
}

export function loadConfig(overrides = {}) {
  const production = env('NODE_ENV', 'development') === 'production';
  let dataKey = overrides.dataKey || env('DATA_KEY', '');
  if (!dataKey) {
    if (production) throw new Error('DATA_KEY (32-byte hex) is required in production');
    dataKey = devDataKey(overrides);
  }
  // AES-256 needs exactly 32 bytes. Fail at startup with a clear message instead of failing every SIM binding later.
  if (!/^[0-9a-fA-F]{64}$/.test(dataKey)) {
    throw new Error('DATA_KEY must be exactly 64 hex characters (32 bytes). Leave it empty in development, or generate one with:\n'
      + '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return {
    production,
    port: int('PORT', 3000),
    host: env('HOST', '127.0.0.1'),
    dbPath: env('DB_PATH', join(ROOT, 'data', 'duopay.db')),
    dataKey,
    maxProfiles: int('MAX_PROFILES', 2),
    bindingTtlSec: int('BINDING_TTL_SEC', 45),
    bindingMaxAttempts: int('BINDING_MAX_ATTEMPTS', 3),
    coolingOffPaise: int('COOLING_OFF_PAISE', 500_000),
    coolingOffHours: int('COOLING_OFF_HOURS', 24),
    dailyLimitPaise: int('DAILY_LIMIT_PAISE', 10_000_000),
    dailyCount: int('DAILY_COUNT', 20),
    txnLimitPaise: int('TXN_LIMIT_PAISE', 10_000_000),
    listAccountQuota: int('LIST_ACCOUNT_QUOTA', 25),
    statusCheckGapSec: int('STATUS_CHECK_GAP_SEC', process.argv.includes('--demo') ? 10 : 90), // --demo: shorter gap for live demos
    statusCheckMax: int('STATUS_CHECK_MAX', 3),
    statusCheckWindowSec: 2 * 3600,
    suspendTtlDays: int('SUSPEND_TTL_DAYS', 7),
    clockSkewSec: 120,
    nonceTtlSec: 600,
    anthropic: {
      apiKey: env('ANTHROPIC_API_KEY', ''),
      model: env('CLAUDE_MODEL', 'claude-haiku-4-5'),
      timeoutMs: int('ADVISOR_TIMEOUT_MS', 800),
    },
    // Simulator/ops routes fake SMS and expose demo PINs: they can never be enabled in production.
    enableSimulators: !production && env('ENABLE_SIMULATORS', 'true') === 'true',
    ...overrides,
  };
}
