# Capabilities & internals

Reference for people deciding whether `zig-wasm-git` fits, and for people
changing it. The [README](../README.md) covers the user-facing API; this file
covers what sits under it — the precise `want` / `have` / `delta` / filter
account per capability, the module internals, and the raw wasm exports.

## Capability boundary (blob view <-> git terms)

The facade hides git, but the wire is still git. This table states what the
underlying negotiation, delta handling and filters actually do.

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
| Key enumeration | tree walk (local, post-tip) | Supported via `list(prefix)`; `list(prefix, {local:true})` for cache-only |
| Remote version probe | `ls-refs` filtered to one ref | Supported via `remoteVersion()` (no store writes; throws on network error) |
| Optimistic concurrency | `putMany(..., { parent })` throws locally on tip mismatch | Supported (no extra RTT; `push` still rejects non-fast-forward as backstop) |
| Shallow history | `shallow` / `deepen` / `deepen-since` / `deepen-not` | **Not supported** (client never sends `deepen`) |
| Delete a key | tree-entry removal in `wasm_commit` | **Not supported** — `putMany` only upserts; full history retained |
| Concurrent writers | merge / conflict resolution | **None** — last-writer-wins; `push` rejects non-fast-forward, caller re-pulls and rewrites |
| Single huge blob | wasm 4MB arena per call, whole-pack `arrayBuffer` in JS | No chunked storage; blobs approaching MBs may hit `wasm_alloc` / Worker memory limits |
| Tags / notes / LFS / submodules | `tag` objects traversable; `gitlink` entries skipped on push; no LFS/notes protocol | Tags readable by oid; LFS/notes unsupported |
| Platform ABIs | `fetch`, `CompressionStream`/`DecompressionStream`, `crypto.subtle`, `TextEncoder/Decoder` | Required in browser/Worker (no polyfill bundled) |
| v1-only servers | upload-pack discovery without `version 2` | `fetch`/`lsRemote` refuse loudly (`server lacks protocol v2`); `push` (v1 receive-pack) works — probe branch pushed, `cat-file` byte-exact, branch deleted |

## Internals

Division of labor: **protocol weight lifting in wasm** (`wasm_get` walks
commit→tree→blob; `wasm_commit` stores blobs, rebuilds affected trees with
git-correct sort), **IO + platform ABIs in JS** (`fetch`, compression,
`crypto.subtle`, pluggable store). Storage goes through `host_get_object` /
`host_put_object` callbacks (in-memory by default; any
`{get,put,getRef,putRef,heads}` backend). Verified against real `git`:
`log`/`ls-tree`/`cat-file`/`fsck --strict` all clean.

| File | Role |
| --- | --- |
| `src/zig/root.zig` | test entry point; pulls in every module's unit tests |
| `src/zig/wasm.zig` | the `env.host_*` ABI surface: `wasm_get`, `wasm_commit2`, alloc/reset |
| `src/zig/{fetch,push,pack,delta,zlib,sha1,oid,object}.zig` | protocol v2 fetch, receive-pack push, pack v2 framing, delta apply, inflate, SHA-1, object encode/decode |
| `src/zig/{pktline,proto,filter,partial,enc}.zig` | pkt-line framing, wire shapes, filter parse/apply, negotiated-partial state, hex/base64 |
| `src/host/portable.mjs` | `RemoteGit` — the public API, all-async, one queue per instance |
| `src/host/sync.mjs` | fetch-into-store, `lsRemote`, `collectObjects`, TLV ref/status decoders |
| `src/host/utils.mjs` | errors (`GitError` + its codes), key validation, `memoryStore`, zlib, auth, loose/tree/commit parsing |

## Low-level WASM exports

Protocol framing/parsing: `wasm_handle_discovery`, `wasm_parse_filter`, `wasm_should_omit`,
`wasm_pktline_encode`, `wasm_build_lsrefs`, `wasm_build_fetch`, `wasm_decode_pack_header`,
`wasm_list_refs`/`wasm_find_ref`, `wasm_pack_begin|add|end`, `wasm_parse_report_status`,
`wasm_inflate_one`, `wasm_delta_apply`, plus `wasm_get`/`wasm_commit[2]` and `wasm_alloc/reset`.
`wasm_commit[2]` returns `-14` for a path that cannot round-trip as a git tree
entry (empty segment, `.`/`..`/`.git`, NUL/backslash/control char) — checked
before any blob is stored, so a rejected batch has no side effects.

These are untyped; the shipped declarations cover the `RemoteGit` API only.
They are an implementation surface, not a stable public API: nothing outside
`src/host/` should import them, and they may change in any release. Use
`RemoteGit` instead.

See `tests/server.mjs` for a working server and `src/host/portable.mjs` for the
portable client.
