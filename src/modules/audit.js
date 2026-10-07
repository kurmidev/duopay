// Hash-chained, append-only audit ledger (LLD §4.9).
import { hmac } from '../lib/crypto.js';
import { nowIso } from '../lib/time.js';

// Allow-list: only these keys can ever reach the ledger (no PII, no secrets).
const ALLOWED = new Set([
  'slot', 'reason', 'from', 'to', 'state', 'bindingId', 'accountId', 'bankCode', 'amountPaise', 'txnId', 'status',
  'code', 'msisdnMasked', 'vpa', 'count', 'rules', 'source', 'decision', 'checks', 'suggestedRank', 'payeeVpa', 'attempt',
]);
const GENESIS = '0'.repeat(64);

const clean = (data = {}) => Object.fromEntries(Object.entries(data).filter(([k, v]) => ALLOWED.has(k) && v !== undefined));
// Keyed (HMAC) so someone with DB access but without DATA_KEY can't rewrite and re-chain the ledger.
const rowHash = (key, prev, at, event, profileId, data) => hmac(key, `${prev}|${at}|${event}|${profileId || ''}|${data}`);

export function append(ctx, event, { installationId = null, profileId = null, ...data } = {}) {
  return ctx.db.tx(() => {
    const prev = ctx.db.get('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1')?.hash || GENESIS;
    const at = nowIso();
    const json = JSON.stringify(clean(data));
    ctx.db.run('INSERT INTO audit_log (at, installation_id, profile_id, event, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
      at, installationId, profileId, event, json, prev, rowHash(ctx.cfg.dataKey, prev, at, event, profileId, json));
  });
}

/** Walks the chain; returns {ok, length, brokenAt}. */
export function verify(ctx) {
  let prev = GENESIS;
  const rows = ctx.db.all('SELECT * FROM audit_log ORDER BY seq');
  for (const r of rows) {
    if (r.prev_hash !== prev || r.hash !== rowHash(ctx.cfg.dataKey, prev, r.at, r.event, r.profile_id, r.data)) return { ok: false, length: rows.length, brokenAt: r.seq };
    prev = r.hash;
  }
  return { ok: true, length: rows.length, brokenAt: null };
}

export function list(ctx, { limit = 200, installationId } = {}) {
  return installationId
    ? ctx.db.all('SELECT seq, at, profile_id, event, data FROM audit_log WHERE installation_id = ? ORDER BY seq DESC LIMIT ?', installationId, limit)
    : ctx.db.all('SELECT seq, at, installation_id, profile_id, event, data FROM audit_log ORDER BY seq DESC LIMIT ?', limit);
}
