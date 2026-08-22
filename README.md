# zig-wasm-git

Pure-Zig, no-libc WASM git engine + Node host. Inspired by [Cloudflare Artifacts](https://blog.cloudflare.com/artifacts-git-for-agents-beta/):

> The entire git protocol engine is written in pure Zig (no libc), compiled to a ~100KB WASM binary ... It implements SHA-1, zlib inflate/deflate, delta encoding/decoding, pack parsing, and the full git smart HTTP protocol — all from scratch, with zero external dependencies.

This repo is a minimal reproduction focused on `git http` read/write with `partial clone`.

## Features

- ~114KB `wasm32-freestanding ReleaseSmall` (object-level API included), imports `env.host_*`
- SHA-1 / zlib / pack v2 / pkt-line / smart HTTP (`v1` + `v2 ls-refs/fetch=filter`)
- `filter` via `wasm_should_omit`: `blob:none`, `blob:limit`, `tree:0`, `object:type`, `combine:+`

## Build & verify

```bash
./scripts/fetch-deps.sh
./third_party/zig/zig build        # also: zig build test
node scripts/test_wasm.mjs         # asserts filter semantics
PORT=3002 ./scripts/e2e.sh         # clone / push / fetch / partial
node scripts/test_api.mjs          # object-level API e2e (get/commit + git interop)
```

## Object-level API (recommended)

Read and write git objects without touching any protocol. Caller only deals in sha1/paths/bytes.

```js
import { load } from "./src/host/api.mjs";

const repo = load("zig-out/bin/zig_wasm_git.wasm", { dir: "data/demo.git" });

// read: ref can be sha1 | branch | HEAD
const blobs = repo.get("main", ["README.md", "src/a.txt", "missing"]);
// -> [{path, oid, content: Buffer}, {path, oid, content: Buffer}, {path, error: "NotFound"}]

// write: parent "" = new repo; {path: content}; updates refs/heads/main
const sha = repo.commit("", "init", { "README.md": "hello", "src/main.zig": "..." });
repo.commit("main", "v2", { "README.md": "hello v2", "src/new.zig": "new" }); // incremental + nested ok
```

Internals: `wasm_get(oid, paths[])` walks commit→tree→blob; `wasm_commit(parent, msg, entries[])` stores blobs, rebuilds affected trees (git-correct sort), writes commit. Storage via `host_get_object`/`host_put_object` (loose files in `data/<repo>.git/objects`). Verified against real `git`: `git log`/`ls-tree`/`cat-file`/`fsck --strict` all clean (see `scripts/test_api.mjs`).

## Low-level WASM from JS

For the smart-HTTP layer, `zig-out/bin/zig_wasm_git.wasm` also exports `wasm_alloc/reset`, `wasm_handle_discovery`, `wasm_parse_filter`, `wasm_should_omit`, `wasm_pktline_encode` (imports: `host_emit_bytes`, `host_get_object`, `host_put_object`). See `src/host/server.mjs`.

## Known limits

- `blob:limit` checkout's promisor fetch is best-effort (`--no-checkout` in e2e)
- No `shallow`/`notes`/`LFS`, no chunked storage

## License

Apache-2.0.
