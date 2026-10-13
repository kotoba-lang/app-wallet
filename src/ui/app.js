// Kotoba Wallet UI. Plain DOM, no framework: the bundle is what kotoba-shell
// embeds as :web/dist-dir and serves to WKWebView / android.webkit.WebView.
//
// Secret handling: the mnemonic exists in memory only inside `withSecret`
// (unlock, reveal, sign) and is dropped when it returns. While unlocked the
// app holds PUBLIC accounts only — the same split as wallet.chain/account-with.
import qrcode from 'qrcode-generator';
import * as d from '../core/derive.js';
import * as evm from '../core/evm.js';
import * as ks from '../core/keystore.js';
import * as net from '../core/networks.js';
import * as utxo from '../core/utxo.js';
import * as store from './store.js';
import { t } from './i18n.js';

const IDLE_LOCK_MS = 5 * 60 * 1000;

const state = {
  vault: null, accounts: null, prefs: store.loadPrefs(),
  balances: {}, prices: {}, errors: {}, draft: null,
};

// ── tiny DOM helper (text only — no user data ever goes through innerHTML) ──
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const root = () => document.getElementById('app');
// Which screen is up, so a background refresh repaints home and nothing else.
let current = null;
function show(...nodes) { current = null; root().replaceChildren(...nodes); window.scrollTo(0, 0); }
const header = (title, onBack) =>
  h('header', { class: 'bar' }, onBack ? h('button', { class: 'ghost', onclick: onBack, 'aria-label': t.back }, '‹') : h('span'),
    h('h1', {}, title), h('span'));
// Mnemonic and address fields: Latin keyboard, no autocorrect. inputmode=email
// is what makes iOS drop the kana IME; NFKC in normalizeMnemonic folds any
// full-width letters that still get through.
const latin = { inputmode: 'email', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', lang: 'en' };
const err = (msg) => h('p', { class: 'error', role: 'alert' }, msg);
const busy = (btn, on) => { btn.disabled = on; btn.dataset.label ??= btn.textContent; btn.textContent = on ? t.working : btn.dataset.label; };

// ── secrets ────────────────────────────────────────────────────────────────
async function withSecret(passcode, f) {
  const secret = await ks.open(state.vault, passcode);
  return f(secret.mnemonic);
}
function deriveAccounts(mnemonic) {
  const r = d.rootFromMnemonic(mnemonic);
  return d.implemented().map((c) => d.account(r, c));
}

// ── onboarding ─────────────────────────────────────────────────────────────
function welcome() {
  show(h('main', { class: 'center' },
    h('div', { class: 'logo' }, '言'),
    h('h1', { class: 'title' }, 'Kotoba Wallet'),
    h('p', { class: 'muted' }, t.tagline),
    h('button', { class: 'primary', onclick: () => createPhrase(d.newMnemonic()) }, t.create),
    h('button', { class: 'secondary', onclick: importPhrase }, t.import)));
}

function createPhrase(mnemonic) {
  const words = mnemonic.split(' ');
  const ok = h('input', { type: 'checkbox', id: 'ack' });
  const next = h('button', { class: 'primary', disabled: true, onclick: () => verifyPhrase(mnemonic) }, t.next);
  ok.addEventListener('change', () => { next.disabled = !ok.checked; });
  show(header(t.phraseTitle, welcome), h('main', {},
    h('p', { class: 'warn' }, t.phraseWarn),
    h('ol', { class: 'words' }, words.map((w) => h('li', {}, w))),
    h('label', { class: 'check' }, ok, t.phraseWritten), next));
}

function verifyPhrase(mnemonic) {
  const words = mnemonic.split(' ');
  const picks = [...crypto.getRandomValues(new Uint32Array(8))].map((x) => x % words.length)
    .filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).sort((a, b) => a - b);
  const inputs = picks.map(() => h('input', latin));
  const msg = h('div');
  show(header(t.verifyTitle, () => createPhrase(mnemonic)), h('main', {},
    picks.map((p, i) => h('label', { class: 'field' }, t.verifyWord(p + 1), inputs[i])), msg,
    h('button', { class: 'primary', onclick: () => {
      const good = picks.every((p, i) => d.normalizeMnemonic(inputs[i].value) === words[p]);
      if (good) setPasscode(mnemonic); else msg.replaceChildren(err(t.verifyFail));
    } }, t.next)));
}

