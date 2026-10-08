// DuoPay app (runs "inside" the simulated phone) + phone hardware + ops console.
// Security: all dynamic text goes through textContent (no innerHTML with data); keys are
// non-extractable WebCrypto keys kept in IndexedDB (stand-in for the Android Keystore).
import { capturePin } from './cl.js';

const $ = (id) => document.getElementById(id);
const rupees = (p) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: p % 100 ? 2 : 0 }).format(p / 100);
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const utf8 = (s) => new TextEncoder().encode(s);
const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Tiny DOM builder. Strings become text nodes, so data is never parsed as HTML. */
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return e;
}

// ---------------------------------------------------------------- device storage (IndexedDB)
const idb = (() => {
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open('duopay-device', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => res(req?.result);
      tx.onerror = () => rej(tx.error);
    });
  };
  return {
    get: (k) => run('readonly', (s) => s.get(k)),
    set: (k, v) => run('readwrite', (s) => s.put(v, k)),
    clear: () => run('readwrite', (s) => s.clear()),
  };
})();

// ---------------------------------------------------------------- phone hardware
let world = { sims: [], banks: [], accounts: [], payees: [] };
let phone = JSON.parse(localStorage.getItem('duopay-phone') || 'null') || { slots: { 1: null, 2: null }, airplane: false };
const simByIccid = (iccid) => world.sims.find((s) => s.iccid === iccid);
const savePhone = () => localStorage.setItem('duopay-phone', JSON.stringify(phone));

function renderTray() {
  $('tray').replaceChildren(...[1, 2].map((slot) => h('div', { class: `slot s${slot}` },
    h('label', { for: `slot${slot}` }, `SIM slot ${slot}`),
    h('select', { id: `slot${slot}`, onchange: (e) => { phone.slots[slot] = e.target.value || null; onHardwareChange(); } },
      h('option', { value: '' }, '— empty —'),
      world.sims.map((s) => h('option', { value: s.iccid, selected: phone.slots[slot] === s.iccid }, `${s.label} (${s.operator})`))))));
  $('airplane').checked = phone.airplane;
}

function renderStatusbar() {
  const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  $('statusbar').replaceChildren(
    h('span', {}, time),
    h('span', { class: 'sims' }, phone.airplane ? h('span', {}, '✈ Airplane') : null,
      [1, 2].map((n) => {
        const s = simByIccid(phone.slots[n]);
        return h('span', { class: `sig s${n} ${!s || phone.airplane ? 'off' : ''}` }, `▂▄▆ ${s ? s.operator : 'No SIM'}`);
      })));
}

async function onHardwareChange() {
  savePhone();
  renderStatusbar();
  if (device) { // Android would deliver ACTION_SIM_STATE_CHANGED; the app reports it at once
    await call('POST', '/v1/sim-state');
    await refresh();
  }
}

// ---------------------------------------------------------------- signing
let device = null; // { installationId, simSalt, keys: CryptoKeyPair, profileKeys: { [profileId]: CryptoKeyPair } }
const genKey = () => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
const pubJwk = async (pair) => {
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kty, crv, x, y };
};
const sign = async (pair, data) => b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, utf8(data)));

async function simHeader() {
  const slots = [];
  for (const n of [1, 2]) {
    const s = simByIccid(phone.slots[n]);
    // Only a salted fingerprint of the SIM serial leaves the phone, never the ICCID itself.
    slots.push(s ? { slot: n, state: 'READY', fp: await sha256hex(`${device.simSalt}:${s.iccid}`), carrier: s.mccMnc } : { slot: n, state: 'ABSENT' });
  }
  return b64u(utf8(JSON.stringify({ airplane: phone.airplane, slots })));
}

/** Signed API call (LLD §3.2). opts.profileId adds the owning profile's signature. */
async function call(method, path, body, opts = {}) {
  const raw = body ? JSON.stringify(body) : '';
  const ts = String(Date.now());
  const nonce = b64u(crypto.getRandomValues(new Uint8Array(18)));
  const sim = await simHeader();
  const data = [method, path, ts, nonce, await sha256hex(raw), await sha256hex(sim)].join('\n');
  const headers = { 'content-type': 'application/json', 'x-install-id': device.installationId, 'x-timestamp': ts, 'x-nonce': nonce, 'x-sim-state': sim, 'x-signature': await sign(device.keys, data), ...(opts.headers || {}) };
  if (opts.profileId) headers['x-profile-signature'] = await sign(device.profileKeys[opts.profileId], data);
  const res = await fetch(path, { method, headers, body: raw || undefined });
  const out = res.status === 204 ? {} : await res.json();
  if (out.simCheck?.length) announceSimCheck(out.simCheck);
  return { ok: res.ok, status: res.status, body: out };
}

