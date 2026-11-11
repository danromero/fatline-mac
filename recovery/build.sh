#!/bin/sh
# Rebuild the recovery helper from authorize.mjs, with the exact versions in package-lock.json.
# The Apple apps and the Chrome extension ship the same file.
set -eu
cd "$(dirname "$0")"
npm ci --ignore-scripts --no-audit --no-fund >/dev/null
tooling=$PWD/node_modules
cd ..
export NODE_PATH="$tooling"
out=apple/Shared/Recovery
"$tooling/.bin/esbuild" recovery/authorize.mjs \
  --bundle --platform=browser --main-fields=module,main --format=iife --target=es2022 \
  --banner:js="$(cat recovery/jscontext-polyfill.js)" --minify --legal-comments=linked --outfile=$out/authorize.js

# Include the full notices for the libraries incorporated into the bundle.
for package in viem @noble/curves @noble/hashes @scure/base @scure/bip32 @scure/bip39; do
  printf '\n--- %s ---\n' "$package" >> $out/authorize.js.LEGAL.txt
  cat "$tooling/$package/LICENSE" >> $out/authorize.js.LEGAL.txt
done

cp $out/authorize.js $out/authorize.js.LEGAL.txt chrome/static/
