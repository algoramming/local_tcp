#!/usr/bin/env bash
# Build the Local TCP installer.
#
# Default: build for the machine you're on (always works).
#   ./build.sh
#
# Cross-build for a specific target (needs the rustup target + a cross linker):
#   ./build.sh x86_64-pc-windows-gnu      # needs: brew install mingw-w64
#   ./build.sh x86_64-unknown-linux-musl  # needs: brew install FiloSottile/musl-cross/musl-cross
#   ./build.sh aarch64-apple-darwin
#
# The cleanest path for shipping all three OSes is the GitHub Actions matrix in
# .github/workflows/release.yml — each runner builds its own native binary.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v cargo >/dev/null 2>&1; then
  echo "❌ Rust toolchain not found."
  echo "   Install it:  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  echo "   or on macOS: brew install rustup-init && rustup-init -y"
  exit 1
fi

TARGET="${1:-}"
if [[ -n "$TARGET" ]]; then
  rustup target add "$TARGET" 2>/dev/null || true
  echo "→ Building release for $TARGET ..."
  cargo build --release --target "$TARGET"
  echo "✅ Output: target/$TARGET/release/"
else
  echo "→ Building release for the native target ..."
  cargo build --release
  echo "✅ Output: target/release/localtcp-installer"
fi
