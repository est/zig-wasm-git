#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
WASM="zig-out/bin/zig_wasm_git.wasm"
HOST_PORT="${PORT:-3002}"
HOST_LOG="tmp/host_GIT_HTTP.log"
VERIFY_TMP="tmp/GIT_HTTP_partial"

echo "== build =="
./third_party/zig/zig build 2>&1 | tail -20
SIZE=$(stat -f%z "$WASM" 2>/dev/null || stat -c%s "$WASM" 2>/dev/null)
echo "wasm size=$SIZE"

echo "== wasm unit =="
node scripts/test_wasm.mjs 2>&1 | tail -20

echo "== start host on $HOST_PORT =="
mkdir -p tmp data
rm -rf "$VERIFY_TMP" 2>/dev/null || true
mkdir -p "$VERIFY_TMP"
pkill -f "node src/host/server.mjs" 2>/dev/null || true
sleep 1
PORT="$HOST_PORT" nohup node src/host/server.mjs > "$HOST_LOG" 2>&1 & echo $! > tmp/host_GIT_HTTP.pid
sleep 1
cat "$HOST_LOG" | tail -10

# GIT_HTTP demo.git via direct (no proxy)
GIT_HTTP_URL="https://${GIT_HTTP_PAT}@example-git-http.com/someone/demo.git"
# Unset proxy for GIT_HTTP
export https_proxy="" http_proxy="" HTTPS_PROXY="" HTTP_PROXY="" no_proxy=""

echo "== GIT_HTTP ls-remote =="
https_proxy="" git ls-remote "$GIT_HTTP_URL" 2>&1 | head -20; echo "ls-remote exit:$?"

echo "== GIT_HTTP clone --filter=blob:none =="
rm -rf "$VERIFY_TMP/clone_blob_none" 2>/dev/null || true
https_proxy="" git clone --filter=blob:none "$GIT_HTTP_URL" "$VERIFY_TMP/clone_blob_none" 2>&1 | tail -20; echo "clone blob:none exit:$?"
ls "$VERIFY_TMP/clone_blob_none" 2>&1 | head -20 || true
git -C "$VERIFY_TMP/clone_blob_none" log --oneline 2>&1 | head -10 || true
git -C "$VERIFY_TMP/clone_blob_none" rev-list --objects --all 2>&1 | head -20 || true

echo "== GIT_HTTP clone --filter=blob:limit=1k =="
rm -rf "$VERIFY_TMP/clone_limit" 2>/dev/null || true
https_proxy="" git clone --filter=blob:limit=1k "$GIT_HTTP_URL" "$VERIFY_TMP/clone_limit" 2>&1 | tail -20; echo "clone limit exit:$?"

echo "== GIT_HTTP fetch --filter=tree:0 =="
rm -rf "$VERIFY_TMP/clone_tree0" 2>/dev/null || true
https_proxy="" git clone --filter=tree:0 "$GIT_HTTP_URL" "$VERIFY_TMP/clone_tree0" 2>&1 | tail -20; echo "clone tree:0 exit:$?"

echo "== local host clone after GIT_HTTP partial =="
git clone "http://localhost:${HOST_PORT}/demo.git" "$VERIFY_TMP/local_from_demo" 2>&1 | tail -10 || true
ls "$VERIFY_TMP/local_from_demo" 2>&1 | head -10 || true

echo "== wasm partial via host: POST fetch with filter blob:none =="
# Simulate client sending filter to our host: use git clone --filter against local host after pushing GIT_HTTP content?
# First mirror GIT_HTTP demo into local host demo.git via push?
echo "-- host log tail --"
cat "$HOST_LOG" 2>&1 | tail -40
echo "== done =="
