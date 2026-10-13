// Account derivation — the in-WebView counterpart of wallet.chain/account.
//
// The chain table is the library's own (chains.json, extracted from
// kotoba-lang/wallet by scripts/oracle.sh). This file only implements the
// family drivers the library has (:evm, :utxo, :tron) with the same BIP-44
// paths and the same address shapes, and test/core.test.js holds every output
// byte-equal to what the library itself derives for the same seed.
//
// Primitives are @noble/@scure (audited, pure JS). Nothing here implements a
// curve or a hash; the cashaddr checksum below is encoding, not crypto.
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { bytesToHex } from '@noble/hashes/utils';
import { bech32, createBase58check } from '@scure/base';
import registry from './chains.json' with { type: 'json' };

export const chains = registry.chains;
const base58check = createBase58check(sha256);

// btc-crypto's measured network constants, for the networks wallet.chains
// names. (btc-crypto verified these against real nodes; the parity test
// re-checks every one through the library's own output.)
export const utxoNetworks = {
  mainnet:        { encoding: 'base58',   p2pkh: 0x00, hrp: 'bc' },
  litecoin:       { encoding: 'base58',   p2pkh: 0x30, hrp: 'ltc' },
  dogecoin:       { encoding: 'base58',   p2pkh: 0x1e },
  'bitcoin-cash': { encoding: 'cashaddr', prefix: 'bitcoincash' },
};

export class ChainRefused extends Error {
  constructor(message, data) { super(message); this.data = data; }
}

/** Same refusals as wallet.chains/entry: unknown, staged, external. */
export function entry(chain) {
  const e = chains[chain];
  if (!e) throw new ChainRefused(`unknown chain ${chain}`, { reason: 'unknown', chain });
  if (e.status === 'planned')
    throw new ChainRefused(`${e.name} is staged — refusing to derive an address nothing can verify. Needs: ${e.needs}`,
      { reason: 'staged', chain, needs: e.needs });
  if (e.status === 'external')
    throw new ChainRefused(`${e.name} is owned by ${e.owner}`, { reason: 'external', chain, owner: e.owner });
  return e;
}

/** Chain keys `entry` answers for, sorted — wallet.chains/implemented. */
export function implemented() {
  return Object.keys(chains).filter((k) => !chains[k].status).sort();
}

export const newMnemonic = (strength = 128) => generateMnemonic(wordlist, strength);
export const isValidMnemonic = (m) => validateMnemonic(normalizeMnemonic(m), wordlist);
export const normalizeMnemonic = (m) => m.normalize('NFKC').trim().toLowerCase().split(/\s+/).join(' ');

export function rootFromMnemonic(mnemonic, passphrase = '') {
  return HDKey.fromMasterSeed(mnemonicToSeedSync(normalizeMnemonic(mnemonic), passphrase));
}

export const bip44Path = (e, account = 0, change = 0, index = 0) =>
  `m/44'/${e['coin-type']}'/${account}'/${change}/${index}`;

const hash160 = (b) => ripemd160(sha256(b));
const pub64 = (pub33) => secp256k1.ProjectivePoint.fromHex(pub33).toRawBytes(false).slice(1);

export function toChecksumAddress(hex40) {
  const lower = hex40.toLowerCase().replace(/^0x/, '');
  const h = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

export const evmAddress = (pub33) => toChecksumAddress(bytesToHex(keccak_256(pub64(pub33)).slice(12)));

export function isEvmAddress(a) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return false;
  const body = a.slice(2);
  // all-lower / all-upper carry no checksum; mixed case must match EIP-55
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(a) === a;
}

// ── cashaddr (BCH) — https://github.com/bitcoincashorg/bitcoincash.org spec ──
function cashPolymod(values) {
  const G = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= G[i];
  }
  return c ^ 1n;
}
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
export function cashaddr(prefix, h160) {
  const payload = bech32.toWords(Uint8Array.from([0x00, ...h160])); // version 0 = P2PKH/160-bit
  const pre = [...prefix].map((ch) => ch.charCodeAt(0) & 31);
  const mod = cashPolymod([...pre, 0, ...payload, 0, 0, 0, 0, 0, 0, 0, 0]);
  const checksum = Array.from({ length: 8 }, (_, i) => Number((mod >> BigInt(5 * (7 - i))) & 31n));
  return `${prefix}:${[...payload, ...checksum].map((d) => CHARSET[d]).join('')}`;
}

function utxoAddresses(e, pub33) {
  const net = utxoNetworks[e.network];
  if (!net) throw new ChainRefused(`no network constants for ${e.network}`, { reason: 'network', chain: e });
  const h = hash160(pub33);
  const out = {};
  if (net.encoding === 'base58') out.p2pkh = base58check.encode(Uint8Array.from([net.p2pkh, ...h]));
  if (net.encoding === 'cashaddr') out.cashaddr = cashaddr(net.prefix, h);
  if (net.hrp) out.p2wpkh = bech32.encode(net.hrp, [0, ...bech32.toWords(h)]);
  return out;
}

function tronAddresses(pub33) {
  const payload = Uint8Array.from([0x41, ...keccak_256(pub64(pub33)).slice(12)]);
  return { address: base58check.encode(payload), 'hex-address': bytesToHex(payload) };
}

/**
 * wallet.chain/account-with, without the private key in the result:
 * {chain, path, ...addresses}. The node (with its key) stays with the caller
 * through `nodeFor`, which signing uses and nothing else.
 */
export function account(root, chain, accountIndex = 0, change = 0, index = 0) {
  const e = entry(chain);
  const path = bip44Path(e, accountIndex, change, index);
  const pub33 = root.derive(path).publicKey;
  const base = { chain, path };
  switch (e.family) {
    case 'evm': return { ...base, address: evmAddress(pub33), 'chain-id': e['chain-id'] };
    case 'utxo': return { ...base, ...utxoAddresses(e, pub33) };
    case 'tron': return { ...base, ...tronAddresses(pub33) };
    default: throw new ChainRefused(`no driver for family ${e.family}`, { reason: 'family', chain });
  }
}

export const nodeFor = (root, acct) => root.derive(acct.path);

/** Every address a UTXO/EVM account exposes, primary first. */
export function addressesOf(acct) {
  return [acct.address, acct.p2wpkh, acct.p2pkh, acct.cashaddr].filter(Boolean);
}