function importPhrase() {
  const ta = h('textarea', { rows: 4, ...latin, placeholder: t.importHint });
  const msg = h('div');
  show(header(t.importTitle, welcome), h('main', {}, ta, msg,
    h('button', { class: 'primary', onclick: () => {
      if (!d.isValidMnemonic(ta.value)) return msg.replaceChildren(err(t.importBad));
      setPasscode(d.normalizeMnemonic(ta.value));
    } }, t.next)));
}

function setPasscode(mnemonic) {
  const p1 = h('input', { type: 'password', autocomplete: 'new-password' });
  const p2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const msg = h('div');
  const btn = h('button', { class: 'primary', onclick: async () => {
    if (p1.value.length < 6) return msg.replaceChildren(err(t.passShort));
    if (p1.value !== p2.value) return msg.replaceChildren(err(t.passMismatch));
    busy(btn, true);
    try {
      state.vault = await ks.seal({ mnemonic }, p1.value);
      await store.saveVault(state.vault);
      state.accounts = deriveAccounts(mnemonic);
      home(); refresh();
    } catch (e) { msg.replaceChildren(err(e.message)); busy(btn, false); }
  } }, t.next);
  show(header(t.passTitle, welcome), h('main', {}, h('p', { class: 'muted' }, t.passHint),
    h('label', { class: 'field' }, t.pass, p1), h('label', { class: 'field' }, t.pass2, p2), msg, btn));
}

function unlock() {
  state.accounts = null;
  const p = h('input', { type: 'password', autocomplete: 'current-password' });
  const msg = h('div');
  const btn = h('button', { class: 'primary', type: 'submit' }, t.unlock);
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); busy(btn, true);
    try { state.accounts = await withSecret(p.value, deriveAccounts); home(); refresh(); }
    catch (x) { msg.replaceChildren(err(x instanceof ks.WrongPasscode ? t.wrongPass : x.message)); busy(btn, false); }
  } }, h('label', { class: 'field' }, t.pass, p), msg, btn);
  show(h('main', { class: 'center' }, h('div', { class: 'logo' }, '言'), h('h1', { class: 'title' }, t.unlockTitle), form));
  p.focus();
}

// ── home ───────────────────────────────────────────────────────────────────
const fmtFiat = (v) => new Intl.NumberFormat(undefined, { style: 'currency', currency: state.prefs.fiat.toUpperCase(),
  maximumFractionDigits: ['jpy', 'krw'].includes(state.prefs.fiat) ? 0 : 2 }).format(v);

function fiatOf(chain) {
  const bal = state.balances[chain];
  const px = state.prices[d.chains[chain].symbol];
  if (bal == null || px == null) return null;
  return Number(evm.formatUnits(bal, net.decimalsOf(chain), 8)) * px;
}

