// Builds the app: DB, simulators, adapter, routes. Used by server.js and by tests.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { AppError } from './http/errors.js';
import { authenticate } from './http/auth.js';
import { createWorld, SIM_CARDS } from './simulators/world.js';
import { createPspSwitch } from './simulators/pspSwitch.js';
import { createTelecom } from './simulators/telecom.js';
import { createPspAdapter } from './adapters/psp.js';
import * as installations from './modules/installations.js';
import * as bindings from './modules/bindings.js';
import * as profiles from './modules/profiles.js';
import * as simIntegrity from './modules/simIntegrity.js';
import * as accounts from './modules/accounts.js';
import * as payments from './modules/payments.js';
import * as audit from './modules/audit.js';

const MAX_BODY = 16 * 1024;
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/cl.js': ['cl.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export function createApp(overrides = {}) {
  const cfg = loadConfig(overrides);
  const db = openDb(cfg.dbPath);
  const world = createWorld();
  const pspSwitch = createPspSwitch(world);
  const telecom = createTelecom(world, pspSwitch);
  const psp = createPspAdapter(pspSwitch);
  const ctx = { cfg, db, psp, callTool: overrides.callTool };
  psp.onSms((msg) => bindings.onSmsReceived(ctx, msg));

  // Route table: [method, pattern, handler, {signed, profileSig}]
  const routes = [];
  const route = (method, pattern, handler, opts = { signed: true }) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([A-Za-z0-9_-]+)'; })}$`);
    routes.push({ method, re, keys, handler, opts });
  };

  // ---- /v1 (signed unless stated) ----
  route('POST', '/v1/installations', ({ body }) => [201, installations.register(ctx, body)], { signed: false });
  route('POST', '/v1/sim-state', () => [200, {}]);
  route('POST', '/v1/bindings', ({ body, auth }) => [201, bindings.start(ctx, auth.installation.id, body, auth.simState, world.vmns)]);
  route('GET', '/v1/bindings/:id', ({ params, auth }) => [200, bindings.get(ctx, auth.installation.id, params.id)]);
  route('GET', '/v1/profiles', ({ auth }) => [200, {
    profiles: profiles.liveForInstallation(ctx, auth.installation.id).map((p) => ({ ...profiles.view(ctx, p), accounts: accounts.forProfile(ctx, p.id) })),
  }]);
  route('GET', '/v1/banks', () => [200, { banks: psp.banks().map(({ code, name, status }) => ({ code, name, status })) }]);
  route('POST', '/v1/profiles/:id/accounts/discover', ({ params, body, auth }) => [200, accounts.discover(ctx, auth.installation.id, params.id, body.bankCode, auth.simState)]);
  route('DELETE', '/v1/profiles/:id', ({ params, auth }) => {
    const p = profiles.get(ctx, params.id);
    if (!p || p.installation_id !== auth.installation.id || p.state === 'DEREGISTERED') throw new AppError('NOT_FOUND', 'profile not found');
    if (!auth.verifyProfileSig(JSON.parse(p.public_key_jwk))) throw new AppError('INVALID_SIGNATURE', 'Removal must be signed by that profile');
    profiles.transition(ctx, p.id, 'deregister', 'USER_REMOVED');
    return [204, null];
  });
  route('POST', '/v1/payments/suggest', async ({ body, auth }) => [200, await payments.suggest(ctx, auth.installation.id, body)]);
  route('POST', '/v1/payments', ({ body, auth, req }) => {
    const r = payments.pay(ctx, auth.installation.id, body, req.headers['idempotency-key'], auth.verifyProfileSig);
    return [r.replayed ? 200 : 201, { transaction: r.transaction }];
  });
  route('GET', '/v1/payments', ({ auth, url }) => [200, { transactions: payments.history(ctx, auth.installation.id, Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit'), 10) || 20))) }]);
  route('POST', '/v1/payments/:id/check-status', ({ params, auth }) => [200, payments.checkStatus(ctx, auth.installation.id, params.id)]);

  // ---- simulators + ops (dev only) ----
  if (cfg.enableSimulators) {
    route('GET', '/sim/world', () => [200, {
      sims: SIM_CARDS,
      banks: world.banks.map(({ code, name, mode, dailyLimitPaise }) => ({ code, name, mode, dailyLimitPaise })),
      accounts: world.accounts.map(({ msisdn, bank, number, type, pin }) => ({ msisdn, bank, masked: `XXXXXX${number.slice(-4)}`, type, demoPin: pin })),
      payees: world.payees,
    }], { signed: false });
    route('POST', '/sim/telecom/sms', ({ body }) => [200, telecom.sendSms(body)], { signed: false });
    route('GET', '/sim/npci/keys', ({ url }) => {
      const key = pspSwitch.publicKey(url.searchParams.get('bank'));
      if (!key) throw new AppError('NOT_FOUND', 'unknown bank');
      return [200, { bank: url.searchParams.get('bank'), spki: key }];
    }, { signed: false });
    route('POST', '/sim/banks/:code/mode', ({ params, body }) => {
      const b = world.banks.find((x) => x.code === params.code);
      if (!b || !['UP', 'DOWN', 'TIMEOUT'].includes(body.mode)) throw new AppError('VALIDATION', 'bank code and mode UP|DOWN|TIMEOUT required');
      b.mode = body.mode;
      return [200, { code: b.code, mode: b.mode }];
    }, { signed: false });
    route('GET', '/ops/audit', () => [200, { chain: audit.verify(ctx), entries: audit.list(ctx) }], { signed: false });
    route('GET', '/ops/profiles', () => [200, {
      profiles: db.all('SELECT * FROM profiles ORDER BY created_at DESC LIMIT 100').map((p) => ({ ...profiles.view(ctx, p), installationId: p.installation_id, updatedAt: p.updated_at })),
    }], { signed: false });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const send = (status, body) => {
      if (res.headersSent) return res.end();
      res.writeHead(status, { ...SECURITY_HEADERS, ...(body === null ? {} : { 'content-type': 'application/json' }) });
      res.end(body === null ? undefined : JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        const content = readFileSync(join(ROOT, 'public', file)); // read first: a missing file must not leave headers half-sent
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': `${type}; charset=utf-8` });
        return res.end(content);
      }
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) return send(404, { error: { code: 'NOT_FOUND', message: 'no such route' } });
      const params = Object.fromEntries(r.keys.map((k, i) => [k, url.pathname.match(r.re)[i + 1]]));

      const rawBody = await readBody(req);
      let body = {};
      if (rawBody) {
        try { body = JSON.parse(rawBody); } catch { throw new AppError('VALIDATION', 'Body must be JSON'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('VALIDATION', 'Body must be a JSON object');
      }

      let auth = null;
      let simCheck;
      if (r.opts.signed) {
        auth = authenticate(ctx, req, rawBody);
        simCheck = simIntegrity.check(ctx, auth.installation.id, auth.simState); // before any business logic
      }
      const [status, out] = await r.handler({ req, url, params, body, auth });
      if (out === null) return send(status, null);
      send(status, simCheck ? { ...out, simCheck } : out);
    } catch (e) {
      if (e instanceof AppError) return send(e.status, { error: { code: e.code, message: e.message, ...e.extra } });
      console.error('[duopay] unhandled error:', e.message); // message only: never request bodies (security rules)
      send(500, { error: { code: 'INTERNAL', message: 'Internal error' } });
    }
  }

  return { handle, ctx, cfg, world, close: () => db.close() };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new AppError('VALIDATION', 'Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
