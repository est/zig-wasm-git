#!/usr/bin/env bash
# 全部测试：zig unit + wasm filter + object-level API
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
ZIG="$(command -v zig || echo ./third_party/zig/zig)"
echo "zig: $ZIG ($($ZIG version))"
# vendored zig needs an explicit lib dir; system zig ships its own
LIBARGS=()
if [[ "$ZIG" == *third_party* ]]; then LIBARGS=(--zig-lib-dir third_party/zig/lib); fi
echo "== zig unit tests =="
"$ZIG" test src/zig/root.zig "${LIBARGS[@]}" --cache-dir .zig-cache --global-cache-dir tmp/cache
echo "== wasm filter tests =="
node tests/test_wasm.mjs
echo "== pack format tests (git-verified) =="
node tests/test_pack.mjs
echo "== object API e2e =="
node tests/test_api.mjs
echo "== push client e2e (wasm protocol + git-verified) =="
node tests/test_push.mjs
echo "== fetch client e2e (worker-like, delta + filter, git-verified) =="
node tests/test_fetch.mjs
echo "== memory store / author options =="
node tests/test_memory_store.mjs
echo "== ALL TESTS PASSED =="