function announceSimCheck(list) {
  const text = { SUSPEND: 'paused', DEREGISTER: 'removed', REACTIVATE: 'active again' };
  const why = { SIM_ABSENT: 'SIM not detected', SIM_CHANGED: 'a different SIM was inserted', AIRPLANE_MODE: 'airplane mode', SIM_PRESENT: 'SIM detected', SUSPENDED_TOO_LONG: 'SIM missing for over 7 days' };
  toast(list.map((x) => `SIM ${x.slot} profile ${text[x.action]} (${why[x.reason] || x.reason})`).join(' · '), list.some((x) => x.action !== 'REACTIVATE') ? 'warn' : 'ok');
}

// ---------------------------------------------------------------- app state & rendering
const state = { tab: 'home', profiles: [], banks: [], txns: [], toast: null, pay: { step: 'form' }, link: {}, bind: {} };
let toastTimer;
function toast(text, kind = 'info') {
  state.toast = { text, kind };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { state.toast = null; render(); }, 6000);
  render();
}

async function refresh() {
  if (!device) return render();
  const [p, b, t] = await Promise.all([call('GET', '/v1/profiles'), call('GET', '/v1/banks'), call('GET', '/v1/payments?limit=30')]);
  if (p.status === 401 && /Unknown installation/.test(p.body.error?.message)) { // server data was reset: start onboarding again
    device = null; await idb.clear(); return render();
  }
  state.profiles = p.body.profiles || [];
  state.banks = b.body.banks || [];
  state.txns = t.body.transactions || [];
  render();
}

const TABS = [['home', 'Accounts'], ['pay', 'Pay'], ['history', 'History'], ['sims', 'SIMs']];
function render() {
  $('tabs').replaceChildren(...(device ? TABS.map(([id, label]) => h('button', { class: state.tab === id ? 'on' : '', onclick: () => { state.tab = id; if (id === 'pay') state.pay = { step: 'form' }; render(); } }, label)) : []));
  const screen = !device ? consentScreen() : { home: homeScreen, pay: payScreen, history: historyScreen, sims: simsScreen }[state.tab]();
  $('app').replaceChildren(state.toast ? h('div', { class: `notice ${state.toast.kind}` }, state.toast.text) : '', screen);
  renderStatusbar();
}

const stateChip = (p) => {
  if (p.state === 'ACTIVE') return p.coolingOffUntil ? h('span', { class: 'chip warn' }, 'Active · new SIM cap') : h('span', { class: 'chip ok' }, 'Active');
  if (p.state === 'SUSPENDED') return h('span', { class: 'chip bad' }, p.stateReason === 'AIRPLANE_MODE' ? 'Paused · airplane' : 'Paused · SIM missing');
  return h('span', { class: 'chip' }, p.state === 'BOUND' ? 'Verified · link accounts' : p.state);
};
const bankInitial = (name) => (name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2);

// --- consent / onboarding
function consentScreen() {
  return h('div', { class: 'consent' },
    h('div', { class: 'screen-title' }, 'Welcome to DuoPay'),
    h('p', {}, 'Use every SIM in your phone for UPI. Each SIM number gets its own verified profile and its own bank accounts.'),
    h('div', { class: 'card' },
      h('strong', {}, 'To verify your numbers, DuoPay will:'),
      h('ul', {},
        h('li', {}, 'read which SIM slots are active and their operator'),
        h('li', {}, 'keep a scrambled fingerprint of each SIM (never the SIM serial)'),
        h('li', {}, 'send a one-time SMS from each SIM you choose to verify'),
        h('li', {}, 'stop a SIM\'s payments the moment it is removed'))),
    h('p', { class: 'sub' }, 'Purpose: UPI device binding and fraud prevention (DPDP Act 2023). You can withdraw consent by removing your profiles.'),
    h('button', { class: 'btn', onclick: register }, 'Agree and continue'));
}

