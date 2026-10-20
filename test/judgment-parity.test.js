// Judgment parity: the itonami dapp guest (aiueos/wallet_judgment.cljk) must
// decide exactly what this app decides. Two oracles, both from source:
//   1. src/ui/app.js:218  — canSend = family === 'evm' || (family === 'utxo' && !receive-only?)
//   2. src/core/chains.json — the chain table every real chain is classified by
// The guest runs on the amu selfhost (kototama-browser-host-v1) — the same host
// `amu test`'s wasm probes use. KOTOBA_BROWSER_HOST overrides the host path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const chains = Object.values(JSON.parse(readFileSync(new URL('../src/core/chains.json', import.meta.url), 'utf8')).chains);
const wasmPath = new URL('../aiueos/wallet_judgment.wasm', import.meta.url);
const hostPath = process.env.KOTOBA_BROWSER_HOST
  ?? '/Users/junkawasaki/github/kotoba-lang/amu/runtime/browser-host.mjs';

const FAM = { evm: 0, utxo: 1, tron: 2, cardano: 3, cosmos: 4, monero: 5, substrate: 6, xrp: 7, ed25519: 8 };

async function guest() {
  const host = await import(pathToFileURL(hostPath).href);
  const bytes = new Uint8Array(readFileSync(wasmPath));
  const { instance } = await host.instantiateKotoba(bytes, { allowCapabilities: [] });
  return instance.exports;
}

test('guest can-send matches the app.js predicate for every chain in chains.json', async () => {
  const g = await guest();
  for (const c of chains) {
    const fam = FAM[c.family];
    const ro = c['receive-only?'] ? 1 : 0;
    // src/ui/app.js:218, verbatim predicate
    const appSays = (c.family === 'evm' || (c.family === 'utxo' && !c['receive-only?'])) ? 1 : 0;
    assert.equal(Number(g['can-send'](BigInt(fam), BigInt(ro))), appSays,
      `can-send mismatch for ${c.symbol} (family ${c.family})`);
  }
});

test('guest derive admission matches the 12-chains / preparing split', async () => {
  const g = await guest();
  for (const c of chains) {
    const fam = FAM[c.family];
    const supported = ['evm', 'utxo', 'tron'].includes(c.family);
    assert.equal(Number(g['can-derive'](BigInt(fam))), supported ? 1 : 0,
      `can-derive mismatch for ${c.symbol}`);
    // preparing chains refuse derive but must be classified as preparing (2)
    if (!supported) assert.equal(Number(g['chain-status'](BigInt(fam), BigInt(0))), 2, c.symbol);
  }
});

test('guest transfer judgment classifies the refusal reasons', async () => {
  const g = await guest();
  assert.equal(Number(g['transfer-judgment'](BigInt(0), BigInt(0), BigInt(100))), 0);      // evm ok
  assert.equal(Number(g['transfer-judgment'](BigInt(9), BigInt(0), BigInt(100))), 1);      // unknown
  assert.equal(Number(g['transfer-judgment'](BigInt(3), BigInt(0), BigInt(100))), 2);      // preparing
  assert.equal(Number(g['transfer-judgment'](BigInt(1), BigInt(1), BigInt(100))), 4);      // BCH receive-only
  assert.equal(Number(g['transfer-judgment'](BigInt(0), BigInt(0), BigInt(0))), 8);        // bad amount
});
