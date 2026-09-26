#!/usr/bin/env bash
# zig unit + wasm filter + RemoteGit/pull/push e2e
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
echo "== push client e2e (wasm protocol + git-verified) =="
node tests/test_push.mjs
echo "== pull client e2e (worker-like, delta + filter, git-verified) =="
node tests/test_fetch.mjs
echo "== RemoteGit facade e2e (versioned blob store) =="
node tests/test_remote.mjs
echo "== ALL TESTS PASSED =="