async function register() {
  const keys = await genKey();
  const r = await fetch('/v1/installations', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicKeyJwk: await pubJwk(keys), deviceModel: 'Browser phone', integrityToken: 'demo-attestation', consentSimRead: true }) });
  const out = await r.json();
  if (!r.ok) return toast(out.error.message, 'bad');
  device = { installationId: out.installationId, simSalt: out.simSalt, keys, profileKeys: {} };
  await idb.set('device', device);
  state.tab = 'sims';
  await refresh();
}

// --- accounts (home)
function homeScreen() {
  const n = state.profiles.reduce((s, p) => s + p.accounts.length, 0);
  return h('div', {},
    h('div', { class: 'screen-title' }, 'Your accounts'),
    h('div', { class: 'sub' }, `${n} account${n === 1 ? '' : 's'} across ${state.profiles.length} SIM profile${state.profiles.length === 1 ? '' : 's'}`),
    state.profiles.length ? null : h('div', { class: 'notice info' }, 'No SIM verified yet. ', h('button', { class: 'btn secondary', onclick: () => { state.tab = 'sims'; render(); } }, 'Verify your SIMs')),
    state.profiles.map((p) => h('div', { class: `card s${p.slot} ${p.state === 'ACTIVE' ? '' : 'dim'}` },
      h('div', { class: 'row' }, h('span', { class: `chip s${p.slot}` }, `SIM ${p.slot} · ${p.msisdnMasked}`), stateChip(p)),
      h('div', { class: 'sub mono' }, p.vpa),
      p.coolingOffUntil ? h('div', { class: 'sub' }, `New SIM safety cap: up to ₹5,000 until ${new Date(p.coolingOffUntil).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`) : null,
      p.state === 'SUSPENDED' ? h('div', { class: 'why' }, 'Payments from these accounts are paused until this SIM is back.') : null,
      p.accounts.length ? p.accounts.map((a) => h('div', { class: 'acct' },
        h('div', { class: 'acct-main' }, h('div', { class: 'bankdot' }, bankInitial(a.bankName)), h('div', {}, h('div', {}, a.bankName), h('div', { class: 'sub mono' }, `${a.maskedNumber} · ${a.type.toLowerCase()}`))))) : h('div', { class: 'sub' }, 'No accounts linked yet'))));
}

// --- SIMs: binding + account linking
function simsScreen() {
  return h('div', {},
    h('div', { class: 'screen-title' }, 'SIMs & numbers'),
    h('div', { class: 'sub' }, 'One UPI profile per SIM number. SIMs can belong to different people; each must be active in this phone.'),
    [1, 2].map((slot) => {
      const sim = simByIccid(phone.slots[slot]);
      const p = state.profiles.find((x) => x.slot === slot);
      const b = state.bind[slot];
      return h('div', { class: `card s${slot}` },
        h('div', { class: 'row' }, h('span', { class: `chip s${slot}` }, `Slot ${slot}`), p ? stateChip(p) : h('span', { class: 'sub' }, sim ? sim.operator : 'Empty')),
        p ? h('div', {}, h('div', {}, `${p.msisdnMasked}`), h('div', { class: 'sub mono' }, p.vpa)) : null,
        p && p.accounts.length ? h('div', { class: 'linked-list' }, p.accounts.map((a) => h('div', { class: 'acct' },
          h('div', { class: 'acct-main' }, h('div', { class: 'bankdot' }, bankInitial(a.bankName)), h('div', {}, h('div', {}, a.bankName), h('div', { class: 'sub mono' }, a.maskedNumber)))))) : null,
        !p && sim && !phone.airplane ? h('button', { class: 'btn', disabled: b?.busy, onclick: () => bindSlot(slot) }, `Verify SIM ${slot} number`) : null,
        !p && !sim ? h('div', { class: 'sub' }, 'Insert a SIM (left panel) to add a profile.') : null,
        !p && sim && phone.airplane ? h('div', { class: 'why' }, 'Turn off airplane mode to verify.') : null,
        b?.steps ? h('ol', { class: 'steps' }, b.steps.map((s) => h('li', { class: s.cls }, s.text))) : null,
        p && ['BOUND', 'ACTIVE'].includes(p.state) ? linkBlock(p) : null,
        p ? h('button', { class: 'ghost small', onclick: () => removeProfile(p) }, 'Remove this profile') : null);
    }));
}

