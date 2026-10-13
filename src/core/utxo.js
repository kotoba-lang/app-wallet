// UTXO transactions (BTC / LTC / DOGE) — counterpart of wallet.chain/sign-tx
// for :utxo, which signs one input at a time through btc-crypto:
//   P2WPKH inputs: BIP-143 SIGHASH_ALL, witness [der‖01, pubkey33]
//   P2PKH  inputs: legacy SIGHASH_ALL, scriptSig <der‖01> <pubkey33>
// test/core.test.js holds every input signature equal to the library's, and
// the assembled transaction equal to @scure/btc-signer's (an independent
// implementation) for the same inputs.
//
// Scope matches the library: SIGHASH_ALL, spending our own P2WPKH / P2PKH
// outputs only. Recipients may be P2PKH, P2SH, P2WPKH, P2WSH or P2TR.
// BCH is refused (no SIGHASH_FORKID), exactly as wallet.chain refuses it.
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { bech32, bech32m, createBase58check } from '@scure/base';
import { chains, utxoNetworks, ChainRefused } from './derive.js';

const base58check = createBase58check(sha256);
const sha256d = (b) => sha256(sha256(b));
const hash160 = (b) => ripemd160(sha256(b));

export const SIGHASH_ALL = 0x01;
export const RBF_SEQUENCE = 0xfffffffd;

// Per-network spend rules the derivation table does not need.
export const spendRules = {
  mainnet:  { p2sh: [0x05], dust: 546n },
  litecoin: { p2sh: [0x32, 0x05], dust: 546n },
  // Dogecoin Core 1.14.6+: dust limit and min relay fee are both 0.01 DOGE (per kB for the fee).
  dogecoin: { p2sh: [0x16], dust: 1_000_000n, minFeePerVb: 1000 },
};

export function netOf(chain) {
  const e = chains[chain];
  if (!e || e.family !== 'utxo') throw new ChainRefused(`${chain} is not a UTXO chain`, { reason: 'family', chain });
  if (e['receive-only?'])
    throw new ChainRefused(`${e.name} is receive-only: SIGHASH_FORKID is not implemented, refusing to emit a signature the network would reject`,
      { reason: 'receive-only', chain });
  return { ...utxoNetworks[e.network], ...spendRules[e.network], name: e.network };
}

// ── bytes ──────────────────────────────────────────────────────────────────
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
export function varint(n) {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return cat(Uint8Array.of(0xfe), u32(n));
}
const varbytes = (b) => cat(varint(b.length), b);
const rev = (b) => Uint8Array.from(b).reverse();

// ── scripts ────────────────────────────────────────────────────────────────
export const p2pkhScript = (h) => cat(Uint8Array.of(0x76, 0xa9, 0x14), h, Uint8Array.of(0x88, 0xac));
const p2shScript = (h) => cat(Uint8Array.of(0xa9, 0x14), h, Uint8Array.of(0x87));
const witnessScript = (v, prog) => cat(Uint8Array.of(v === 0 ? 0x00 : 0x50 + v, prog.length), prog);

/** Recipient address → {type, script}; refuses other networks' addresses. */
export function addressToScript(chain, address) {
  const net = netOf(chain);
  const a = address.trim();
  if (net.hrp && a.toLowerCase().startsWith(net.hrp + '1')) {
    let dec, v;
    try { dec = bech32.decode(a); v = dec.words[0]; if (v !== 0) throw 0; }
    catch { try { dec = bech32m.decode(a); v = dec.words[0]; if (v === 0) throw 0; } catch { throw new ChainRefused('invalid bech32 address', { reason: 'address' }); } }
    if (dec.prefix !== net.hrp) throw new ChainRefused(`address is for another network (${dec.prefix})`, { reason: 'network' });
    const prog = (v === 0 ? bech32 : bech32m).fromWords(dec.words.slice(1));
    if (v === 0 && prog.length === 20) return { type: 'p2wpkh', script: witnessScript(0, prog) };
    if (v === 0 && prog.length === 32) return { type: 'p2wsh', script: witnessScript(0, prog) };
    if (v === 1 && prog.length === 32) return { type: 'p2tr', script: witnessScript(1, prog) };
    throw new ChainRefused(`unsupported witness program v${v}/${prog.length}`, { reason: 'address' });
  }
  let raw;
  try { raw = base58check.decode(a); } catch { throw new ChainRefused('invalid address', { reason: 'address' }); }
  if (raw.length !== 21) throw new ChainRefused('invalid address length', { reason: 'address' });
  const [ver, h] = [raw[0], raw.slice(1)];
  if (ver === net.p2pkh) return { type: 'p2pkh', script: p2pkhScript(h) };
  if (net.p2sh.includes(ver)) return { type: 'p2sh', script: p2shScript(h) };
  throw new ChainRefused(`address version 0x${ver.toString(16)} is not ${net.name}`, { reason: 'network' });
}

