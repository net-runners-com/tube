#!/bin/sh
# Builds the panel: TypeScript (panel/src) → panel/app.js and panel/pitch-worklet.js with esbuild,
# then the CSS. The outputs are committed: Orca loads the repository's files as they are.
set -e
cd "$(dirname "$0")/.."
ESBUILD="npx esbuild"
$ESBUILD panel/src/app.ts --bundle --minify --format=esm --target=es2022 --outfile=panel/app.js --log-level=warning
$ESBUILD panel/src/pitch-worklet.ts --bundle --minify --format=esm --target=es2022 --outfile=panel/pitch-worklet.js --log-level=warning
./scripts/build-css.sh
