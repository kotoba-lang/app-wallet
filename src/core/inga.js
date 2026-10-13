// Kotoba L1 (inga) driver.
//
// inga is not an account/balance chain: it orders head records — "ref R is at
// sequence S and points at content CID C" — and a 2f+1 quorum certificate is
// the compare-and-set (inga.ref/project: FIRST committed record per [ref seq]
// wins). So a wallet on inga is a WRITER identity, not a coin holder:
//
//   identity  Ed25519 from the same BIP-39 seed (SLIP-0010, all-hardened),
//             presented as did:key (multicodec 0xed01, base58btc) — the form
//             inga.writer policies name writers by, and the form kagi /
//             kotoba-lang/ed25519 produce.
//   record    inga.head/v1 fields + `writer` + `sig`, where `sig` signs
//             inga.writer/signing-text (inga.ref-record/v2): the chain id and
//             every field, so it cannot be replayed onto another chain, ref,
//             sequence or CID.
//   transport inga-node HTTP: GET /health (chain id, heights), GET
//             /committed?ref= (head + proof), POST /submit {record}.
//
// The signature ENCODING is not fixed by inga (inga.writer injects verify-fn).
// This driver uses base64 Ed25519 over the UTF-8 signing text — the encoding
// inga-node's own witness sign-fn uses — and test/inga.test.js holds the
// signing text equal to inga.writer's own output (run under kbb).
import { ed25519 } from '@noble/curves/ed25519';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { mnemonicToSeedSync } from '@scure/bip39';
import { base58, base64 } from '@scure/base';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { normalizeMnemonic } from './derive.js';

// ── SLIP-0010 (ed25519: hardened children only) ────────────────────────────
const HARDENED = 0x80000000;
export function slip10Ed25519(seed, path) {
  let I = hmac(sha512, utf8ToBytes('ed25519 seed'), seed);
  let key = I.slice(0, 32), chain = I.slice(32);
  const parts = path.replace(/^m\/?/, '').split('/').filter(Boolean);
  for (const p of parts) {
    if (!p.endsWith("'")) throw new RangeError(`SLIP-0010 ed25519 supports hardened indices only: ${p}`);
    const n = Number(p.slice(0, -1));
    if (!Number.isInteger(n) || n < 0 || n >= HARDENED) throw new RangeError(`bad index ${p}`);
    const data = new Uint8Array(37);
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, n + HARDENED, false);
    I = hmac(sha512, chain, data);
    key = I.slice(0, 32); chain = I.slice(32);
  }
  return { privateKey: key, chainCode: chain, publicKey: ed25519.getPublicKey(key) };
}

// No SLIP-44 coin type is registered for Kotoba, and borrowing one would
// collide with a real chain. The path uses a Kotoba-specific purpose level,
// 0x6b6f74 ("kot"), all hardened as SLIP-0010 ed25519 requires. PROVISIONAL:
// change only with a vault migration, because it decides the identity.
export const INGA_PATH = "m/7040884'/0'/0'";

export const didKey = (pub32) => `did:key:z${base58.encode(Uint8Array.from([0xed, 0x01, ...pub32]))}`;
export function didKeyToPublic(did) {
  if (!did.startsWith('did:key:z')) throw new RangeError('not a base58btc did:key');
  const b = base58.decode(did.slice('did:key:z'.length));
  if (b.length !== 34 || b[0] !== 0xed || b[1] !== 0x01) throw new RangeError('not an Ed25519 did:key');
  return b.slice(2);
}

export function ingaIdentity(mnemonic, passphrase = '') {
  const seed = mnemonicToSeedSync(normalizeMnemonic(mnemonic), passphrase);
  const k = slip10Ed25519(seed, INGA_PATH);
  return { path: INGA_PATH, did: didKey(k.publicKey), publicHex: bytesToHex(k.publicKey), privateKey: k.privateKey };
}
export const publicIdentity = ({ path, did, publicHex }) => ({ path, did, publicHex });

// ── records (inga.writer, inga.ref-record/v2) ─────────────────────────────
export const HEAD_VERSION = 'inga.head/v1';
export const SIGNED_FIELDS = ['ref', 'seq', 'cid', 'prev', 'v', 'height'];

/** inga.writer/signing-text, byte for byte. */
export function signingText(chainId, record) {
  let s = `inga/ref-record/v2\nchain=${chainId}\n`;
  for (const f of SIGNED_FIELDS) { const v = record[f]; s += `${f}=${v == null ? '' : v}\n`; }
  return s;
}

// The signing text and inga.head/canonical-bytes are newline-delimited; a
// newline inside a value would let one record's text read as another's.
const clean = (name, v) => {
  if (typeof v !== 'string' || v.length === 0) throw new RangeError(`${name} is required`);
  if (/[\r\n\0]/.test(v)) throw new RangeError(`${name} must not contain line breaks`);
  if (v.length > 512) throw new RangeError(`${name} is too long`);
  return v;
};

/** The next record after `head` (null = empty ref), signed by `identity`. */
export function signRecord({ chainId, ref, cid, head, identity }) {
  clean('chain id', chainId);
  const record = {
    v: HEAD_VERSION, ref: clean('ref', ref), seq: head ? Number(head.seq) + 1 : 0,
    cid: clean('cid', cid), prev: head ? head.cid : null, height: null,
  };
  if (!Number.isSafeInteger(record.seq)) throw new RangeError('bad head sequence');
  const sig = ed25519.sign(utf8ToBytes(signingText(chainId, record)), identity.privateKey);
  return { ...record, writer: identity.did, sig: base64.encode(sig) };
}

/** inga.writer/refusal's signature clause for one record: true only for a good Ed25519 sig by `writer`. */
export function verifyRecord(chainId, record) {
  try {
    return ed25519.verify(base64.decode(record.sig), utf8ToBytes(signingText(chainId, record)), didKeyToPublic(record.writer)) === true;
  } catch { return false; }
}

/**
 * What a committed head says about our submission:
 *   'committed'  the head IS our record (same seq, writer, sig)
 *   'lost'       someone else's record took our sequence (first wins)
 *   'superseded' the ref moved past our seq; only the head is served, so ours cannot be told apart
 *   'pending'    not committed yet
 */
export function outcome(submitted, head) {
  if (!head || Number(head.seq) < submitted.seq) return 'pending';
  if (Number(head.seq) === submitted.seq)
    return head.writer === submitted.writer && head.sig === submitted.sig && head.cid === submitted.cid ? 'committed' : 'lost';
  return 'superseded';
}
