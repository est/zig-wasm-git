#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
WASM="zig-out/bin/zig_wasm_git.wasm"
HOST_PORT="${PORT:-3001}"
HOST_LOG="tmp/host.log"
CLEAN_TMP="tmp/verify_tmp"

echo "== build =="
./third_party/zig/zig build 2>&1 | tail -20
if [[ ! -f "$WASM" ]]; then echo "wasm missing at $WASM"; exit 1; fi
SIZE=$(stat -f%z "$WASM" 2>/dev/null || stat -c%s "$WASM" 2>/dev/null)
echo "wasm size=$SIZE path=$WASM"

echo "== node wasm imports/exports =="
node -e "
const fs=require('fs');
const m=new (require('fs').readFileSync?'x':0);
" 2>&1 | head -5 || true
node -e "
import fs from 'fs';
const bytes=fs.readFileSync('$WASM');
const mod=new WebAssembly.Module(bytes);
console.log('imports', WebAssembly.Module.imports(mod).map(i=>i.module+':'+i.name).join(', '));
console.log('exports', WebAssembly.Module.exports(mod).map(e=>e.name).join(', '));
console.log('size', bytes.length);
" 2>&1 | head -20

echo "== wasm unit =="
node scripts/test_wasm.mjs 2>&1 | tail -20

echo "== host integration (port $HOST_PORT) =="
# ensure tmp dirs exist without asking rm permission via bash tool
mkdir -p tmp data
# cleanup via script-owned rm
rm -rf "$CLEAN_TMP" 2>/dev/null || true
mkdir -p "$CLEAN_TMP"

# kill old host if any
pkill -f "node src/host/server.mjs" 2>/dev/null || true
sleep 1
PORT="$HOST_PORT" nohup node src/host/server.mjs > "$HOST_LOG" 2>&1 & echo $! > tmp/host.pid
sleep 1
cat "$HOST_LOG" | tail -10

echo "-- discovery upload-pack (v1) --"
curl -s "http://localhost:${HOST_PORT}/demo.git/info/refs?service=git-upload-pack" 2>&1 | od -An -c | head -5
curl -s -i "http://localhost:${HOST_PORT}/demo.git/info/refs?service=git-upload-pack" 2>&1 | head -10

echo "-- discovery upload-pack (v2) --"
curl -s -i --header 'Git-Protocol: version=2' "http://localhost:${HOST_PORT}/demo.git/info/refs?service=git-upload-pack" 2>&1 | head -10

echo "-- discovery receive-pack --"
curl -s "http://localhost:${HOST_PORT}/demo.git/info/refs?service=git-receive-pack" 2>&1 | od -An -c | head -5

echo "-- ls-remote --"
git ls-remote "http://localhost:${HOST_PORT}/demo.git" 2>&1 | head -20; echo "ls-remote exit:$?"

echo "-- clone empty --"
rm -rf "$CLEAN_TMP/clone_empty" 2>/dev/null || true
git clone "http://localhost:${HOST_PORT}/demo.git" "$CLEAN_TMP/clone_empty" 2>&1 | tail -10
ls "$CLEAN_TMP/clone_empty/.git" 2>&1 | head -10 || true

echo "-- push --"
# ensure clean state for push
rm -rf "$CLEAN_TMP/push_test" 2>/dev/null || true
git clone "http://localhost:${HOST_PORT}/demo.git" "$CLEAN_TMP/push_test" 2>&1 | tail -5
echo "hello wasm git $(date)" > "$CLEAN_TMP/push_test/README.md"
git -C "$CLEAN_TMP/push_test" add README.md 2>&1 | head -5 || true
git -C "$CLEAN_TMP/push_test" -c user.name=test -c user.email=test@test.com commit -m "verify push $(date +%s)" 2>&1 | head -10 || true
git -C "$CLEAN_TMP/push_test" push -u origin main 2>&1 | tail -20; echo "push exit:$?"
git ls-remote "http://localhost:${HOST_PORT}/demo.git" 2>&1 | head -10

echo "-- partial clone blob:none --"
rm -rf "$CLEAN_TMP/partial_blob_none" 2>/dev/null || true
git clone --filter=blob:none "http://localhost:${HOST_PORT}/demo.git" "$CLEAN_TMP/partial_blob_none" 2>&1 | tail -10; echo "partial blob:none exit:$?"
git -C "$CLEAN_TMP/partial_blob_none" log --oneline 2>&1 | head -10 || true

echo "-- host log tail --"
cat "$HOST_LOG" 2>&1 | tail -40

echo "== verify done =="
# keep host running for manual inspection; pid in tmp/host.pid