function home() {
  if (!state.accounts) return unlock();
  const total = state.accounts.reduce((s, a) => s + (fiatOf(a.chain) ?? 0), 0);
  const rows = state.accounts.map((a) => {
    const e = d.chains[a.chain];
    const bal = state.balances[a.chain];
    const fv = fiatOf(a.chain);
    return h('li', {}, h('button', { class: 'row', onclick: () => asset(a) },
      h('span', { class: 'sym' }, e.symbol.slice(0, 4)),
      h('span', { class: 'grow' }, h('b', {}, e.name), h('small', {}, e['receive-only?'] ? `${e.symbol} · ${t.receiveOnly}` : e.symbol)),
      h('span', { class: 'amt' },
        h('b', {}, state.errors[a.chain] ? t.fetchFail : bal == null ? t.notFetched : evm.formatUnits(bal, net.decimalsOf(a.chain))),
        h('small', {}, fv == null ? '' : fmtFiat(fv)))));
  });
  const soon = Object.entries(d.chains).filter(([, e]) => e.status).sort(([a], [b]) => a.localeCompare(b))
    .map(([, e]) => h('li', { class: 'soon' }, h('b', {}, `${e.symbol} · ${e.name}`),
      h('small', {}, e.status === 'external' ? t.external(e.owner) : e.needs)));
  show(h('header', { class: 'bar' }, h('span'), h('h1', {}, 'Kotoba Wallet'),
      h('button', { class: 'ghost', onclick: settings, 'aria-label': t.settings }, '⚙')),
    h('main', {},
      h('section', { class: 'hero' }, h('small', {}, t.total), h('div', { class: 'total' }, fmtFiat(total)),
        h('button', { class: 'chip', onclick: refresh }, '↻ ' + t.refresh)),
      h('h2', {}, t.assets), h('ul', { class: 'list' }, rows),
      h('details', {}, h('summary', {}, `${t.comingSoon} (${soon.length})`), h('p', { class: 'muted' }, t.comingSoonHint),
        h('ul', { class: 'list' }, soon)),
      h('p', { class: 'muted tiny' }, t.priceSource)));
  current = home;
  poke();
}

let refreshing = null;
async function refresh() {
  if (refreshing) return refreshing;
  const accts = state.accounts;
  refreshing = Promise.allSettled([
    net.prices(state.prefs.fiat).then((p) => { state.prices = p; }),
    ...accts.map((a) => net.balance(a)
      .then((b) => { state.balances[a.chain] = b; delete state.errors[a.chain]; })
      .catch((e) => { state.errors[a.chain] = e.message; })),
  ]).finally(() => { refreshing = null; if (state.accounts && current === home) home(); });
  return refreshing;
}

// ── asset / receive ────────────────────────────────────────────────────────
function qrSvg(text) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const box = h('div', { class: 'qr' });
  box.innerHTML = q.createSvgTag({ cellSize: 5, margin: 2, scalable: true }); // generated markup, not user data
  return box;
}

function explorerUrl(chain, addr) {
  if (net.evm[chain]) return `${net.evm[chain].explorer}/address/${addr}`;
  return (net.utxo[chain] || net.tron[chain]).explorer + addr;
}

function asset(acct) {
  const e = d.chains[acct.chain];
  const addrs = d.addressesOf(acct);
  const primary = addrs[0];
  const toast = h('p', { class: 'toast', 'aria-live': 'polite' });
  const bal = state.balances[acct.chain];
  const canSend = e.family === 'evm' || (e.family === 'utxo' && !e['receive-only?']);
  const why = e.family === 'tron' ? t.tronWhy : t.bchWhy;
  show(header(e.name, home), h('main', {},
    h('section', { class: 'hero' }, h('small', {}, e.symbol),
      h('div', { class: 'total' }, bal == null ? t.notFetched : evm.formatUnits(bal, net.decimalsOf(acct.chain))),
      fiatOf(acct.chain) != null ? h('small', {}, fmtFiat(fiatOf(acct.chain))) : null),
    canSend ? h('button', { class: 'primary', onclick: () => (e.family === 'utxo' ? utxoSendForm(acct) : sendForm(acct)) }, t.send) : h('p', { class: 'muted' }, t.sendUnsupported(why)),
    h('h2', {}, t.receive), qrSvg(primary),
    h('h2', {}, t.addresses),
    h('ul', { class: 'list' }, addrs.map((a) => h('li', { class: 'addr' }, h('code', {}, a),
      h('button', { class: 'chip', onclick: async () => { toast.textContent = (await store.copyText(a)) ? t.copied : ''; } }, t.copy)))),
    h('p', { class: 'muted tiny' }, acct.path, e['chain-id'] ? ` · chain-id ${e['chain-id']}` : ''),
    h('a', { class: 'link', href: explorerUrl(acct.chain, primary), target: '_blank', rel: 'noopener' }, t.explorer), toast));
}

