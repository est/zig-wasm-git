# zig-wasm-git

[![CI](https://github.com/est/zig-wasm-git/actions/workflows/ci.yml/badge.svg)](https://github.com/est/zig-wasm-git/actions/workflows/ci.yml)

git engine without `fs` nor `git` command. WASM+JS that speaks directly to any git http. Inspired by [Cloudflare Artifacts](https://blog.cloudflare.com/artifacts-git-for-agents-beta/):

> The entire git protocol engine is written in pure Zig (no libc), compiled to a ~100KB WASM binary ... It implements SHA-1, zlib inflate/deflate, delta encoding/decoding, pack parsing, and the full git smart HTTP protocol — all from scratch, with zero external dependencies.

This repo is a minimal reproduction focused on read/write remote blobs over git http

## Download

Grab the prebuilt wasm from the latest release — no toolchain needed:

```bash
curl -LO https://github.com/est/zig-wasm-git/releases/latest/download/zig_wasm_git.wasm
```

Each release ships a fixed-name `zig_wasm_git.wasm` + `.sha256`, built by CI from the tagged commit (pin a version via the per-tag download path).

## Features

- **~69KB** `wasm32-freestanding ReleaseSmall`, no libc, imports only `env.host_*`
- Division of labor: **protocol weight lifting in wasm** (pkt-line, smart HTTP v1/v2 framing, pack framing/parsing, delta apply, single-pass inflate with exact `consumed`), **IO + platform ABIs in JS** (`fetch`, `CompressionStream`/`DecompressionStream`, `crypto.subtle`, pluggable store)
- Object-level API: read blobs by path / write commits from `{path: content}` maps / fetch+push over smart HTTP
- SHA-1 / zlib / pack v2 (incl. ofs/ref delta) / pkt-line / smart HTTP (`v1` + `v2 ls-refs/fetch=filter` + receive-pack + upload-pack clients)
- Partial clone filters: `blob:none`, `blob:limit`, `tree:0`, `object:type`, `combine:+`
- **No FS, no CLI on the client**: `src/host/{store,wire,fetch,browser,codec,push}.mjs` run in browsers/CF Workers (zero `node:` imports)

## Browser / Workers

```js
import { loadFromBytes, memoryStore } from "./src/host/browser.mjs";

const wasmBytes = new Uint8Array(await (await fetch("zig_wasm_git.wasm")).arrayBuffer());
const repo = loadFromBytes(wasmBytes, { store: memoryStore() });

await repo.fetch("https://git.example.com/team/docs.git", "main"); // smart HTTP v2
repo.get("main", ["README.md"]);          // [{path, oid, content: Uint8Array}]
repo.commit("", "init", { "a.txt": "hi" });
await repo.push("https://git.example.com/team/docs.git", "main");
await repo.fetch("https://git.example.com/team/docs.git", "main", { filter: "blob:none" });
```

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

// push to a smart-HTTP remote (protocol in wasm, fetch/compression in JS)
await mem.push("http://localhost:3000/demo.git", "main");  // -> {updated, ref, old, new, objects, packBytes}

// fetch/clone from a smart-HTTP remote (no FS, no CLI — same code in Workers)
await mem.fetch("http://localhost:3000/demo.git", "main"); // -> {ref, oid, objects, packBytes}
await mem.fetch("http://localhost:3000/demo.git", "main", { filter: "blob:none" });
const refs = await mem.lsRemote("http://localhost:3000/demo.git"); // [{oid, name}]
```

Internals: `wasm_get` walks commit→tree→blob; `wasm_commit` stores blobs, rebuilds affected trees (git-correct sort), writes the commit. Storage goes through `host_get_object`/`host_put_object` callbacks (loose files in this glue; swap in SQLite/S3/etc. for your backend). Verified against real `git`: `log`/`ls-tree`/`cat-file`/`fsck --strict` all clean.

## Low-level WASM exports

Protocol framing/parsing: `wasm_handle_discovery`, `wasm_parse_filter`, `wasm_should_omit`,
`wasm_pktline_encode`, `wasm_build_lsrefs`, `wasm_build_fetch`, `wasm_decode_pack_header`,
`wasm_list_refs`/`wasm_find_ref`, `wasm_pack_begin|add|end`, `wasm_parse_report_status`,
`wasm_inflate_one`, `wasm_delta_apply`, plus `wasm_get`/`wasm_commit[2]` and `wasm_alloc/reset`.
See `src/host/server.mjs` for a working server and `src/host/browser.mjs` for the portable client.

## Build & test

```bash
./scripts/fetch-deps.sh     # vendor zig 0.16.0 into ./third_party (or use system zig)
./tests/run.sh              # zig unit + wasm/filter/fetch/push/api e2e (fetch: worker-like, delta+filter, git-verified)
PORT=3002 ./scripts/e2e.sh  # smart HTTP e2e: clone/push/fetch/partial clone (real git client)
```

## Versioning & release flow

SemVer. To cut a release:

1. Update `version` in `build.zig.zon`
2. Add a section to `CHANGELOG.md`
3. `git tag vX.Y.Z && git push origin main vX.Y.Z`

CI runs the full test suite on every push/PR. Tagging triggers the release workflow: build → test → publish `zig_wasm_git-vX.Y.Z.wasm` (+sha256) to GitHub Releases.

## Known limits

- `blob:limit` checkout's promisor fetch is best-effort (`--no-checkout` in e2e)
- No `shallow`/`notes`/`LFS`, no chunked storage
- Test-only server (`src/host/server.mjs`) shells out to `git`; the client chain never does

## License

Apache-2.0.
