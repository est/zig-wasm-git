# zig-wasm-git

[![CI](https://github.com/est/zig-wasm-git/actions/workflows/ci.yml/badge.svg)](https://github.com/est/zig-wasm-git/actions/workflows/ci.yml)

git engine without `fs` nor `git` command. WASM+JS that speaks directly to any git http. Inspired by [Cloudflare Artifacts](https://blog.cloudflare.com/artifacts-git-for-agents-beta/):

> The entire git protocol engine is written in pure Zig (no libc), compiled to a ~69KB WASM binary ... It implements SHA-1, zlib inflate/deflate, delta encoding/decoding, pack parsing, and the full git smart HTTP protocol — all from scratch, with zero external dependencies.

This repo is a minimal reproduction focused on read/write remote blobs over git http.

Project Goal: **use git remote as a versioned blob store, not a dev workspace.**   
One branch == one keyspace (`path -> bytes`), one commit == one version.   
There is no workdir, no merge, no checkout — just `read` / `write` / `fetch` / `push`.   

## Download

Grab the prebuilt artifacts from the latest release — no toolchain needed:

```bash
curl -LO https://github.com/est/zig-wasm-git/releases/latest/download/zig_wasm_git.wasm
curl -LO https://github.com/est/zig-wasm-git/releases/latest/download/zig_wasm_git.portable.mjs
```

Each release ships fixed-name files + `SHA256SUMS`, built by CI from the tagged commit (pin a version via the per-tag download path):

- `zig_wasm_git.wasm` — the protocol engine (~69KB)
- `zig_wasm_git.portable.mjs` — single-file JS for browser/CF Worker/Node (`RemoteGit` + `memoryStore`)

## Features

- **~69KB** `wasm32-freestanding ReleaseSmall`, no libc, imports only `env.host_*`
- Division of labor: **protocol weight lifting in wasm** (pkt-line, smart HTTP v1/v2 framing, pack framing/parsing, delta apply, single-pass inflate with exact `consumed`), **IO + platform ABIs in JS** (`fetch`, `CompressionStream`/`DecompressionStream`, `crypto.subtle`, pluggable store)
- Blob-store API: read blobs by path / write commits from `{path: content}` maps / pull+push over smart HTTP
- `RemoteGit` (`src/host/portable.mjs`, the only API): url-bound, all-async
  `open`/`getMany`/`putMany`/`list`/`log`/`version`/`remoteVersion`/`pull`/`push`/`sync`
  over one branch-keyspace; missing blobs auto-fetched on demand (`want=<blob-oid>`,
  batched); missing keys are skipped; each `putMany` is a version (message + author/time
  options, CAS parent); push is fast-forward-only (client-side ancestry check + server backstop)
- SHA-1 / zlib / pack v2 (incl. ofs/ref delta) / pkt-line / smart HTTP (`v1` + `v2 ls-refs/fetch=filter` + receive-pack + upload-pack clients)
- Partial clone filters: `blob:none`, `blob:limit`, `tree:0`, `object:type`, `combine:+`
- **No FS, no CLI on the client**: `src/host/{portable,sync,utils}.mjs` run in browsers/CF Workers/Node (zero `node:` imports); per-platform init is one line (see below)

## Blob-store API (the only API)

One branch is one keyspace. Missing keys are skipped, not errors. Each `putMany`
appends a version (a commit) on the current tip; `push` moves the remote tip
and rejects on non-fast-forward (last-writer-wins, no merge). All methods are
async. Single keys go through the Many variants directly.

```js
import { RemoteGit } from "./src/host/portable.mjs";

// { wasm } takes bytes | Module | url-or-path string | { url | bytes | module }.
const git = await RemoteGit.open("https://user:pass@git.example.com/team/docs.git", {
  wasm: "https://git.example.com/zig_wasm_git.wasm", // http(s) url (lib fetches),
  // wasm: "zig_wasm_git.wasm",    // Node path (read via process.getBuiltinModule)
  // wasm: wasmBytes,              // bytes you loaded yourself
  // wasm: WASM_MODULE,            // workerd CompiledWasm (no runtime codegen)
  ref: "main",                      // one branch == one keyspace
  author: "bot <bot@example.com>",  // optional defaults; per-write options win
  // auth: "user:pass",             // explicit Authorization (URL userinfo also works)
  // store: myStore,                // default memoryStore(); custom: {get,put,getRef,putRef,heads}
});
await git.pull(); // optional warmup (full pull); reads work without it

await git.getMany(["some/path/README.md"]); // Map(path -> Uint8Array, missing skipped, auto-fetched)
await git.putMany({ "a.txt": "hi" }, "update greeting"); // -> commit sha
await git.list("docs/");        // [{path, oid}] key enumeration
await git.log(5);               // [{sha, tree, parents, author, message}], newest first
await git.version();            // local tip oid (null when empty)
await git.remoteVersion();      // remote tip oid, store untouched (throws on network error)
await git.push(); // fast-forward only; rejects on non-fast-forward (pull first)

// one-shot: pull latest, then return keys (pass { pull: { filter: "blob:none" } } for versions-without-bytes)
await git.sync(["README.md"]);

// optimistic concurrency: throws locally when the tip moved since you read it
const tip = await git.version();
await git.putMany({ "a.txt": "v2" }, "cas write", { parent: tip });
```

Instantiation is async (`WebAssembly.instantiate`, off-thread compile).

## Stores

Default is `memoryStore()` (zero FS — Workers/KV backends). Any backend works
via `{ get(hex){}, put(hex,loose){}, getRef(n){}, putRef(n,s){}, heads(){} }`
(e.g. SQLite/S3/R2/D1 adapters); point `open(url, { store })` at it:

```js
await git.putMany({ "src/new.zig": "..." }, "v2",
  { author: "Alice <a@ex.com>", committer: "CI <ci@ex.com>", time: 1755859200, timezone: "+0800" });
await git.push();
```

## Capability boundary (blob view <-> git terms, kept precise)

The facade hides git, but the wire is still git. This table states what the
underlying `want` / `have` negotiation, `delta` handling, and filters actually do.

| Blob capability | Git mechanism | Status |
| --- | --- | --- |
| Pull one version | `want <tip-oid>` (protocol v2 `fetch`, single ref tip per call) | Supported |
| Push only new versions | `have` exclusion: `collectObjects` skips everything reachable from the remote tip (`old` oid, or all advertised refs for a new branch) | Supported (push side) |
| Incremental pull bandwidth | `have` negotiation is **not** sent on pull (v2 `fetch` is `want`-only, stateless); savings come from server-side pack `delta` + local cached-tip short-circuit (`pull` returns `{cached:true}` when `want` is already stored) | Partial: no `have` lines on pull |
| Small transfer of similar blobs | `ofs-delta` + `ref-delta` decode (`wasm_delta_apply`), incl. thin-pack bases already in local store | Decode supported |
| Small upload of similar blobs | `delta` encode on push | **Not supported** — push sends full objects (server re-deltifies on `gc`) |
| Skip bytes, keep versions | `filter blob:none` / `blob:limit=<n>[kmg]` / `tree:0` / `object:type=` / `combine:+` | Supported both sides; `getMany` auto-fetches missing blobs on demand (`want=<blob-oid>`, byte-equal to full fetch) |
| Single-file download | structure pull (`blob:none`) + `want=<blob-oid>` promisor roundtrip | Supported via `getMany` (unknown paths cost zero RTT; needs `uploadpack.allowTipSHA1InWant` on self-hosted servers, GitHub OK) |
| Batch multi-file download | `want=[oid...]` multi-want single pack | Supported via `getMany` (one roundtrip for all missing blobs) |
| Key enumeration | tree walk (local, post-tip) | Supported via `list(prefix)` |
| Remote version probe | `ls-refs` filtered to one ref | Supported via `remoteVersion()` (no store writes; throws on network error) |
| Optimistic concurrency | `putMany(..., { parent })` throws locally on tip mismatch | Supported (no extra RTT; `push` still rejects non-fast-forward as backstop) |
| Shallow history | `shallow` / `deepen` / `deepen-since` / `deepen-not` | **Not supported** (client never sends `deepen`) |
| Delete a key | tree-entry removal in `wasm_commit` | **Not supported** — `write` only upserts; full history retained |
| Concurrent writers | merge / conflict resolution | **None** — last-writer-wins; `push` rejects non-fast-forward, caller re-pulls and rewrites |
| Single huge blob | wasm 4MB arena per call, whole-pack `arrayBuffer` in JS | No chunked storage; blobs approaching MBs may hit `wasm_alloc` / Worker memory limits |
| Tags / notes / LFS / submodules | `tag` objects traversable; `gitlink` entries skipped on push; no LFS/notes protocol | Tags readable by oid; LFS/notes unsupported |
| Platform ABIs | `fetch`, `CompressionStream`/`DecompressionStream`, `crypto.subtle`, `TextEncoder/Decoder` | Required in browser/Worker (no polyfill bundled) |
| v1-only servers | upload-pack discovery without `version 2` (e.g. 腾讯工蜂, verified live) | `fetch`/`lsRemote` refuse loudly (`server lacks protocol v2`); `push` (v1 receive-pack) works — probe branch pushed, `cat-file` byte-exact, branch deleted |

## Internals

Division of labor: **protocol weight lifting in wasm** (`wasm_get` walks
commit→tree→blob; `wasm_commit` stores blobs, rebuilds affected trees with
git-correct sort), **IO + platform ABIs in JS** (`fetch`, compression,
`crypto.subtle`, pluggable store). Storage goes through `host_get_object` /
`host_put_object` callbacks (in-memory by default; any
`{get,put,getRef,putRef,heads}` backend). Verified against real `git`:
`log`/`ls-tree`/`cat-file`/`fsck --strict` all clean.

## Low-level WASM exports

Protocol framing/parsing: `wasm_handle_discovery`, `wasm_parse_filter`, `wasm_should_omit`,
`wasm_pktline_encode`, `wasm_build_lsrefs`, `wasm_build_fetch`, `wasm_decode_pack_header`,
`wasm_list_refs`/`wasm_find_ref`, `wasm_pack_begin|add|end`, `wasm_parse_report_status`,
`wasm_inflate_one`, `wasm_delta_apply`, plus `wasm_get`/`wasm_commit[2]` and `wasm_alloc/reset`.
See `tests/server.mjs` for a working server and `src/host/portable.mjs` for the portable client.

## Build & test

```bash
./scripts/fetch-deps.sh     # vendor zig 0.16.0 into ./third_party (or use system zig)
./tests/run.sh              # zig unit + wasm/filter/pull/push/remote e2e (pull: worker-like, delta+filter, git-verified)
PORT=3002 ./scripts/e2e.sh  # smart HTTP e2e: clone/push/fetch/partial clone (real git client)
```

## Versioning & release flow

SemVer. To cut a release:

1. Update `version` in `build.zig.zon`
2. Add a section to `CHANGELOG.md`
3. `git tag vX.Y.Z && git push origin main vX.Y.Z`

CI runs the full test suite on every push/PR. Tagging triggers the release workflow: build → bundle JS (pinned esbuild, no repo deps) → test → publish `zig_wasm_git.wasm` + `zig_wasm_git.portable.mjs` (+`SHA256SUMS`) to GitHub Releases.

## Known limits (see capability boundary above for the full `want`/`have`/`delta` account)

- `putMany` upserts only — no key deletion yet
- No merge: concurrent `push` to the same tip rejects; re-pull and rewrite
- Pull sends no `have` lines (v2 `want`-only); incremental bandwidth relies on server-side `delta` + cached-tip short-circuit
- Push sends full objects, no `delta` encode (server re-deltifies on `gc`)
- `blob:limit` checkout omits big blobs; `getMany` fetches them on demand
- No `shallow`/`deepen`/`notes`/`LFS`, no chunked storage (4MB wasm arena per call)
- Test-only server (`tests/server.mjs`) shells out to `git`; the client chain never does

## License

Apache-2.0.
