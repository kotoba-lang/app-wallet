// Regenerate test/fixtures/inga-oracle.json: records signed by THIS driver,
// judged by the REAL inga.writer (kotoba-lang/inga, run under kbb with a
// node:crypto Ed25519 verify-fn). Needs kbb and sibling checkouts of
// kotoba-lang/inga and kotoba-lang/text (INGA / TEXT to override).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as inga from '../src/core/inga.js';

const here = new URL('..', import.meta.url).pathname;
const INGA = process.env.INGA ?? join(here, '../inga');
const TEXT = process.env.TEXT ?? join(here, '../text');
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const other = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const chain = 'inga-devnet-1';

const me = inga.ingaIdentity(mnemonic);
const them = inga.ingaIdentity(other);
const r0 = inga.signRecord({ chainId: chain, ref: 'wallet/notes', cid: 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy', head: null, identity: me });
const r1 = inga.signRecord({ chainId: chain, ref: 'wallet/notes', cid: 'bafkreidgvpkjawlxz6sffxzwgooowe5yt7i6wsyg236mfoks77nywkptdq', head: r0, identity: me });
const cases = {
  genesis: r0,
  next: r1,
  'tampered-cid': { ...r1, cid: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' },
  'tampered-seq': { ...r1, seq: 7 },
  'other-writer': inga.signRecord({ chainId: chain, ref: 'wallet/notes', cid: r1.cid, head: r0, identity: them }),
  'other-chain': inga.signRecord({ chainId: 'inga-fleet-1', ref: 'wallet/notes', cid: r1.cid, head: r0, identity: me }),
  'extra-field': { ...r1, note: 'x' },
};
const input = {
  chain,
  policy: { 'wallet/': [me.did] },
  pubkeys: { [me.did]: me.publicHex, [them.did]: them.publicHex },
  records: Object.values(cases),
};
const dir = mkdtempSync(join(tmpdir(), 'inga-oracle-'));
writeFileSync(join(dir, 'in.json'), JSON.stringify(input));
const out = execFileSync('kbb', ['--backend', 'sci', '--classpath', `${join(here, 'oracle')}:${INGA}/src:${TEXT}/src`,
  join(here, 'oracle/inga_writer.cljk'), join(dir, 'in.json')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const verdicts = JSON.parse(out.trim().split('\n').pop());
const inga_sha = execFileSync('git', ['-C', INGA, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
writeFileSync(join(here, 'test/fixtures/inga-oracle.json'), JSON.stringify({
  source: `kotoba-lang/inga ${inga_sha} inga.writer/signing-text + refusal (kbb, node:crypto Ed25519)`,
  mnemonic, chain, identity: inga.publicIdentity(me),
  cases: Object.fromEntries(Object.keys(cases).map((k, i) => [k, { record: cases[k], ...verdicts[i] }])),
}, null, 1) + '\n');
console.log('wrote test/fixtures/inga-oracle.json', Object.fromEntries(Object.keys(cases).map((k, i) => [k, verdicts[i].refusal])));
