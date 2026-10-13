// Persistence. The vault (already passcode-encrypted) goes to the platform
// keychain through kotoba-shell's `keychain/*` provider when the native host
// is attached — iOS Keychain / Android Keystore-backed storage.
//
// Fallback: an UNSIGNED build (kotoba-shell `app build` for the simulator sets
// CODE_SIGNING_ALLOWED=NO) has no keychain entitlement, and SecItemAdd answers
// errSecMissingEntitlement (-34018). Then the vault goes to the WebView's
// app-sandboxed localStorage, and Settings says so — never silently. A plain
// browser preview always uses localStorage. Preferences are not secret and
// always use localStorage.
const VAULT = 'kotoba-wallet.vault.v1';
const PREFS = 'kotoba-wallet.prefs.v1';

const shell = () => (globalThis.kotobaShell?.available ? globalThis.kotobaShell : null);
const missingEntitlement = (r) => /-34018/.test(`${r.error} ${r.detail ?? ''}`);

let backend = shell() ? 'keychain' : 'localStorage';
let backendNote = shell() ? null : 'browser';
export const vaultBackend = () => ({ backend, note: backendNote });

export async function loadVault() {
  const s = shell();
  if (s) {
    const r = await s.invoke('keychain/read-text', { account: VAULT });
    if (r.ok && r.value) return JSON.parse(typeof r.value === 'string' ? r.value : r.value.text);
  }
  const raw = localStorage.getItem(VAULT);
  if (raw && s) { backend = 'localStorage'; backendNote = 'unsigned-build'; }
  return raw ? JSON.parse(raw) : null;
}

export async function saveVault(vault) {
  const s = shell();
  const text = JSON.stringify(vault);
  if (s) {
    const r = await s.invoke('keychain/write-text', { account: VAULT, text });
    if (r.ok) { backend = 'keychain'; backendNote = null; return; }
    if (!missingEntitlement(r)) throw new Error(`keychain write refused: ${r.error}${r.detail ? ' ' + r.detail : ''}`);
    backend = 'localStorage'; backendNote = 'unsigned-build';
  }
  localStorage.setItem(VAULT, text);
}

export async function deleteVault() {
  const s = shell();
  if (s) await s.invoke('keychain/delete', { account: VAULT });
  localStorage.removeItem(VAULT);
}

export function loadPrefs() {
  try { return { fiat: 'jpy', ...JSON.parse(localStorage.getItem(PREFS) || '{}') }; }
  catch { return { fiat: 'jpy' }; }
}
export function savePrefs(p) {
  try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* preview without storage */ }
}

export async function copyText(text) {
  const s = shell();
  if (s) { const r = await s.invoke('clipboard/write-text', { text }); if (r.ok) return true; }
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