// ── send (EVM) ─────────────────────────────────────────────────────────────
function sendForm(acct, draft = {}) {
  const e = d.chains[acct.chain];
  const to = h('input', { value: draft.to ?? '', ...latin, placeholder: '0x…' });
  const amount = h('input', { value: draft.amount ?? '', inputmode: 'decimal', placeholder: '0.0' });
  const msg = h('div');
  const btn = h('button', { class: 'primary', onclick: async () => {
    if (!d.isEvmAddress(to.value.trim())) return msg.replaceChildren(err(t.badAddress));
    let value;
    try { value = evm.parseUnits(amount.value, 18); if (value <= 0n) throw 0; } catch { return msg.replaceChildren(err(t.badAmount)); }
    const bal = state.balances[acct.chain];
    if (bal != null && value > bal) return msg.replaceChildren(err(t.insufficient));
    busy(btn, true);
    try {
      const q = await net.quoteEvmTransfer(acct.chain, acct.address, to.value.trim(), value);
      review(acct, { to: to.value.trim(), amount: amount.value, value, ...q });
    } catch (x) {
      msg.replaceChildren(err(/insufficient funds|OutOfFunds/i.test(x.message) ? t.insufficient : x.message));
      busy(btn, false);
    }
  } }, t.review);
  show(header(`${t.send} ${e.symbol}`, () => asset(acct)), h('main', {},
    h('p', { class: 'muted' }, `${t.network}: ${e.name} (chain-id ${e['chain-id']})`),
    h('label', { class: 'field' }, t.to, to), h('label', { class: 'field' }, `${t.amount} (${e.symbol})`, amount), msg, btn));
}

function review(acct, tx) {
  const e = d.chains[acct.chain];
  const fmt = (v) => `${evm.formatUnits(v, 18, 8)} ${e.symbol}`;
  const bal = state.balances[acct.chain];
  const total = tx.value + tx.maxCost;
  const p = h('input', { type: 'password', autocomplete: 'current-password' });
  const msg = h('div');
  const short = bal != null && total > bal;
  const btn = h('button', { class: 'danger', disabled: short, onclick: async () => {
    busy(btn, true);
    try {
      const raw = await withSecret(p.value, (mnemonic) => {
        const r = d.rootFromMnemonic(mnemonic);
        const fresh = d.account(r, acct.chain);
        if (fresh.address !== acct.address) throw new Error('account mismatch');
        return evm.signTx(acct.chain, { nonce: tx.nonce, to: tx.to, value: tx.value, data: '0x', gas: tx.gas,
          maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, chainId: e['chain-id'] },
          d.nodeFor(r, fresh).privateKey);
      });
      const hash = await net.broadcastEvm(acct.chain, raw);
      sent(acct, hash);
    } catch (x) { msg.replaceChildren(err(x instanceof ks.WrongPasscode ? t.wrongPass : x.message)); busy(btn, false); }
  } }, t.signSend);
  const kv = (k, v) => h('div', { class: 'kv' }, h('span', {}, k), h('b', {}, v));
  show(header(t.reviewTitle, () => sendForm(acct, tx)), h('main', {},
    h('section', { class: 'card' },
      kv(t.network, `${e.name} · ${e['chain-id']}`), kv(t.to, tx.to), kv(t.amount, fmt(tx.value)),
      kv(t.maxFee, fmt(tx.maxCost)), kv(t.maxTotal, fmt(total))),
    short ? err(t.insufficient) : null,
    h('label', { class: 'field' }, t.confirmPass, p), msg, btn,
    h('button', { class: 'secondary', onclick: () => asset(acct) }, t.cancel)));
}

function sent(acct, hash) {
  show(header(t.sent), h('main', { class: 'center' },
    h('div', { class: 'logo ok' }, '✓'), h('p', {}, t.txHash), h('code', { class: 'wrap' }, hash),
    h('a', { class: 'link', href: net.txExplorerUrl(acct.chain, hash), target: '_blank', rel: 'noopener' }, t.explorer),
    h('button', { class: 'primary', onclick: () => { home(); refresh(); } }, t.done)));
}