function linkBlock(p) {
  const l = state.link[p.id] || (state.link[p.id] = { open: p.accounts.length === 0, picked: new Set(), log: [], busy: false });
  // Results stay visible after a search, so the user always sees what happened.
  const results = l.log.length ? h('div', { class: 'link-results' }, l.log.map((x) => h('div', { class: `notice ${x.kind}` }, x.text))) : null;
  if (!l.open) {
    return h('div', {}, results,
      h('button', { class: 'btn secondary', onclick: () => { l.open = true; l.log = []; render(); } }, p.accounts.length ? 'Link more bank accounts' : 'Link bank accounts'));
  }
  const linked = new Set(p.accounts.map((a) => a.bank));
  return h('div', { class: 'banks-pick' },
    h('div', { class: 'sub' }, `Find accounts registered with ${p.msisdnMasked} at:`),
    state.banks.map((b) => h('label', {},
      h('input', { type: 'checkbox', checked: l.picked.has(b.code), disabled: l.busy, onchange: (e) => { e.target.checked ? l.picked.add(b.code) : l.picked.delete(b.code); l.error = null; } }),
      h('span', {}, b.name),
      linked.has(b.code) ? h('span', { class: 'chip ok' }, 'linked') : null,
      b.status === 'DOWN' ? h('span', { class: 'chip bad' }, 'down') : null)),
    l.error ? h('div', { class: 'notice bad' }, l.error) : null,
    h('button', { class: 'btn', disabled: l.busy, onclick: () => linkAccounts(p) }, l.busy ? 'Searching…' : 'Search and link'),
    p.accounts.length ? h('button', { class: 'ghost small', onclick: () => { l.open = false; render(); } }, 'Done') : null,
    results);
}

