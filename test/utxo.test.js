// UTXO spends: per-input signatures equal to kotoba-lang/wallet (oracle), and
// the assembled transaction equal to @scure/btc-signer (independent impl).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import * as btc from '@scure/btc-signer';
import * as d from '../src/core/derive.js';
import * as u from '../src/core/utxo.js';

const oracle = JSON.parse(readFileSync(new URL('./fixtures/oracle.json', import.meta.url), 'utf8'));
const root = d.rootFromMnemonic(oracle.mnemonic);
const keyOf = (chain) => d.nodeFor(root, d.account(root, chain)).privateKey;

const txOf = (t) => ({
  version: t.version, locktime: t.locktime,
  inputs: t.inputs.map((i) => ({ txid: i.txid, vout: i.vout, sequence: i.sequence })),
  outputs: t.outputs.map((o) => ({ value: BigInt(o.value), script: hexToBytes(o['script-pubkey']) })),
});

for (const v of oracle['utxo-signed']) {
  test(`${v.chain}: every input signature equals wallet.chain/sign-tx`, () => {
    const tx = txOf(v.tx);
    v.inputs.forEach((want, i) => {
      const got = u.signInput(tx, i, { type: want['script-type'], amount: BigInt(v.tx.amounts[i]) }, keyOf(v.chain));
      if (want.witness) assert.deepEqual(got.witness.map(bytesToHex), want.witness);
      else {
        assert.equal(bytesToHex(got.derSig), want['der-sig-with-type']);
        assert.equal(bytesToHex(got.pubkey), want.pubkey);
      }
    });
  });

  test(`${v.chain}: assembled transaction equals @scure/btc-signer`, () => {
    const tx = txOf(v.tx);
    const priv = keyOf(v.chain);
    const acct = d.account(root, v.chain);
    const types = v.inputs.map((x) => x['script-type']);
    const ours = u.serialize(tx, types.map((type, i) => u.signInput(tx, i, { type, amount: BigInt(v.tx.amounts[i]) }, priv)));

    const pub = d.nodeFor(root, acct).publicKey;
    const ref = new btc.Transaction({ version: tx.version, lockTime: tx.locktime, allowLegacyWitnessUtxo: true, allowUnknownOutputs: true });
    tx.inputs.forEach((inp, i) => {
      const script = types[i] === 'p2wpkh' ? btc.p2wpkh(pub).script : btc.p2pkh(pub).script;
      ref.addInput({ txid: inp.txid, index: inp.vout, sequence: inp.sequence, witnessUtxo: { script, amount: BigInt(v.tx.amounts[i]) } });
    });
    tx.outputs.forEach((o) => ref.addOutput({ script: o.script, amount: o.value }));
    ref.sign(priv); ref.finalize();
    assert.equal(bytesToHex(ours.raw), ref.hex);
    assert.equal(ours.txid, ref.id);
    assert.equal(ours.vsize, ref.vsize);
  });
}

test('BCH is refused as receive-only, like wallet.chain', () => {
  assert.throws(() => u.netOf('bch'), (e) => e.data.reason === 'receive-only');
  assert.throws(() => u.netOf('eth'), (e) => e.data.reason === 'family');
});

