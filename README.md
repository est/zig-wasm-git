# zig-wasm-git

[![CI](https://github.com/est/zig-wasm-git/actions/workflows/ci.yml/badge.svg)](https://github.com/est/zig-wasm-git/actions/workflows/ci.yml)

git engine without `fs` nor `git` command. WASM+JS that speaks directly to any git http. Inspired by [Cloudflare Artifacts](https://blog.cloudflare.com/artifacts-git-for-agents-beta/):

> The entire git protocol engine is written in pure Zig (no libc), compiled to a ~100KB WASM binary ... It implements SHA-1, zlib inflate/deflate, delta encoding/decoding, pack parsing, and the full git smart HTTP protocol — all from scratch, with zero external dependencies.

This repo is a minimal reproduction focused on read/write remote blobs over git http.

Project Goal: **use git remote as a versioned blob store, not a dev workspace.**   
One branch == one keyspace (`path -> bytes`), one commit == one version.   
There is no workdir, no merge, no checkout — just `read` / `write` / `pull` / `publish`.   

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
- Blob-service facade (in `portable.mjs`): `read`/`readText`/`readMany`/`write`/`writeText`/`pull`/`publish`/`sync` over one branch-keyspace; missing key is `null`, each write is a version, push is fast-forward-only
- SHA-1 / zlib / pack v2 (incl. ofs/ref delta) / pkt-line / smart HTTP (`v1` + `v2 ls-refs/fetch=filter` + receive-pack + upload-pack clients)
- Partial clone filters: `blob:none`, `blob:limit`, `tree:0`, `object:type`, `combine:+`
- **No FS, no CLI on the client**: `src/host/{portable,sync,utils}.mjs` run in browsers/CF Workers (zero `node:` imports); Node adds `src/host/api.mjs` (file store + Buffer flavors)

## Blob-service API (recommended)

One branch is one keyspace. Missing keys are `null`, not errors. Each `write`
appends a version (a commit) on the current tip; `publish` moves the remote tip
and rejects on non-fast-forward (last-writer-wins, no merge).

```js
import { loadFromBytes, memoryStore, createBlobService } from "./src/host/portable.mjs";

const wasmBytes = new Uint8Array(await (await fetch("zig_wasm_git.wasm")).arrayBuffer());
const blobs = createBlobService(
  loadFromBytes(wasmBytes, { store: memoryStore() }),
  { ref: "main" }, // one branch == one keyspace
);

await blobs.pull("https://git.example.com/team/docs.git");
blobs.readText("README.md");                    // string | null
blobs.readMany(["a.txt", "d/b.bin"]);          // Map(path -> Uint8Array, missing skipped)
const version = blobs.write({ "a.txt": "hi" }, "update greeting"); // -> commit sha
await blobs.publish("https://git.example.com/team/docs.git");

// one-shot: pull latest, then return keys (partial keyspace supported)
await blobs.sync("https://git.example.com/team/docs.git", ["README.md"]);

// versions without bytes: pull with filter, read still resolves, bytes stay null
const partial = createBlobService(repo, { ref: "main", filter: "blob:none" });
await partial.pull(url);
partial.version(); // sha present; partial.read(path) -> null until full pull
```

## Browser / Workers

```js
import { loadFromBytes, memoryStore } from "./src/host/portable.mjs";

const wasmBytes = new Uint8Array(await (await fetch("zig_wasm_git.wasm")).arrayBuffer());
const repo = loadFromBytes(wasmBytes, { store: memoryStore() });

await repo.fetch("https://git.example.com/team/docs.git", "main"); // smart HTTP v2
repo.get("main", ["README.md"]);          // [{path, oid, content: Uint8Array}]
repo.commit("", "init", { "a.txt": "hi" });
await repo.push("https://git.example.com/team/docs.git", "main");
await repo.fetch("https://git.example.com/team/docs.git", "main", { filter: "blob:none" });
```

## Capability boundary (blob view <-> git terms, kept precise)

The facade hides git, but the wire is still git. This table states what the
underlying `want` / `have` negotiation, `delta` handling, and filters actually do.

| Blob capability | Git mechanism | Status |
| --- | --- | --- |
| Pull one version | `want <tip-oid>` (protocol v2 `fetch`, single ref tip per call) | Supported |
| Push only new versions | `have` exclusion: `collectObjects` skips everything reachable from the remote tip (`old` oid, or all advertised refs for a new branch) | Supported (push side) |
| Incremental pull bandwidth | `have` negotiation is **not** sent on fetch (v2 `fetch` is `want`-only, stateless); savings come from server-side pack `delta` + local cached-tip short-circuit (`fetch` returns `{cached:true}` when `want` is already stored) | Partial: no `have` lines on fetch |
| Small transfer of similar blobs | `ofs-delta` + `ref-delta` decode (`wasm_delta_apply`), incl. thin-pack bases already in local store | Decode supported |
| Small upload of similar blobs | `delta` encode on push | **Not supported** — push sends full objects (server re-deltifies on `gc`) |
| Skip bytes, keep versions | `filter blob:none` / `blob:limit=<n>[kmg]` / `tree:0` / `object:type=` / `combine:+` | Supported both sides; omitted blobs read as `NotFound`/`null` (no promisor on-demand fetch yet) |
| Shallow history | `shallow` / `deepen` / `deepen-since` / `deepen-not` | **Not supported** (client never sends `deepen`) |
| Delete a key | tree-entry removal in `wasm_commit` | **Not supported** — `write` only upserts; full history retained |
| Concurrent writers | merge / conflict resolution | **None** — last-writer-wins; `publish` rejects non-fast-forward, caller re-pulls and rewrites |
| Single huge blob | wasm 4MB arena per call, whole-pack `arrayBuffer` in JS | No chunked storage; blobs approaching MBs may hit `wasm_alloc` / Worker memory limits |
| Tags / notes / LFS / submodules | `tag` objects traversable; `gitlink` entries skipped on push; no LFS/notes protocol | Tags readable by oid; LFS/notes unsupported |
| Platform ABIs | `fetch`, `CompressionStream`/`DecompressionStream`, `crypto.subtle`, `TextEncoder/Decoder` | Required in browser/Worker (no polyfill bundled) |
| v1-only servers | upload-pack discovery without `version 2` (e.g. 腾讯工蜂, verified live) | `fetch`/`lsRemote` refuse loudly (`server lacks protocol v2`); `push` (v1 receive-pack) works — probe branch pushed, `cat-file` byte-exact, branch deleted |

## Object-level API

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
See `tests/server.mjs` for a working server and `src/host/portable.mjs` for the portable client.

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

## Known limits (see capability boundary above for the full `want`/`have`/`delta` account)

- `write` upserts only — no key deletion yet
- No merge: concurrent `publish` to the same tip rejects; re-pull and rewrite
- Fetch sends no `have` lines (v2 `want`-only); incremental bandwidth relies on server-side `delta` + cached-tip short-circuit
- Push sends full objects, no `delta` encode (server re-deltifies on `gc`)
- `blob:limit` checkout's promisor fetch is best-effort (`--no-checkout` in e2e); omitted blobs read as `null`
- No `shallow`/`deepen`/`notes`/`LFS`, no chunked storage (4MB wasm arena per call)
- Test-only server (`tests/server.mjs`) shells out to `git`; the client chain never does

## License

Apache-2.0.
