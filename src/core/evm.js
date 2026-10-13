// EVM transaction signing — counterpart of wallet.chain/sign-tx for :evm.
//
// EIP-1559 (type 2) and EIP-155 legacy, chain-id injected from the registry
// and a mismatch REFUSED, exactly as wallet.chain/ensure-chain-id does. The
// parity test holds the raw bytes equal to the library's for the same tx.
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { entry, ChainRefused } from './derive.js';

// ── RLP ────────────────────────────────────────────────────────────────────
const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
function encodeLength(len, offset) {
  if (len < 56) return Uint8Array.of(offset + len);
  const hex = len.toString(16);
  const lb = hexToBytes(hex.length % 2 ? '0' + hex : hex);
  return concat(Uint8Array.of(offset + 55 + lb.length), lb);
}
export function rlp(x) {
  if (Array.isArray(x)) {
    const body = concat(...x.map(rlp));
    return concat(encodeLength(body.length, 0xc0), body);
  }
  if (x.length === 1 && x[0] < 0x80) return x;
  return concat(encodeLength(x.length, 0x80), x);
}

/** Minimal big-endian bytes; zero is EMPTY (RLP integer form). */
export function intBytes(v) {
  const n = BigInt(v);
  if (n < 0n) throw new RangeError('negative integer');
  if (n === 0n) return new Uint8Array(0);
  const hex = n.toString(16);
  return hexToBytes(hex.length % 2 ? '0' + hex : hex);
}
const dataBytes = (h) => (!h || h === '0x' ? new Uint8Array(0) : hexToBytes(h.replace(/^0x/, '')));
const addrBytes = (a) => (a ? hexToBytes(a.replace(/^0x/, '')) : new Uint8Array(0));

function withChainId(chain, tx) {
  const want = BigInt(entry(chain)['chain-id']);
  if (tx.chainId != null && BigInt(tx.chainId) !== want)
    throw new ChainRefused(`tx chain-id ${tx.chainId} ≠ account chain-id ${want} — refusing to sign for a different network`,
      { reason: 'chain-id-mismatch', want: String(want), have: String(tx.chainId) });
  return { ...tx, chainId: want };
}

export const isEip1559 = (tx) => tx.maxFeePerGas != null;

function sign(digest, privateKey) {
  const sig = secp256k1.sign(digest, privateKey, { lowS: true });
  return { r: intBytes(sig.r), s: intBytes(sig.s), recovery: sig.recovery };
}

/**
 * Sign `tx` ({nonce, to, value, data, gas, maxFeePerGas,
 * maxPriorityFeePerGas} or legacy {gasPrice}) for `chain` with `privateKey`.
 * Returns the 0x raw transaction.
 */
export function signTx(chain, tx, privateKey) {
  tx = withChainId(chain, tx);
  if (isEip1559(tx)) {
    const fields = [intBytes(tx.chainId), intBytes(tx.nonce), intBytes(tx.maxPriorityFeePerGas),
      intBytes(tx.maxFeePerGas), intBytes(tx.gas), addrBytes(tx.to), intBytes(tx.value ?? 0),
      dataBytes(tx.data), []];
    const digest = keccak_256(concat(Uint8Array.of(2), rlp(fields)));
    const { r, s, recovery } = sign(digest, privateKey);
    return '0x02' + bytesToHex(rlp([...fields, intBytes(recovery), r, s]));
  }
  const fields = [intBytes(tx.nonce), intBytes(tx.gasPrice), intBytes(tx.gas), addrBytes(tx.to),
    intBytes(tx.value ?? 0), dataBytes(tx.data)];
  const digest = keccak_256(rlp([...fields, intBytes(tx.chainId), new Uint8Array(0), new Uint8Array(0)]));
  const { r, s, recovery } = sign(digest, privateKey);
  const v = BigInt(recovery) + tx.chainId * 2n + 35n;
  return '0x' + bytesToHex(rlp([...fields, intBytes(v), r, s]));
}

export const txHash = (raw) => '0x' + bytesToHex(keccak_256(hexToBytes(raw.slice(2))));

// ── units ──────────────────────────────────────────────────────────────────
/** "1.5" → 1500000000000000000n for decimals 18. Refuses excess precision. */
export function parseUnits(s, decimals) {
  s = String(s).trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') throw new RangeError(`not an amount: ${s}`);
  const [i, f = ''] = s.split('.');
  if (f.length > decimals) throw new RangeError(`more than ${decimals} decimals`);
  return BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}
export function formatUnits(v, decimals, maxFrac = 6) {
  v = BigInt(v);
  const neg = v < 0n; if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const i = v / base;
  let f = (v % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  return (neg ? '-' : '') + i.toString() + (f ? '.' + f : '');
}
