#!/usr/bin/env bash
# Build the npm publish artefacts into dist/.
#
# Layout matters: the wasm must sit next to the bundle, because that is where
# RemoteGit looks when `wasm` is omitted (new URL("zig_wasm_git.wasm",
# import.meta.url)). Keep the two filenames in sync.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="dist"
WASM_SRC="zig-out/bin/zig_wasm_git.wasm"

# system zig, else the vendored copy from scripts/fetch-deps.sh
if command -v zig >/dev/null 2>&1; then
  ZIG="zig"; LIBARGS=()
elif [[ -x third_party/zig/zig ]]; then
  ZIG="./third_party/zig/zig"; LIBARGS=(--zig-lib-dir third_party/zig/lib)
else
  echo "error: zig not found." >&2
  echo "  install zig 0.16.x, or run ./scripts/fetch-deps.sh to vendor it." >&2
  exit 1
fi

echo "== zig build (wasm, ReleaseSmall) =="
"$ZIG" build "${LIBARGS[@]}"
[[ -f "$WASM_SRC" ]] || { echo "error: $WASM_SRC missing after build" >&2; exit 1; }

echo "== bundle JS (esbuild, pinned; --platform=neutral guards portability) =="
npx -y esbuild@0.25.0 src/host/portable.mjs \
  --bundle --format=esm --platform=neutral \
  --outfile="$OUT/zig-wasm-git.mjs"

echo "== assemble dist/ =="
cp "$WASM_SRC" "$OUT/zig_wasm_git.wasm"
# The .d.mts must sit next to the .mjs: under `nodenext` resolution, importing
# "./x.mjs" only picks up a sibling "x.d.mts".
cp src/host/portable.d.mts "$OUT/zig-wasm-git.d.mts"
# README/LICENSE/CHANGELOG are NOT copied here: npm always ships the root
# copies, and duplicating them doubles the doc weight in the tarball.

node --check "$OUT/zig-wasm-git.mjs"

echo "== dist/ =="
ls -l "$OUT"
