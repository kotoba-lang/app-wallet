#!/bin/sh
# Regenerate test/fixtures/oracle.json from the REAL kotoba-lang/wallet library.
#
# The library is .cljk (kotoba portable Clojure). Its kbb path does not load
# today (wallet's nbb.edn lacks btc-crypto/eth-crypto — `kbb -M:test` stops at
# `Unable to resolve symbol: btc/network`), so the oracle runs it on the JVM:
# clone wallet + its pinned deps, rename .cljk -> .cljc, run oracle/oracle.clj.
# The shas below are wallet's deps.edn pins; WALLET_SHA is the wallet commit
# the fixture was produced from.
set -eu
WALLET_SHA=${WALLET_SHA:-81fb22a}
HERE=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
clone() { git clone -q "https://github.com/kotoba-lang/$1.git" "$WORK/$1" && git -C "$WORK/$1" checkout -q "$2"; }
clone wallet     "$WALLET_SHA"
clone btc-crypto 675f893826db1b01994c7ef9bf9002a2669d54da
clone eth-crypto 2b0e56d28262eb1b513cee6c822a55714303f39a
clone crypto     c4f825c166c0095f7b020c503c56a0a1fb10af07
clone text       73bdb13ae7a3d004b44bca08be03a3191157a38f
mkdir -p "$WORK/run/src"
for r in wallet btc-crypto eth-crypto crypto text; do cp -R "$WORK/$r/src/." "$WORK/run/src/"; done
find "$WORK/run/src" -name '*.cljk' | while read -r f; do mv "$f" "${f%.cljk}.cljc"; done
cp "$HERE/oracle/oracle.clj" "$WORK/run/"
printf '{:paths ["src" "."] :deps {org.clojure/data.json {:mvn/version "2.5.1"}}}\n' > "$WORK/run/deps.edn"
(cd "$WORK/run" && clojure -M -m oracle) > "$HERE/test/fixtures/oracle.json"
echo "wrote test/fixtures/oracle.json (wallet $WALLET_SHA)"
# The chain registry the app ships is the library's own table, not a copy
# maintained by hand: extract it from the oracle output.
node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));require("fs").writeFileSync(process.argv[2],JSON.stringify({source:o.source,chains:o.chains},null,1)+"\n")' \
  "$HERE/test/fixtures/oracle.json" "$HERE/src/core/chains.json"
echo "wrote src/core/chains.json"