async function bindSlot(slot) {
  const sim = simByIccid(phone.slots[slot]);
  const steps = [{ text: 'Creating a signing key for this SIM in the phone keystore', cls: 'now' }];
  state.bind[slot] = { busy: true, steps };
  render();
  const pk = await genKey();
  const r = await call('POST', '/v1/bindings', { slot, profilePublicKeyJwk: await pubJwk(pk) });
  if (!r.ok) { state.bind[slot] = { steps: [{ text: r.body.error.message, cls: '' }] }; return render(); }
  steps[0].cls = 'done';
  steps.push({ text: `Sending a one-time code by SMS from SIM ${slot} (${sim.operator}) to ${r.body.vmn}`, cls: 'now' });
  render();
  // Android: SmsManager.getSmsManagerForSubscriptionId(subId).sendTextMessage(vmn, null, token, …)
  await fetch('/sim/telecom/sms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ iccid: sim.iccid, to: r.body.vmn, text: r.body.token }) });
  let s;
  for (let i = 0; i < 10; i++) {
    await new Promise((res) => setTimeout(res, 400));
    s = await call('GET', `/v1/bindings/${r.body.bindingId}`);
    if (s.body.status !== 'PENDING') break;
  }
  steps[1].cls = 'done';
  if (s.body.status === 'VERIFIED') {
    device.profileKeys[s.body.profile.id] = pk;
    await idb.set('device', device);
    steps.push({ text: `Verified ${s.body.profile.msisdnMasked} · UPI ID ${s.body.profile.vpa}`, cls: 'done' });
  } else {
    steps.push({ text: `Verification failed: ${s.body.failReason || s.body.status}`, cls: '' });
  }
  state.bind[slot] = { busy: false, steps };
  await refresh();
}

async function linkAccounts(p) {
  const l = state.link[p.id];
  if (!l.picked.size) { l.error = 'Tick at least one bank first.'; return render(); }
  l.log = [];
  l.error = null;
  l.busy = true;
  render();
  let anyLinked = false;
  for (const code of l.picked) {
    const bank = state.banks.find((b) => b.code === code);
    const r = await call('POST', `/v1/profiles/${p.id}/accounts/discover`, { bankCode: code });
    if (!r.ok) {
      l.log.push({ kind: 'bad', text: `${bank.name}: ${r.body.error.message}` });
    } else {
      const found = r.body.accounts.filter((a) => a.bank === code);
      anyLinked ||= found.length > 0;
      l.log.push(found.length
        ? { kind: 'ok', text: `${bank.name}: linked ${found.map((a) => a.maskedNumber).join(', ')}` }
        : { kind: '', text: `${bank.name}: no account registered with ${p.msisdnMasked}` });
    }
    render();
  }
  l.busy = false;
  l.picked = new Set();
  l.open = !anyLinked; // keep the picker open if nothing was found, so the user can try another bank
  await refresh();
  renderOps();
}

async function removeProfile(p) {
  const r = await call('DELETE', `/v1/profiles/${p.id}`, null, { profileId: p.id });
  if (!r.ok) return toast(r.body.error.message, 'bad');
  delete device.profileKeys[p.id];
  await idb.set('device', device);
  state.bind = {};
  toast(`Removed SIM ${p.slot} profile`, 'info');
  await refresh();
}

// --- pay
const WHY = { SIM_ABSENT: 'SIM missing from phone', AIRPLANE_MODE: 'Airplane mode is on', BANK_DOWN: 'Bank not responding', DAILY_LIMIT: 'Daily limit reached', COOLING_OFF: 'New SIM: ₹5,000 cap for 24h', PROFILE_NOT_ACTIVE: 'SIM not verified' };

function payScreen() {
  const s = state.pay;
  if (s.step === 'form') {
    return h('div', {},
      h('div', { class: 'screen-title' }, 'Pay'),
      h('label', { class: 'field' }, h('span', {}, 'UPI ID'),
        h('input', { id: 'vpa', list: 'payees', value: s.vpa || '', placeholder: 'name@bank', autocomplete: 'off' })),
      h('datalist', { id: 'payees' }, world.payees.map((p) => h('option', { value: p.vpa }, p.name))),
      h('label', { class: 'field amount' }, h('span', {}, 'Amount (₹)'),
        h('input', { id: 'amt', inputmode: 'decimal', value: s.amount || '', placeholder: '0' })),
      s.error ? h('div', { class: 'notice bad' }, s.error) : null,
      h('button', { class: 'btn', onclick: findAccounts }, 'Choose account'));
  }
  if (s.step === 'choose') {
    const sg = s.suggestion;
    return h('div', {},
      h('div', { class: 'screen-title' }, rupees(s.amountPaise)),
      h('div', { class: 'card' }, h('div', {}, `To ${sg.payee.name}`), h('div', { class: 'sub mono' }, `✓ verified · ${sg.payee.vpa}`)),
      sg.eligible.length ? h('div', { class: 'reason' }, `★ ${sg.reason}`) : h('div', { class: 'notice bad' }, 'No account can make this payment right now.'),
      sg.eligible.length ? h('div', { class: 'ai' }, sg.source.startsWith('claude') ? 'Suggested by Claude, from your usage patterns (no balances or personal data shared)' : `Suggested by rules${sg.source.includes('(') ? ` ${sg.source.slice(sg.source.indexOf('('))}` : ''}`) : null,
      sg.eligible.map((a, i) => h('button', { class: `choice ${s.selected === a.accountId ? 'sel' : ''}`, onclick: () => { s.selected = a.accountId; render(); } },
        h('div', { class: 'row' }, h('span', {}, h('strong', {}, a.bankName), ` ${a.maskedNumber}`), i === 0 ? h('span', { class: 'chip' }, 'Suggested') : null),
        h('div', { class: 'row' }, h('span', { class: `chip s${a.slot}` }, `SIM ${a.slot} · ${a.msisdnMasked}`),
          h('span', { class: 'sub' }, a.headroom.coolingLeftPaise !== null ? `${rupees(a.headroom.coolingLeftPaise)} left (new SIM)` : `${rupees(a.headroom.amountLeftPaise)} left today`)))),
      sg.ineligible.length ? h('div', { class: 'sub' }, 'Not available now') : null,
      sg.ineligible.map((a) => h('button', { class: 'choice', disabled: true },
        h('div', { class: 'row' }, h('span', {}, h('strong', {}, a.bankName), ` ${a.maskedNumber}`), h('span', { class: `chip s${a.slot}` }, `SIM ${a.slot}`)),
        h('div', { class: 'why' }, WHY[a.reason] || a.reason))),
      s.confirm ? h('div', { class: 'notice' }, s.confirm) : null,
      s.error ? h('div', { class: 'notice bad' }, s.error) : null,
      sg.eligible.length ? h('button', { class: 'btn', disabled: !s.selected || s.busy, onclick: () => payNow(Boolean(s.confirm)) }, s.confirm ? 'Confirm and pay' : `Pay ${rupees(s.amountPaise)}`) : null,
      h('button', { class: 'btn secondary', onclick: () => { state.pay = { step: 'form', vpa: s.vpa, amount: s.amount }; render(); } }, 'Back'));
  }
  return resultView(s.txn, () => { state.pay = { step: 'form' }; render(); });
}

function resultView(t, onDone) {
  const kind = t.status === 'SUCCESS' ? 'ok' : t.status === 'FAILURE' ? 'bad' : 'warn';
  const label = { SUCCESS: 'Paid', FAILURE: 'Payment failed', PENDING: 'Payment pending', DEEMED_PENDING: 'Awaiting bank confirmation' }[t.status];
  return h('div', { class: 'result' },
    h('div', { class: `icon ${kind}` }, kind === 'ok' ? '✓' : kind === 'bad' ? '!' : '…'),
    h('div', { class: 'big' }, rupees(t.amountPaise)),
    h('div', {}, label),
    h('div', { class: 'sub' }, `To ${t.payeeName} · from ${t.bankName} ${t.maskedNumber} (SIM ${t.fromSlot})`),
    t.rrn ? h('div', { class: 'sub mono' }, `UPI ref ${t.rrn}`) : null,
    t.failureCode ? h('div', { class: 'why' }, t.failureCode.replace(/_/g, ' ').toLowerCase()) : null,
    t.status === 'PENDING' ? h('div', { class: 'notice' }, 'The bank has not confirmed yet. We will not retry the payment (that could debit you twice). Check status from History.') : null,
    h('button', { class: 'btn', onclick: onDone }, 'Done'));
}

async function findAccounts() {
  const vpa = $('vpa').value.trim();
  const amount = Number($('amt').value);
  state.pay = { step: 'form', vpa, amount: $('amt').value };
  if (!vpa || !(amount >= 1)) { state.pay.error = 'Enter a UPI ID and an amount of at least ₹1'; return render(); }
  const amountPaise = Math.round(amount * 100);
  const r = await call('POST', '/v1/payments/suggest', { payeeVpa: vpa, amountPaise });
  if (!r.ok) { state.pay.error = r.body.error.message; return render(); }
  state.pay = { step: 'choose', vpa, amount: $('amt').value, amountPaise, suggestion: r.body, selected: r.body.eligible[0]?.accountId, idem: crypto.randomUUID() };
  render();
}

async function payNow(confirmed) {
  const s = state.pay;
  const a = s.suggestion.eligible.find((x) => x.accountId === s.selected);
  if (!s.cred || s.credFor !== a.accountId) {
    s.cred = await capturePin({ root: $('cl-root'), bankCode: a.bank, bankName: a.bankName, maskedNumber: a.maskedNumber, amountPaise: s.amountPaise, payeeVpa: s.suggestion.payee.vpa, payeeName: s.suggestion.payee.name });
    s.credFor = a.accountId;
    if (!s.cred) return;
  }
  s.busy = true; s.error = null; render();
  const rank = s.suggestion.eligible.findIndex((x) => x.accountId === a.accountId) + 1;
  const r = await call('POST', '/v1/payments', { accountId: a.accountId, payeeVpa: s.suggestion.payee.vpa, amountPaise: s.amountPaise, credBlock: s.cred, suggestedRank: rank, ...(confirmed ? { confirm: true } : {}) },
    { profileId: a.profileId, headers: { 'idempotency-key': s.idem } });
  s.busy = false;
  if (r.status === 428) { s.confirm = `${r.body.error.message}. Please confirm you want to continue.`; return render(); }
  if (!r.ok) { s.error = r.body.error.message; s.cred = null; return render(); }
  state.pay = { step: 'result', txn: r.body.transaction };
  await refresh();
}

// --- history
function historyScreen() {
  return h('div', {},
    h('div', { class: 'screen-title' }, 'History'),
    state.txns.length ? null : h('div', { class: 'sub' }, 'No payments yet.'),
    state.txns.map((t) => h('div', { class: `card s${t.fromSlot}` },
      h('div', { class: 'row' }, h('strong', {}, t.payeeName), h('strong', {}, rupees(t.amountPaise))),
      h('div', { class: 'row' }, h('span', { class: 'sub' }, `${t.bankName} ${t.maskedNumber} · SIM ${t.fromSlot}`),
        h('span', { class: `chip ${t.status === 'SUCCESS' ? 'ok' : t.status === 'FAILURE' ? 'bad' : 'warn'}` }, t.status.replace('_', ' ').toLowerCase())),
      h('div', { class: 'sub' }, new Date(t.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }), t.failureCode ? ` · ${t.failureCode.replace(/_/g, ' ').toLowerCase()}` : ''),
      t.status === 'PENDING' ? h('button', { class: 'btn secondary', onclick: () => checkStatus(t.id) }, 'Check status') : null)));
}