// ── serialization + sighash (tx = {version, locktime, inputs:[{txid hex BE, vout, sequence}], outputs:[{value, script}]}) ──
const outpoint = (i) => cat(rev(hexToBytes(i.txid)), u32(i.vout));
const output = (o) => cat(u64(o.value), varbytes(o.script));

export function legacySighash(tx, index, scriptCode) {
  const ins = tx.inputs.map((inp, i) => cat(outpoint(inp), varbytes(i === index ? scriptCode : new Uint8Array(0)), u32(inp.sequence)));
  return sha256d(cat(u32(tx.version), varint(tx.inputs.length), ...ins, varint(tx.outputs.length),
    ...tx.outputs.map(output), u32(tx.locktime), u32(SIGHASH_ALL)));
}

export function bip143Sighash(tx, index, scriptCode, amount) {
  const inp = tx.inputs[index];
  return sha256d(cat(u32(tx.version),
    sha256d(cat(...tx.inputs.map(outpoint))),
    sha256d(cat(...tx.inputs.map((i) => u32(i.sequence)))),
    outpoint(inp), varbytes(scriptCode), u64(amount), u32(inp.sequence),
    sha256d(cat(...tx.outputs.map(output))), u32(tx.locktime), u32(SIGHASH_ALL)));
}

const derSig = (digest, priv) => cat(secp256k1.sign(digest, priv, { lowS: true }).toDERRawBytes(), Uint8Array.of(SIGHASH_ALL));

/**
 * Sign input `index` of `tx` the way wallet.chain/sign-tx does. Returns
 * {witness:[sig, pub]} for p2wpkh or {scriptSig, derSig, pubkey} for p2pkh.
 */
export function signInput(tx, index, { type, amount }, privateKey) {
  const pub = secp256k1.getPublicKey(privateKey, true);
  const code = p2pkhScript(hash160(pub));
  if (type === 'p2wpkh') return { witness: [derSig(bip143Sighash(tx, index, code, amount), privateKey), pub] };
  if (type === 'p2pkh') {
    const sig = derSig(legacySighash(tx, index, code), privateKey);
    return { derSig: sig, pubkey: pub, scriptSig: cat(varbytes(sig), varbytes(pub)) };
  }
  throw new ChainRefused(`cannot spend a ${type} input`, { reason: 'input-type' });
}

export function serialize(tx, signed) {
  const segwit = signed.some((s) => s.witness);
  const ins = tx.inputs.map((inp, i) => cat(outpoint(inp), varbytes(signed[i].scriptSig ?? new Uint8Array(0)), u32(inp.sequence)));
  const body = [u32(tx.version), varint(tx.inputs.length), ...ins, varint(tx.outputs.length), ...tx.outputs.map(output)];
  const legacy = cat(...body, u32(tx.locktime));
  if (!segwit) return { raw: legacy, txid: bytesToHex(rev(sha256d(legacy))), vsize: legacy.length };
  const wit = signed.map((s) => (s.witness ? cat(varint(s.witness.length), ...s.witness.map(varbytes)) : Uint8Array.of(0)));
  const raw = cat(u32(tx.version), Uint8Array.of(0x00, 0x01), ...body.slice(1), ...wit, u32(tx.locktime));
  const weight = legacy.length * 3 + raw.length;
  return { raw, txid: bytesToHex(rev(sha256d(legacy))), vsize: Math.ceil(weight / 4) };
}

