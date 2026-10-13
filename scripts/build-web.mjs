// Bundle the app into web/dist — the directory app.kotoba.edn names as
// :web/dist-dir, which kotoba-shell copies into Resources/WebBundle (Apple)
// and app/src/main/assets (Android).
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const out = new URL('../web/dist/', import.meta.url).pathname;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(new URL('../web/static/', import.meta.url).pathname, out, { recursive: true });
await build({
  entryPoints: [new URL('../src/ui/app.js', import.meta.url).pathname],
  bundle: true, format: 'esm', target: ['safari16', 'chrome110'], minify: true,
  sourcemap: false, legalComments: 'eof', outfile: out + 'app.js', logLevel: 'info',
});
