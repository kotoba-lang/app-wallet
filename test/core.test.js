// Parity oracle: test/fixtures/oracle.json is produced by the REAL
// kotoba-lang/wallet library (scripts/oracle.sh). Every address and every
// signed transaction the app derives must equal it byte-for-byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as d from '../src/core/derive.js';
import * as evm from '../src/core/evm.js';
import * as ks from '../src/core/keystore.js';

const oracle = JSON.parse(readFileSync(new URL('./fixtures/oracle.json', import.meta.url), 'utf8'));
const root = d.rootFromMnemonic(oracle.mnemonic);

test('implemented chains = the library\'s implemented set', () => {
  assert.deepEqual(d.implemented(), Object.keys(oracle.accounts).sort());
});

for (const [chain, want] of Object.entries(oracle.accounts)) {
  test(`account ${chain} equals wallet.chain/account`, () => {
    const got = d.account(root, chain);
    const norm = (a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, String(v)]));
    assert.deepEqual(norm(got), norm(want));
  });
}

// The two accounts must NOT be equal for different chains whose paths differ —
// guards against the equality above degrading into comparing constants.
test('different coin types derive different keys', () => {
  assert.notEqual(d.account(root, 'btc').p2pkh, d.account(root, 'ltc').p2pkh);
  assert.notEqual(d.account(root, 'eth').address, d.account(root, 'trx')['hex-address']);
});

const toTx = (t) => {
  const tx = { nonce: t.nonce, gas: t.gas, to: t.to, value: t.value, data: t.data, chainId: t['chain-id'] };
  if (t['max-fee-per-gas']) Object.assign(tx, { maxFeePerGas: t['max-fee-per-gas'], maxPriorityFeePerGas: t['max-priority-fee-per-gas'] });
  else tx.gasPrice = t['gas-price'];
  return tx;
};

for (const s of oracle.signed) {
  test(`sign ${s.kind} on ${s.chain} equals wallet.chain/sign-tx`, () => {
    const acct = d.account(root, s.chain);
    const raw = evm.signTx(s.chain, toTx(s.tx), d.nodeFor(root, acct).privateKey);
    assert.equal(raw, s.raw);
  });
}

test('chain-id mismatch is refused, as in wallet.chain/ensure-chain-id', () => {
  const acct = d.account(root, 'base');
  assert.throws(() => evm.signTx('base', { nonce: 0, gasPrice: 1, gas: 21000, to: '0x' + '35'.repeat(20), value: 0, chainId: 1 },
    d.nodeFor(root, acct).privateKey), (e) => e.data?.reason === 'chain-id-mismatch');
});

test('staged and external chains are refused with the mechanism named', () => {
  assert.throws(() => d.account(root, 'sol'), (e) => e.data.reason === 'staged' && /ed25519/.test(e.data.needs));
  assert.throws(() => d.account(root, 'atom'), (e) => e.data.reason === 'external' && e.data.owner === 'kotoba-lang/saifu');
  assert.throws(() => d.account(root, 'nope'), (e) => e.data.reason === 'unknown');
});

test('EIP-55 address validation', () => {
  assert.ok(d.isEvmAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94'));
  assert.ok(d.isEvmAddress('0x9858effd232b4033e47d90003d41ec34ecaeda94'));
  assert.ok(!d.isEvmAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda95'.replace('Ef', 'eF')));
  assert.ok(!d.isEvmAddress('0x1234'));
});

test('units round-trip and refuse excess precision', () => {
  assert.equal(evm.parseUnits('1.5', 18), 1500000000000000000n);
  assert.equal(evm.parseUnits('0.000001', 6), 1n);
  assert.throws(() => evm.parseUnits('0.0000001', 6));
  assert.throws(() => evm.parseUnits('1e5', 18));
  assert.equal(evm.formatUnits(1500000000000000000n, 18), '1.5');
  assert.equal(evm.formatUnits(0n, 8), '0');
});

test('mnemonics: generated ones validate, garbage does not', () => {
  const m = d.newMnemonic();
  assert.equal(m.split(' ').length, 12);
  assert.ok(d.isValidMnemonic(m));
  assert.ok(d.isValidMnemonic('  Abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ABOUT '));
  assert.ok(!d.isValidMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'));
});

test('vault seals and opens; wrong passcode is refused', async () => {
  const v = await ks.seal({ mnemonic: oracle.mnemonic }, 'correct horse', { iterations: 1000 });
  assert.equal(v.c, 1000);
  assert.ok(!JSON.stringify(v).includes('abandon'));
  assert.deepEqual(await ks.open(v, 'correct horse'), { mnemonic: oracle.mnemonic });
  await assert.rejects(ks.open(v, 'wrong horse!'), ks.WrongPasscode);
  await assert.rejects(ks.seal({}, '123'), RangeError);
});
