# zig-wasm-git

[![CI](https://github.com/est/zig-wasm-git/actions/workflows/ci.yml/badge.svg)](https://github.com/est/zig-wasm-git/actions/workflows/ci.yml)

Pure-Zig, no-libc WASM git engine + Node host. Inspired by [Cloudflare Artifacts](https://blog.cloudflare.com/artifacts-git-for-agents-beta/):

> The entire git protocol engine is written in pure Zig (no libc), compiled to a ~100KB WASM binary ... It implements SHA-1, zlib inflate/deflate, delta encoding/decoding, pack parsing, and the full git smart HTTP protocol — all from scratch, with zero external dependencies.

This repo is a minimal reproduction focused on `git http` read/write with `partial clone`.

## Download

Grab the prebuilt wasm from the latest release — no toolchain needed:

```bash
curl -LO https://github.com/est/zig-wasm-git/releases/latest/download/zig_wasm_git.wasm
```

Each release ships a fixed-name `zig_wasm_git.wasm` + `.sha256`, built by CI from the tagged commit (pin a version via the per-tag download path).

## Features

- **47KB** `wasm32-freestanding ReleaseSmall`, no libc, imports only `env.host_*`
- Object-level API: read blobs by path / write commits from `{path: content}` maps
- SHA-1 / zlib / pack v2 / pkt-line / smart HTTP (`v1` + `v2 ls-refs/fetch=filter`)
- Partial clone filters: `blob:none`, `blob:limit`, `tree:0`, `object:type`, `combine:+`

## Object-level API (recommended)

Read and write git objects without touching any protocol. Caller only deals in refs/sha1/paths/bytes.

```js
import { load, memoryStore, fileStore } from "./src/host/api.mjs";

// pure in-memory (default; zero FS — ideal for Workers/KV backends)
const mem = load("zig_wasm_git.wasm");
mem.commit("", "init", { "README.md": "hello" });
const blobs = mem.get("main", ["README.md"]);          // [{path, oid, content: Buffer}]
const history = mem.log("main", 5);                     // newest-first commit chain

// on-disk bare repo (git-compatible layout)
const disk = load("zig_wasm_git.wasm", { dir: "data/demo.git" });
disk.commit("main", "v2", { "src/new.zig": "..." }, "refs/heads/main",
            { author: "Alice <a@ex.com>", committer: "CI <ci@ex.com>", time: 1755859200, timezone: "+0800" });

// any backend via the same 6-method interface
load("zig_wasm_git.wasm", { store: { get(hex){}, put(hex,loose){}, getRef(n){}, putRef(n,s){}, heads(){} } });
```

Internals: `wasm_get` walks commit→tree→blob; `wasm_commit` stores blobs, rebuilds affected trees (git-correct sort), writes the commit. Storage goes through `host_get_object`/`host_put_object` callbacks (loose files in this glue; swap in SQLite/S3/etc. for your backend). Verified against real `git`: `log`/`ls-tree`/`cat-file`/`fsck --strict` all clean.

## Low-level WASM exports

For the smart-HTTP layer: `wasm_handle_discovery`, `wasm_parse_filter`, `wasm_should_omit`, `wasm_pktline_encode`, `wasm_alloc/reset`. See `src/host/server.mjs` for a working server.

## Build & test

```bash
./scripts/fetch-deps.sh     # vendor zig 0.16.0 into ./third_party (or use system zig)
./tests/run.sh              # zig unit tests + wasm filter tests + object API e2e
PORT=3002 ./scripts/e2e.sh  # smart HTTP e2e: clone/push/fetch/partial clone
```

## Versioning & release flow

SemVer. To cut a release:

1. Update `version` in `build.zig.zon`
2. Add a section to `CHANGELOG.md`
3. `git tag vX.Y.Z && git push origin main vX.Y.Z`

CI runs the full test suite on every push/PR. Tagging triggers the release workflow: build → test → publish `zig_wasm_git-vX.Y.Z.wasm` (+sha256) to GitHub Releases.

## Known limits

- `blob:limit` checkout's promisor fetch is best-effort (`--no-checkout` in e2e)
- No `shallow`/`notes`/`LFS`, no chunked storage; author/committer are fixed placeholders

## License

Apache-2.0.