// ── size, fee, coin selection ──────────────────────────────────────────────
const INPUT_VB = { p2wpkh: 68, p2pkh: 148 };
const OUTPUT_VB = { p2pkh: 34, p2sh: 32, p2wpkh: 31, p2wsh: 43, p2tr: 43 };
export function estimateVsize(inputTypes, outputTypes) {
  const segwit = inputTypes.includes('p2wpkh');
  return Math.ceil(10 + (segwit ? 0.5 : 0) + inputTypes.reduce((n, t) => n + INPUT_VB[t], 0) + outputTypes.reduce((n, t) => n + OUTPUT_VB[t], 0));
}

/**
 * Pick inputs largest-first. `utxos`: [{txid, vout, value(bigint), type}].
 * Returns {inputs, fee, change, vsize} or throws 'insufficient'. With `max`,
 * sends everything minus the fee (amount is ignored and returned).
 */
export function selectCoins({ utxos, amount, feeRate, toType, changeType, dust, max = false }) {
  const pool = [...utxos].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const fee = (ins, outs) => BigInt(Math.ceil(estimateVsize(ins.map((u) => u.type), outs) * feeRate));
  if (max) {
    const total = pool.reduce((s, u) => s + u.value, 0n);
    const f = fee(pool, [toType]);
    if (total - f < dust) throw new ChainRefused('insufficient funds', { reason: 'insufficient' });
    return { inputs: pool, amount: total - f, fee: f, change: 0n, vsize: estimateVsize(pool.map((u) => u.type), [toType]) };
  }
  if (amount < dust) throw new ChainRefused(`amount below dust limit (${dust})`, { reason: 'dust' });
  const picked = [];
  let total = 0n;
  for (const u of pool) {
    picked.push(u); total += u.value;
    const withChange = fee(picked, [toType, changeType]);
    if (total >= amount + withChange) {
      const change = total - amount - withChange;
      if (change >= dust) return { inputs: picked, amount, fee: withChange, change, vsize: estimateVsize(picked.map((x) => x.type), [toType, changeType]) };
      const noChange = fee(picked, [toType]);
      // change would be dust: give it to the miner rather than create an unspendable output
      return { inputs: picked, amount, fee: total - amount, change: 0n, vsize: estimateVsize(picked.map((x) => x.type), [toType]), absorbed: total - amount - noChange };
    }
  }
  throw new ChainRefused('insufficient funds', { reason: 'insufficient' });
}

/**
 * Build and sign a spend from `acct` (a derive.account result for a UTXO
 * chain). `keyFor(type)` returns the private key for that address type —
 * the same BIP-44 key backs both addresses, as in wallet.chain.
 */
export function buildTransfer({ chain, acct, utxos, to, amount, feeRate, max = false, privateKey }) {
  const net = netOf(chain);
  const dest = addressToScript(chain, to);
  const changeAddr = acct.p2wpkh ?? acct.p2pkh;
  const change = addressToScript(chain, changeAddr);
  if (net.minFeePerVb && feeRate < net.minFeePerVb) feeRate = net.minFeePerVb;
  const sel = selectCoins({ utxos, amount: BigInt(amount ?? 0), feeRate, toType: dest.type, changeType: change.type, dust: net.dust, max });
  const tx = {
    version: 2, locktime: 0,
    inputs: sel.inputs.map((u) => ({ txid: u.txid, vout: u.vout, sequence: RBF_SEQUENCE })),
    outputs: [{ value: sel.amount, script: dest.script }, ...(sel.change > 0n ? [{ value: sel.change, script: change.script }] : [])],
  };
  const signed = sel.inputs.map((u, i) => signInput(tx, i, { type: u.type, amount: u.value }, privateKey));
  const { raw, txid, vsize } = serialize(tx, signed);
  return { raw: bytesToHex(raw), txid, vsize, fee: sel.fee, amount: sel.amount, change: sel.change, inputs: sel.inputs.length, to: dest };
}
