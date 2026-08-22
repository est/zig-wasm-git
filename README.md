# zig-wasm-git

Pure-Zig, no-libc WASM git engine + Node host. Inspired by [Cloudflare Artifacts](https://blog.cloudflare.com/artifacts-git-for-agents-beta/):

> The entire git protocol engine is written in pure Zig (no libc), compiled to a ~100KB WASM binary ... It implements SHA-1, zlib inflate/deflate, delta encoding/decoding, pack parsing, and the full git smart HTTP protocol — all from scratch, with zero external dependencies.

This repo is a minimal reproduction focused on `git http` read/write with `partial clone`.

## Features

- ~11KB `wasm32-freestanding ReleaseSmall`, single import `env.host_emit_bytes`
- SHA-1 / zlib / pack v2 / pkt-line / smart HTTP (`v1` + `v2 ls-refs/fetch=filter`)
- `filter` via `wasm_should_omit`: `blob:none`, `blob:limit`, `tree:0`, `object:type`, `combine:+`

## Build & verify

```bash
./scripts/fetch-deps.sh
./third_party/zig/zig build        # also: zig build test
node scripts/test_wasm.mjs         # asserts filter semantics
PORT=3002 ./scripts/e2e.sh         # clone / push / fetch / partial
```

## Using WASM from JS

`zig-out/bin/zig_wasm_git.wasm` exports `memory`, `wasm_alloc`, `wasm_reset`, `wasm_handle_discovery`, `wasm_parse_filter`, `wasm_should_omit`, `wasm_pktline_encode`. Host provides `host_emit_bytes(ptr,len)`.

```js
import { readFileSync } from "node:fs";

const bytes = readFileSync("zig-out/bin/zig_wasm_git.wasm");
let inst;
const mod = new WebAssembly.Module(bytes);
inst = new WebAssembly.Instance(mod, {
  env: {
    host_emit_bytes(ptr, len) {
      const mem = new Uint8Array(inst.exports.memory.buffer);
      process.stdout.write(Buffer.from(mem.slice(ptr, ptr + len)));
    },
  },
});
const wasm = inst.exports;

function allocStr(s) {
  const b = Buffer.from(s);
  const ptr = wasm.wasm_alloc(b.length);
  new Uint8Array(wasm.memory.buffer).set(b, ptr);
  return { ptr, len: b.length };
}

// 1) Filter decision
wasm.wasm_reset();
const filter = allocStr("blob:none");
const kind = allocStr("blob");
console.log(wasm.wasm_should_omit(kind.ptr, kind.len, 100, filter.ptr, filter.len)); // 1 = omit

// 2) Discovery: refs pkt -> advertisement
wasm.wasm_reset();
const refsPkt = allocStr("00730000000000000000000000000000000000000000 capabilities^{}\0symref=HEAD:refs/heads/main\n0000");
wasm.wasm_handle_discovery(0, refsPkt.ptr, refsPkt.len); // service 0=upload-pack, emits via host_emit_bytes

// 3) Parse filter from fetch body
wasm.wasm_reset();
const body = allocStr("0017filter blob:none\n0032want abcdef0123456789abcdef0123456789abcdef01\n0009done\n0000");
const outHas = new Uint32Array(wasm.memory.buffer, wasm.wasm_alloc(4), 1);
const outPtr = new Uint32Array(wasm.memory.buffer, wasm.wasm_alloc(8), 2);
// wasm_parse_filter(body.ptr, body.len, &has, &ptr, &len)
```

Host example: `src/host/server.mjs` delegates `ls-refs`, `fetch --filter` and discovery framing to WASM while storage stays in `data/<repo>.git`.

## Known limits

- `blob:limit` checkout's promisor fetch is best-effort (`--no-checkout` in e2e)
- No `shallow`/`notes`/`LFS`, no chunked storage

## License

Apache-2.0.