async function checkStatus(id) {
  const r = await call('POST', `/v1/payments/${id}/check-status`);
  if (!r.ok) return toast(r.body.error.code === 'STATUS_CHECK_TOO_SOON' ? `NPCI pacing: try again after ${new Date(r.body.error.nextAllowedAt).toLocaleTimeString('en-IN')}` : r.body.error.message, 'warn');
  toast(`Status: ${r.body.transaction.status.replace('_', ' ').toLowerCase()} (check ${r.body.checksUsed} of 3)`, r.body.transaction.status === 'SUCCESS' ? 'ok' : 'warn');
  await refresh();
}

// ---------------------------------------------------------------- ops console
async function renderOps() {
  try {
    const [w, prof, aud] = await Promise.all(['/sim/world', '/ops/profiles', '/ops/audit'].map((u) => fetch(u).then((r) => r.json())));
    world = { ...world, banks: w.banks };
    $('banks').replaceChildren(...w.banks.map((b) => h('div', { class: 'bankrow' },
      h('span', {}, b.name, h('span', { class: 'hint' }, ` · limit ${rupees(b.dailyLimitPaise)}/day`)),
      h('span', { class: 'seg' }, ['UP', 'DOWN', 'TIMEOUT'].map((m) => h('button', { class: `${m} ${b.mode === m ? 'on' : ''}`, onclick: async () => {
        await fetch(`/sim/banks/${b.code}/mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: m }) });
        renderOps(); refresh();
      } }, m))))));
    $('opsProfiles').replaceChildren(prof.profiles.length ? h('table', {},
      h('tr', {}, h('th', {}, 'Slot'), h('th', {}, 'Number'), h('th', {}, 'State'), h('th', {}, 'Reason')),
      prof.profiles.slice(0, 8).map((p) => h('tr', {}, h('td', {}, String(p.slot)), h('td', { class: 'mono' }, p.msisdnMasked), h('td', {}, p.state), h('td', { class: 'sub' }, p.stateReason || '')))) : h('div', { class: 'sub' }, 'None yet'));
    $('chain').className = `chip ${aud.chain.ok ? 'ok' : 'bad'}`;
    $('chain').textContent = aud.chain.ok ? `hash chain OK · ${aud.chain.length} events` : `TAMPERED at #${aud.chain.brokenAt}`;
    $('audit').replaceChildren(...aud.entries.slice(0, 25).map((e) => h('li', {},
      h('span', { class: 'sub' }, new Date(e.at).toLocaleTimeString('en-IN', { hour12: false })),
      h('span', {}, h('div', { class: 'ev' }, e.event), h('div', { class: 'd' }, e.data === '{}' ? '' : e.data)))));
  } catch { /* server restarting */ }
}

function renderCheat() {
  $('cheat').replaceChildren(
    h('p', { class: 'sub' }, 'Which number has which accounts, and the demo UPI PINs. All fictional.'),
    h('table', {}, h('tr', {}, h('th', {}, 'SIM'), h('th', {}, 'Number'), h('th', {}, 'Accounts (PIN)')),
      world.sims.map((s) => h('tr', {}, h('td', {}, s.label), h('td', { class: 'mono' }, s.msisdn),
        h('td', {}, world.accounts.filter((a) => a.msisdn === s.msisdn).map((a) => `${a.bank} ${a.masked} (${a.demoPin})`).join(', ') || '—')))),
    h('p', { class: 'sub' }, 'Payees: ', world.payees.map((p) => p.vpa).join(', ')));
}

// ---------------------------------------------------------------- boot
async function boot() {
  world = await fetch('/sim/world').then((r) => r.json());
  if (!localStorage.getItem('duopay-phone')) { phone.slots = { 1: world.sims[0].iccid, 2: world.sims[1].iccid }; savePhone(); }
  $('airplane').addEventListener('change', (e) => { phone.airplane = e.target.checked; onHardwareChange(); });
  $('resetDevice').addEventListener('click', async () => { await idb.clear(); localStorage.removeItem('duopay-phone'); location.reload(); });
  renderTray();
  renderCheat();
  device = (await idb.get('device')) || null;
  if (device) await call('POST', '/v1/sim-state').catch(() => {});
  await refresh();
  renderOps();
  setInterval(renderOps, 2000);
  setInterval(renderStatusbar, 30_000);
}
boot();