// ── send (UTXO: BTC / LTC / DOGE) ──────────────────────────────────────────
// Coin selection and the fee are computed from public data only; the key is
// derived after the passcode on the review screen, and buildTransfer re-runs
// the same deterministic selection over the same UTXO set before signing.
function utxoSendForm(acct, draft = {}) {
  const e = d.chains[acct.chain];
  const dec = net.decimalsOf(acct.chain);
  const to = h('input', { value: draft.to ?? '', ...latin, placeholder: `${(acct.p2wpkh ?? acct.p2pkh).slice(0, 4)}…` });
  const amount = h('input', { value: draft.amount ?? '', inputmode: 'decimal', placeholder: '0.0' });
  const max = h('input', { type: 'checkbox', checked: !!draft.max });
  const tier = h('select', {}, ['fast', 'normal', 'slow'].map((k) => h('option', { value: k, selected: k === (draft.tier ?? 'normal') }, t.feeTier[k])));
  const msg = h('div');
  max.addEventListener('change', () => { amount.disabled = max.checked; });
  amount.disabled = max.checked;
  const btn = h('button', { class: 'primary', onclick: async () => {
    const dest = to.value.trim();
    try { utxo.addressToScript(acct.chain, dest); } catch (x) { return msg.replaceChildren(err(`${t.badUtxoAddress(d.chains[acct.chain].name)} (${x.message})`)); }
    let value = 0n;
    if (!max.checked) { try { value = evm.parseUnits(amount.value, dec); if (value <= 0n) throw 0; } catch { return msg.replaceChildren(err(t.badAmount)); } }
    busy(btn, true);
    try {
      const [utxos, rates] = await Promise.all([net.listUtxos(acct), net.feeRates(acct.chain)]);
      const n = utxo.netOf(acct.chain);
      let feeRate = rates[tier.value];
      if (n.minFeePerVb) feeRate = Math.max(feeRate, n.minFeePerVb);
      const dt = utxo.addressToScript(acct.chain, dest).type;
      const ct = utxo.addressToScript(acct.chain, acct.p2wpkh ?? acct.p2pkh).type;
      const sel = utxo.selectCoins({ utxos, amount: value, feeRate, toType: dt, changeType: ct, dust: n.dust, max: max.checked });
      utxoReview(acct, { to: dest, amount: amount.value, max: max.checked, tier: tier.value, feeRate, utxos, sel });
    } catch (x) {
      msg.replaceChildren(err(x.data?.reason === 'insufficient' ? t.insufficient : x.data?.reason === 'dust' ? t.dust : x.message));
      busy(btn, false);
    }
  } }, t.review);
  show(header(`${t.send} ${e.symbol}`, () => asset(acct)), h('main', {},
    h('p', { class: 'muted' }, `${t.network}: ${e.name}`),
    h('label', { class: 'field' }, t.to, to), h('label', { class: 'field' }, `${t.amount} (${e.symbol})`, amount),
    h('label', { class: 'check' }, max, t.sendMax),
    h('label', { class: 'field' }, t.feeSpeed, tier), msg, btn));
}

