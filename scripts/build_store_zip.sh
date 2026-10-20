#!/usr/bin/env bash
# Builds the Chrome Web Store upload: exactly the extension's own files, no
# native host, installers, keys or docs-only assets.
#
#   ./scripts/build_store_zip.sh     ->  local-tcp-chrome-store-<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

FILES=(
  manifest.json background.js content.js
  popup.html popup.js index.html docs.js
  icons/icon16.png icons/icon48.png icons/icon128.png
  icons/algonize.png icons/algoramming.png
)

for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || { echo "Missing $f" >&2; exit 1; }
done
for f in background.js content.js popup.js docs.js; do node --check "$f"; done
VERSION=$(node -p "require('./manifest.json').version")

OUT="local-tcp-chrome-store-${VERSION}.zip"
rm -f "$OUT"
zip -X -q "$OUT" "${FILES[@]}"
echo "Built $OUT (v$VERSION):"
unzip -l "$OUT" | tail -n +4 | sed '$d' | sed '$d'
