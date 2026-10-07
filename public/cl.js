// NPCI Common Library simulator (LLD §5). The PIN lives only inside this module's closure:
// it is encrypted with the issuer bank's public key and never handed to DuoPay app code.

const fmt = (p) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(p / 100);
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function issuerKey(bankCode) {
  const r = await fetch(`/sim/npci/keys?bank=${encodeURIComponent(bankCode)}`); // ListKeys
  const { spki } = await r.json();
  return crypto.subtle.importKey('spki', unb64(spki), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
}

/** Shows the UPI PIN sheet. Resolves with an encrypted credential block, or null if cancelled. */
export function capturePin({ root, bankCode, bankName, maskedNumber, amountPaise, payeeVpa, payeeName, pinLength = 4 }) {
  return new Promise((resolve) => {
    let pin = '';
    const overlay = el('div', 'cl');
    const sheet = el('div', 'cl-sheet');
    const head = el('div', 'cl-head');
    head.append(el('span', null, `${bankName} ${maskedNumber}`), el('span', null, 'UPI · NPCI'));
    const dots = el('div', 'cl-dots');
    const paint = () => dots.replaceChildren(...Array.from({ length: pinLength }, (_, i) => el('i', i < pin.length ? 'f' : '')));
    paint();
    const pad = el('div', 'cl-pad');
    const close = (value) => { pin = ''; overlay.remove(); resolve(value); };
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'];
    for (const k of keys) {
      const b = el('button', k === '✓' ? 'go' : '', k);
      b.type = 'button';
      b.setAttribute('aria-label', k === '⌫' ? 'Delete' : k === '✓' ? 'Submit PIN' : k);
      b.addEventListener('click', async () => {
        if (k === '⌫') pin = pin.slice(0, -1);
        else if (k === '✓') {
          if (pin.length !== pinLength) return;
          const key = await issuerKey(bankCode);
          const nonce = b64(crypto.getRandomValues(new Uint8Array(12)));
          const payload = new TextEncoder().encode(JSON.stringify({ pin, amountPaise, payeeVpa, nonce, ts: Date.now() }));
          const block = b64(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, payload));
          return close(block);
        } else if (pin.length < pinLength) pin += k;
        paint();
      });
      pad.append(b);
    }
    const cancel = el('button', 'ghost small', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => close(null));
    sheet.append(head, el('div', 'cl-amt', fmt(amountPaise)), el('div', 'sub', `To ${payeeName} · ${payeeVpa}`),
      el('div', 'sub', 'Enter 4-digit UPI PIN'), dots, pad, el('div', 'cl-foot', 'Secured by the NPCI Common Library: DuoPay never sees your PIN'), cancel);
    overlay.append(sheet);
    root.append(overlay);
  });
}
