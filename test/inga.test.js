// Kotoba L1 (inga) driver. test/fixtures/inga-oracle.json was produced by the
// REAL inga.writer (scripts/inga-oracle.mjs): its signing text and its verdict
// for each record. Ed25519 is deterministic, so the driver must reproduce
// every record byte for byte and agree with every verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { HDKey as Slip10 } from 'micro-key-producer/slip10.js';
import { mnemonicToSeedSync } from '@scure/bip39';
import * as inga from '../src/core/inga.js';

const oracle = JSON.parse(readFileSync(new URL('./fixtures/inga-oracle.json', import.meta.url), 'utf8'));

test('SLIP-0010 ed25519: official test vector 1', () => {
  const seed = hexToBytes('000102030405060708090a0b0c0d0e0f');
  const m = inga.slip10Ed25519(seed, 'm');
  assert.equal(bytesToHex(m.chainCode), '90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb');
  assert.equal(bytesToHex(m.privateKey), '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7');
  assert.equal(bytesToHex(m.publicKey), 'a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed');
  const c = inga.slip10Ed25519(seed, "m/0'");
  assert.equal(bytesToHex(c.chainCode), '8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69');
  assert.equal(bytesToHex(c.privateKey), '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3');
  assert.equal(bytesToHex(c.publicKey), '8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c');
  assert.throws(() => inga.slip10Ed25519(seed, 'm/0'), /hardened/);
});

test('SLIP-0010 on the wallet path equals micro-key-producer (independent impl)', () => {
  const seed = mnemonicToSeedSync(oracle.mnemonic);
  const ours = inga.slip10Ed25519(seed, inga.INGA_PATH);
  const ref = Slip10.fromMasterSeed(seed).derive(inga.INGA_PATH);
  assert.equal(bytesToHex(ours.privateKey), bytesToHex(ref.privateKey));
  assert.equal(bytesToHex(ours.publicKey), bytesToHex(ref.publicKeyRaw));
});

test('identity is stable and did:key round-trips', () => {
  const id = inga.ingaIdentity(oracle.mnemonic);
  assert.deepEqual(inga.publicIdentity(id), oracle.identity);
  assert.match(id.did, /^did:key:z6Mk/);
  assert.equal(bytesToHex(inga.didKeyToPublic(id.did)), id.publicHex);
  assert.throws(() => inga.didKeyToPublic('did:key:zQ3sh'), /Ed25519|did:key/);
});

for (const [name, c] of Object.entries(oracle.cases)) {
  test(`inga.writer agrees: ${name}`, () => {
    assert.equal(inga.signingText(oracle.chain, c.record), c['signing-text']);
    const accepted = c.refusal === null;
    assert.equal(inga.verifyRecord(oracle.chain, c.record) && Object.keys(c.record).every((k) => [...inga.SIGNED_FIELDS, 'writer', 'sig'].includes(k))
      && c.record.writer === oracle.identity.did, accepted, `inga says ${c.refusal}`);
  });
}

test('signing is deterministic: the driver reproduces the oracle records', () => {
  const me = inga.ingaIdentity(oracle.mnemonic);
  const g = oracle.cases.genesis.record;
  assert.deepEqual(inga.signRecord({ chainId: oracle.chain, ref: g.ref, cid: g.cid, head: null, identity: me }), g);
  const n = oracle.cases.next.record;
  assert.deepEqual(inga.signRecord({ chainId: oracle.chain, ref: n.ref, cid: n.cid, head: g, identity: me }), n);
  assert.equal(n.seq, 1);
  assert.equal(n.prev, g.cid);
});

test('line breaks cannot be smuggled into the newline-delimited signing text', () => {
  const me = inga.ingaIdentity(oracle.mnemonic);
  for (const [ref, cid] of [['a\nseq=9', 'x'], ['a', 'x\ncid=y'], ['', 'x'], ['a', '']])
    assert.throws(() => inga.signRecord({ chainId: 'c', ref, cid, head: null, identity: me }), /line breaks|required/);
  assert.throws(() => inga.signRecord({ chainId: 'c\n', ref: 'a', cid: 'x', head: null, identity: me }), /line breaks/);
});

test('outcome: first committed record per sequence wins', () => {
  const ours = oracle.cases.next.record;
  assert.equal(inga.outcome(ours, null), 'pending');
  assert.equal(inga.outcome(ours, oracle.cases.genesis.record), 'pending');
  assert.equal(inga.outcome(ours, ours), 'committed');
  assert.equal(inga.outcome(ours, oracle.cases['other-writer'].record), 'lost');
  assert.equal(inga.outcome(ours, { ...ours, seq: 2, sig: 'x' }), 'superseded');
});
