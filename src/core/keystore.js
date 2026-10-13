// Encrypted vault — the app-side shape of wallet.keystore.
//
// The mnemonic is the only secret, and it is stored only as AES-256-GCM
// ciphertext under a PBKDF2-HMAC-SHA256 key from the user's passcode (the
// same construction wallet.keystore uses). Pure JS (@noble) rather than
// WebCrypto: iOS serves the bundle from the custom `kotoba-webbundle:` scheme,
// where `crypto.subtle` is not guaranteed to exist; getRandomValues is.
//
// The KDF parameters travel inside the vault, so raising the iteration count
// later does not strand existing vaults.
import { gcm } from '@noble/ciphers/aes';
import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

export const DEFAULT_ITERATIONS = 210_000;

const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const deriveKey = (passcode, salt, c) => pbkdf2Async(sha256, utf8ToBytes(passcode), salt, { c, dkLen: 32 });

export async function seal(secret, passcode, { iterations = DEFAULT_ITERATIONS } = {}) {
  if (!passcode || passcode.length < 6) throw new RangeError('passcode must be at least 6 characters');
  const salt = random(16), nonce = random(12);
  const key = await deriveKey(passcode, salt, iterations);
  const ct = gcm(key, nonce).encrypt(utf8ToBytes(JSON.stringify(secret)));
  return { v: 1, kdf: 'pbkdf2-hmac-sha256', c: iterations, cipher: 'aes-256-gcm',
           salt: bytesToHex(salt), nonce: bytesToHex(nonce), ct: bytesToHex(ct) };
}

export class WrongPasscode extends Error {}

export async function open(vault, passcode) {
  if (vault?.v !== 1 || vault.kdf !== 'pbkdf2-hmac-sha256' || vault.cipher !== 'aes-256-gcm')
    throw new Error('unknown vault format');
  const key = await deriveKey(passcode, hexToBytes(vault.salt), vault.c);
  let pt;
  try { pt = gcm(key, hexToBytes(vault.nonce)).decrypt(hexToBytes(vault.ct)); }
  catch { throw new WrongPasscode('wrong passcode'); }
  return JSON.parse(new TextDecoder().decode(pt));
}