function utxoReview(acct, d0) {
  const e = d.chains[acct.chain];
  const dec = net.decimalsOf(acct.chain);
  const fmt = (v) => `${evm.formatUnits(v, dec, 8)} ${e.symbol}`;
  const { sel } = d0;
  const p = h('input', { type: 'password', autocomplete: 'current-password' });
  const msg = h('div');
  const btn = h('button', { class: 'danger', onclick: async () => {
    busy(btn, true);
    try {
      const built = await withSecret(p.value, (mnemonic) => {
        const r = d.rootFromMnemonic(mnemonic);
        const fresh = d.account(r, acct.chain);
        if (d.addressesOf(fresh).join() !== d.addressesOf(acct).join()) throw new Error('account mismatch');
        return utxo.buildTransfer({ chain: acct.chain, acct: fresh, utxos: d0.utxos, to: d0.to, amount: sel.amount,
          feeRate: d0.feeRate, max: d0.max, privateKey: d.nodeFor(r, fresh).privateKey });
      });
      if (built.fee !== sel.fee || built.amount !== sel.amount) throw new Error('transaction changed between review and signing');
      const txid = await net.broadcastUtxo(acct.chain, built.raw);
      sent(acct, txid || built.txid);
    } catch (x) { msg.replaceChildren(err(x instanceof ks.WrongPasscode ? t.wrongPass : x.message)); busy(btn, false); }
  } }, t.signSend);
  const kv = (k, v) => h('div', { class: 'kv' }, h('span', {}, k), h('b', {}, v));
  const unconfirmed = sel.inputs.filter((u) => !u.confirmed).length;
  show(header(t.reviewTitle, () => utxoSendForm(acct, d0)), h('main', {},
    h('section', { class: 'card' },
      kv(t.network, e.name), kv(t.to, d0.to), kv(t.amount, fmt(sel.amount)),
      kv(t.fee, `${fmt(sel.fee)} (${d0.feeRate} sat/vB · ~${sel.vsize} vB)`),
      sel.change > 0n ? kv(t.change, fmt(sel.change)) : null,
      kv(t.inputs, String(sel.inputs.length)), kv(t.maxTotal, fmt(sel.amount + sel.fee))),
    unconfirmed ? h('p', { class: 'warn' }, t.unconfirmedInputs(unconfirmed)) : null,
    h('p', { class: 'muted tiny' }, t.rbfNote),
    h('label', { class: 'field' }, t.confirmPass, p), msg, btn,
    h('button', { class: 'secondary', onclick: () => asset(acct) }, t.cancel)));
}

// ── settings ───────────────────────────────────────────────────────────────
function settings() {
  const sel = h('select', { onchange: () => { state.prefs.fiat = sel.value; store.savePrefs(state.prefs); state.prices = {}; refresh(); } },
    net.fiats.map((f) => h('option', { value: f, selected: f === state.prefs.fiat }, f.toUpperCase())));
  const p = h('input', { type: 'password', autocomplete: 'current-password' });
  const out = h('div');
  const reveal = h('button', { class: 'secondary', onclick: async () => {
    busy(reveal, true);
    try { const words = await withSecret(p.value, (m) => m.split(' '));
      out.replaceChildren(h('ol', { class: 'words' }, words.map((w) => h('li', {}, w)))); }
    catch (x) { out.replaceChildren(err(x instanceof ks.WrongPasscode ? t.wrongPass : x.message)); }
    busy(reveal, false);
  } }, t.showPhrase);
  const confirm = h('input', { autocapitalize: 'characters', placeholder: 'DELETE' });
  show(header(t.settings, home), h('main', {},
    h('label', { class: 'field' }, t.fiat, sel),
    h('h2', {}, t.showPhrase), h('label', { class: 'field' }, t.pass, p), reveal, out,
    h('button', { class: 'secondary', onclick: lock }, t.lock),
    h('details', {}, h('summary', {}, t.reset), h('p', { class: 'warn' }, t.resetConfirm), confirm,
      h('button', { class: 'danger', onclick: async () => {
        if (confirm.value !== 'DELETE') return;
        await store.deleteVault(); Object.assign(state, { vault: null, accounts: null, balances: {} }); welcome();
      } }, t.reset)),
    h('p', { class: 'muted tiny' }, t.storage(store.vaultBackend())),
    h('p', { class: 'muted tiny' }, 'Kotoba Wallet 0.2.0 · kotoba-lang/wallet · kotoba-shell')));
}

function lock() { state.accounts = null; state.balances = {}; unlock(); }

// ── lifecycle ──────────────────────────────────────────────────────────────
let idle;
function poke() { clearTimeout(idle); if (state.accounts) idle = setTimeout(lock, IDLE_LOCK_MS); }
['pointerdown', 'keydown'].forEach((ev) => addEventListener(ev, poke, { passive: true }));
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (hiddenAt && state.accounts && Date.now() - hiddenAt > 60_000) lock();
  hiddenAt = 0;
});

async function boot() {
  try { state.vault = await store.loadVault(); } catch { state.vault = null; }
  if (state.vault) unlock(); else welcome();
}
boot();
