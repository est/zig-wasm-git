#!/usr/bin/env bash
# 全部测试：zig unit + wasm filter + object-level API
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
ZIG="$(command -v zig || echo ./third_party/zig/zig)"
echo "zig: $ZIG ($($ZIG version))"
echo "== zig unit tests =="
"$ZIG" test src/zig/root.zig --zig-lib-dir third_party/zig/lib --cache-dir .zig-cache --global-cache-dir tmp/cache
echo "== wasm filter tests =="
node tests/test_wasm.mjs
echo "== object API e2e =="
node tests/test_api.mjs
echo "== ALL TESTS PASSED =="
