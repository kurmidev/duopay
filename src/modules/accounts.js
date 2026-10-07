// Account discovery and linking per profile (LLD §4.4, HLD C3/C4).
import { newId, decrypt } from '../lib/crypto.js';
import { nowIso } from '../lib/time.js';
import { fail } from '../http/errors.js';
import * as profiles from './profiles.js';
import * as limits from './limits.js';
import * as audit from './audit.js';

export function discover(ctx, installationId, profileId, bankCode) {
  const p = profiles.get(ctx, profileId);
  if (!p || p.installation_id !== installationId) fail('NOT_FOUND', 'profile not found');
  if (!['BOUND', 'ACTIVE'].includes(p.state)) fail('PROFILE_NOT_ACTIVE', `Profile is ${p.state}${p.state_reason ? ` (${p.state_reason})` : ''}`);
  if (typeof bankCode !== 'string' || !/^[A-Z]{4}$/.test(bankCode)) fail('VALIDATION', 'bankCode must be a 4-letter bank code');

  // HLD C3/C5: ReqListAccount only here, and the per-app quota is shared by all profiles on the device.
  const quota = limits.consumeQuota(ctx, installationId, 'LIST_ACCOUNT', ctx.cfg.listAccountQuota);
  const found = ctx.psp.listAccounts({ msisdn: decrypt(ctx.cfg.dataKey, p.msisdn_enc), bankCode });

  ctx.db.tx(() => {
    for (const a of found) {
      // HLD C4: no balance, no holder name; masked number + opaque bank reference only.
      ctx.db.run(`INSERT INTO accounts (id, profile_id, bank_code, account_ref, masked_number, ifsc, account_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (profile_id, bank_code, account_ref) DO NOTHING`,
      newId('acc'), p.id, bankCode, a.accountRef, a.maskedNumber, a.ifsc, a.type, nowIso());
    }
    audit.append(ctx, 'ACCOUNTS_DISCOVERED', { installationId, profileId: p.id, bankCode, count: found.length });
    const linked = ctx.db.get('SELECT COUNT(*) AS n FROM accounts WHERE profile_id = ?', p.id).n;
    if (p.state === 'BOUND' && linked > 0) profiles.transition(ctx, p.id, 'activate', 'ACCOUNTS_LINKED');
  });

  return { accounts: forProfile(ctx, p.id), profileState: profiles.get(ctx, p.id).state, quota };
}

export const forProfile = (ctx, profileId) =>
  ctx.db.all('SELECT * FROM accounts WHERE profile_id = ? ORDER BY created_at', profileId).map(view.bind(null, ctx));

export function view(ctx, a) {
  const bank = ctx.psp.banks().find((b) => b.code === a.bank_code);
  return { id: a.id, bank: a.bank_code, bankName: bank?.name || a.bank_code, maskedNumber: a.masked_number, ifsc: a.ifsc, type: a.account_type };
}

export const get = (ctx, id) => ctx.db.get('SELECT * FROM accounts WHERE id = ?', id);