test('recipient addresses decode per network and refuse other networks', () => {
  const s = (c, a) => { const r = u.addressToScript(c, a); return [r.type, bytesToHex(r.script)]; };
  assert.deepEqual(s('btc', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), ['p2wpkh', '0014751e76e8199196d454941c45d1b3a323f1433bd6']);
  assert.deepEqual(s('btc', '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA')[0], 'p2pkh');
  assert.deepEqual(s('btc', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')[0], 'p2sh');
  assert.deepEqual(s('btc', 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3')[0], 'p2wsh');
  assert.deepEqual(s('btc', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'),
    ['p2tr', '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798']);
  assert.equal(s('ltc', 'ltc1qvh20q3zqd8ecsy3puf9md2vmr4f7qzx0gr07tr')[0], 'p2wpkh');
  assert.equal(s('doge', 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC')[0], 'p2pkh');
  for (const [c, a] of [['btc', 'ltc1qvh20q3zqd8ecsy3puf9md2vmr4f7qzx0gr07tr'], ['ltc', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'],
    ['btc', 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC'], ['doge', '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA'], ['btc', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5']])
    assert.throws(() => u.addressToScript(c, a), /network|address|version|invalid/i, `${c} ${a}`);
});

const utxo = (value, type = 'p2wpkh', n = 0) => ({ txid: (n + 1).toString(16).padStart(64, '0'), vout: n, value: BigInt(value), type });

test('coin selection: largest-first, change above dust, fee from vsize', () => {
  const r = u.selectCoins({ utxos: [utxo(50_000, 'p2wpkh', 0), utxo(200_000, 'p2wpkh', 1)], amount: 100_000n, feeRate: 10, toType: 'p2wpkh', changeType: 'p2wpkh', dust: 546n });
  assert.equal(r.inputs.length, 1);
  assert.equal(r.inputs[0].value, 200_000n);
  assert.equal(r.fee, BigInt(Math.ceil(u.estimateVsize(['p2wpkh'], ['p2wpkh', 'p2wpkh']) * 10)));
  assert.equal(r.amount + r.fee + r.change, 200_000n);
});

test('coin selection: dust change goes to the fee, never to an output', () => {
  const fee2 = BigInt(Math.ceil(u.estimateVsize(['p2wpkh'], ['p2wpkh', 'p2wpkh']) * 5));
  const r = u.selectCoins({ utxos: [utxo(100_000n + fee2 + 100n)], amount: 100_000n, feeRate: 5, toType: 'p2wpkh', changeType: 'p2wpkh', dust: 546n });
  assert.equal(r.change, 0n);
  assert.equal(r.amount + r.fee, 100_000n + fee2 + 100n);
});

test('coin selection: send-max, insufficient, below-dust', () => {
  const m = u.selectCoins({ utxos: [utxo(30_000), utxo(20_000, 'p2pkh', 1)], max: true, feeRate: 2, toType: 'p2wpkh', changeType: 'p2wpkh', dust: 546n });
  assert.equal(m.inputs.length, 2);
  assert.equal(m.change, 0n);
  assert.equal(m.amount + m.fee, 50_000n);
  assert.throws(() => u.selectCoins({ utxos: [utxo(1000)], amount: 900n, feeRate: 1, toType: 'p2wpkh', changeType: 'p2wpkh', dust: 546n }), /insufficient/);
  assert.throws(() => u.selectCoins({ utxos: [utxo(10_000)], amount: 100n, feeRate: 1, toType: 'p2wpkh', changeType: 'p2wpkh', dust: 546n }), /dust/);
});

test('buildTransfer end to end (BTC, mixed inputs) matches btc-signer and enforces DOGE min fee', () => {
  const acct = d.account(root, 'btc');
  const priv = keyOf('btc');
  const utxos = [utxo(80_000, 'p2wpkh', 0), utxo(60_000, 'p2pkh', 1)];
  const r = u.buildTransfer({ chain: 'btc', acct, utxos, to: 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', amount: 120_000n, feeRate: 3, privateKey: priv });
  assert.equal(r.inputs, 2);
  assert.ok(r.change > 0n);
  // the estimate must not undershoot the real size by more than a byte per input (DER length jitter)
  assert.ok(Math.ceil(u.estimateVsize(['p2wpkh', 'p2pkh'], ['p2tr', 'p2wpkh'])) >= r.vsize - 2, `${r.vsize}`);
  const parsed = btc.Transaction.fromRaw(hexToBytes(r.raw), { allowUnknownOutputs: true });
  assert.equal(parsed.id, r.txid);
  assert.equal(parsed.outputsLength, 2);

  const dacct = d.account(root, 'doge');
  const dr = u.buildTransfer({ chain: 'doge', acct: dacct, utxos: [utxo(500_000_000n, 'p2pkh')], to: 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC', amount: 100_000_000n, feeRate: 1, privateKey: keyOf('doge') });
  assert.ok(dr.fee >= BigInt(dr.vsize) * 1000n - 1000n, `doge fee ${dr.fee} for ${dr.vsize} vB`);
});
