#!/bin/sh
# Build Kotoba Wallet for a kotoba-shell target: ios | android | macos.
#
#   KOTOBA_SHELL=<path to kotoba-lang/shell>  (default: ../shell)
#   sh scripts/build-app.sh ios
#
# `app scaffold` runs every time on purpose: it is the step that copies
# :web/dist-dir into the native project. `app build` alone rebuilds the
# native project around whatever bundle the LAST scaffold copied, so a UI
# change would silently ship the previous app.js.
set -eu
TARGET=${1:?usage: build-app.sh ios|android|macos}
HERE=$(cd "$(dirname "$0")/.." && pwd)
SHELL_REPO=${KOTOBA_SHELL:-$HERE/../shell}
cd "$HERE"
npm run build
for step in scaffold build; do
  "$SHELL_REPO/bin/kotoba-shell" app $step --target "$TARGET" --manifest app.kotoba.edn \
    --policy shell-policy.edn --output-dir "build/$TARGET" --execute --json > "build/$TARGET.$step.json"
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!r["ok?"]){console.error(JSON.stringify(r,null,1).slice(0,4000));process.exit(1)}console.log(process.argv[2],r.code)' "build/$TARGET.$step.json" "$step"
done
