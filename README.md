# zig-wasm-git

[![CI](https://github.com/est/zig-wasm-git/actions/workflows/ci.yml/badge.svg)](https://github.com/est/zig-wasm-git/actions/workflows/ci.yml)

git engine without `fs` nor `git` command. WASM+JS that speaks directly to any git http. Inspired by [Cloudflare Artifacts](https://blog.cloudflare.com/artifacts-git-for-agents-beta/):

> The entire git protocol engine is written in pure Zig (no libc), compiled to a ~100KB WASM binary ... It implements SHA-1, zlib inflate/deflate, delta encoding/decoding, pack parsing, and the full git smart HTTP protocol — all from scratch, with zero external dependencies.

This repo is a minimal reproduction focused on **read/write a git remote as a versioned blob store, not a dev workspace.**
   
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
- **Fails loudly**: every throw is a `RemoteGitError` with a stable `.code`; network/HTTP errors are never reported as "key not found" (see [Errors](#errors))

## Blob-store API (the only API)

One branch is one keyspace. Missing keys are skipped, not errors. Each `putMany`
appends a version (a commit) on the current tip; `push` moves the remote tip
and rejects on non-fast-forward (last-writer-wins, no merge). Every method is
async, and they all run through one queue so they share a single ordering —
including `log()`, which is local but queued anyway. Single keys go through the
Many variants directly (`getMany("a.txt")`).

Four things fail loudly instead of returning something plausible:

- **Network / HTTP errors are thrown**, never reported as an empty result. A
  dropped connection must not read as "this key does not exist". Only a key
  genuinely absent from the keyspace is skipped.
- **A custom `store` must be synchronous** (`{get,put,getRef,putRef,heads}`).
  It is called from wasm host callbacks that cannot await, so a
  Promise-returning store would write commits it cannot read back. `open()`
  probes it and throws `BAD_STORE`.
- **Keys are validated** before anything is written: relative paths only, no
  empty segment, no `.` / `..` / `.git`. A malformed key is rejected
  (`BAD_KEY`) rather than normalized, because the tree layer would turn `""`
  or `"/a.txt"` into an unnamed entry that silently overwrites a sibling key in
  the same batch.

Content is a `string` or `Uint8Array`/`ArrayBuffer`; anything else is rejected
with `BAD_ARG` rather than silently stored as `"[object Object]"`. On the read
side, `as: "text"` hands back strings instead of bytes, and a bare key string
works when you only want one:

```js
import { RemoteGit } from "./src/host/portable.mjs";

// { wasm }: string | Module | typed array | ArrayBuffer.
const git = await RemoteGit.open("https://user:pass@git.example.com/team/docs.git", {
  // wasm: "https://git.example.com/zig_wasm_git.wasm", // http(s) url (lib fetches),
  // wasm: "zig_wasm_git.wasm",    // Node path (read via process.getBuiltinModule)
  // wasm: WASM_MODULE,            // workerd CompiledWasm (no runtime codegen)
  //
  // Omitting `wasm` means "zig_wasm_git.wasm next to this module" — true for a
  // release pair kept together, but NOT for a clone of this repo (the built
  // wasm lands in zig-out/bin/). See "Where the wasm comes from" below.
  ref: "main",                      // one branch == one keyspace
  author: "bot <bot@example.com>",  // optional defaults; per-write options win
  // auth: "user:pass",             // explicit Authorization (URL userinfo also works)
  // store: myStore,                // default memoryStore(); custom: {get,put,getRef,putRef,heads}
  //                                 //   — must be SYNCHRONOUS (no Promises; see Errors)
});
await git.pull(); // optional warmup (full pull); reads work without it

// reads may hit the network (see "Reads can touch the network"); { local: false } is cache-only
await git.getMany(["some/path/README.md"]); // Map(path -> Uint8Array), missing skipped
await git.getMany("a.txt");        // a single key works too
await git.getMany(["a.txt"], { as: "text" }); // Map(path -> string) for text keys
await git.getMany(["a.txt"], { local: false }); // cache-only: no I/O at all
await git.putMany({ "a.txt": "hi" }, "update greeting"); // -> commit sha
await git.list("docs/");        // [{path, oid}] key enumeration
await git.list("docs/", { local: false }); // cache-only enumeration
await git.log(5);               // [{sha, tree, parents, author, message}], newest first
await git.version();            // local tip oid (null when empty)
await git.remoteVersion();      // remote tip oid, store untouched (throws on network error)
await git.push(); // fast-forward only; rejects on non-fast-forward (pull first)

// one-shot: pull latest, then return keys (pass { pull: { filter: "blob:none" } } for versions-without-bytes)
await git.sync(["README.md"]);

await git.close(); // release the wasm instance (~5MB arena) when done
git.closed;       // -> true

// keys are validated: relative paths, no empty segment, no . / .. / .git
await git.putMany({ "docs/a.md": "hi" }, "add a");   // -> commit sha

// optimistic concurrency: throws CAS_MISMATCH when the tip moved since you read it
const tip = await git.version();
await git.putMany({ "a.txt": "v2" }, "cas write", { parent: tip });
```

Instantiation is async (`WebAssembly.instantiate`, off-thread compile), so
`RemoteGit.open()` is a factory — always `await` it. The constructor is public
only so the class type-checks; an instance from `new RemoteGit(...)` has no wasm
and every method throws `CLOSED` with a pointer to `open()`.

### Where the wasm comes from

`{ wasm }` accepts, in order of convenience:

| you pass | how it loads | use when |
| --- | --- | --- |
| nothing | `zig_wasm_git.wasm` **next to `portable.mjs`** | you kept a release pair together (both files in one directory) |
| `"/path/to.wasm"` | `fs.readFileSync` (Node only) | a checkout — the built wasm is at `zig-out/bin/zig_wasm_git.wasm` |
| `"https://…/x.wasm"` | `fetch` | browsers / Workers, wasm served over HTTP |
| bytes / `ArrayBuffer` | passed straight to `instantiate` | you already fetched or embedded it |
| `WebAssembly.Module` | instantiated, no codegen | workerd `CompiledWasm` |

Omitting `wasm` outside a release pair fails with a raw filesystem error:

```
Error: ENOENT: no such file or directory, open '.../src/host/zig_wasm_git.wasm'
```

That is not a bug in the path — it means the file simply is not there. From a
clone of this repo, pass the built path:

```js
const git = await RemoteGit.open(url, { wasm: "zig-out/bin/zig_wasm_git.wasm" });
```

### Reads can touch the network

`getMany`, `list` and `sync` are reads, but on a cold store they do I/O:

| situation | what happens |
| --- | --- |
| no tip cached (cold store) | bootstrap: a `blob:none` pull for structure only, then continue |
| key in the tree, blob not cached | one `want=[oids]` roundtrip for all such keys |
| key not in the tree at all | **zero** requests — skipped |
| `pull()` already called | local store only, no requests |

So "read" is not "offline". In a serverless or Worker context the first read of
each instance costs a request. Pass `{ local: false }` when the answer must come
from cache — no bootstrap, no on-demand fetch, and a cache miss stays a cheap
miss:

```js
await git.getMany(["config.json"], { local: false }); // never any I/O
await git.list("", { local: false });                 // [] if the tip isn't cached
```

### Releasing memory

Each instance holds a wasm linear memory of roughly 5MB (a 4MB arena plus
growth). That is fine for a long-lived process and worth reclaiming in a
serverless handler or a Worker that creates instances per request:

```js
const git = await RemoteGit.open(url, opts);
try {
  await git.putMany({ "a.txt": "hi" }, "commit");
} finally {
  await git.close(); // waits for in-flight work, then frees the instance
}
```

`close()` is idempotent and does **not** clear the store — pass a throwaway
`store` if you want those objects collected too. After `close()`, methods throw
`CLOSED`.

**The store itself never shrinks.** It is append-only: every version you write
and every object you pull stays resident, because git history is the point.
A custom `store` is where you add an eviction policy (TTL, LRU, size cap) if a
long-lived process needs one — `memoryStore()` has none, so bound its lifetime
with `close()` rather than reusing one instance forever.


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
| Key enumeration | tree walk (local, post-tip) | Supported via `list(prefix)`; `list(prefix, {local:false})` for cache-only |
| Remote version probe | `ls-refs` filtered to one ref | Supported via `remoteVersion()` (no store writes; throws on network error) |
| Optimistic concurrency | `putMany(..., { parent })` throws locally on tip mismatch | Supported (no extra RTT; `push` still rejects non-fast-forward as backstop) |
| Shallow history | `shallow` / `deepen` / `deepen-since` / `deepen-not` | **Not supported** (client never sends `deepen`) |
| Delete a key | tree-entry removal in `wasm_commit` | **Not supported** — `write` only upserts; full history retained |
| Concurrent writers | merge / conflict resolution | **None** — last-writer-wins; `push` rejects non-fast-forward, caller re-pulls and rewrites |
| Single huge blob | wasm 4MB arena per call, whole-pack `arrayBuffer` in JS | No chunked storage; blobs approaching MBs may hit `wasm_alloc` / Worker memory limits |
| Tags / notes / LFS / submodules | `tag` objects traversable; `gitlink` entries skipped on push; no LFS/notes protocol | Tags readable by oid; LFS/notes unsupported |
| Platform ABIs | `fetch`, `CompressionStream`/`DecompressionStream`, `crypto.subtle`, `TextEncoder/Decoder` | Required in browser/Worker (no polyfill bundled) |
| v1-only servers | upload-pack discovery without `version 2` | `fetch`/`lsRemote` refuse loudly (`server lacks protocol v2`); `push` (v1 receive-pack) works — probe branch pushed, `cat-file` byte-exact, branch deleted |

## Errors

Every throw is a `RemoteGitError` with a stable `.code` (and the original error
in `.cause` where one exists), so callers branch on the code rather than
matching message text:

```js
import { RemoteGit, ERR, isGitError } from "./src/host/portable.mjs";

try {
  await git.putMany({ "a.txt": "v2" }, "cas write", { parent: tip });
} catch (e) {
  if (isGitError(e, ERR.CAS_MISMATCH)) { /* someone else wrote; re-read */ }
  else if (isGitError(e, ERR.NON_FAST_FORWARD)) { /* pull, then rewrite */ }
  else if (isGitError(e, ERR.NETWORK) || isGitError(e, ERR.HTTP)) {
    retryLater(e.status);          // .status is set for HTTP
  } else throw e;
}
```

| code | raised when |
| --- | --- |
| `NETWORK` | `fetch` threw (offline, DNS, TLS, CORS) |
| `HTTP` | non-2xx response; see `.status` |
| `NO_V2` | server lacks protocol v2 (blocks `pull` / `lsRemote`; `push` still works) |
| `NO_REMOTE_REF` | ref/branch does not exist on the remote |
| `NO_SUCH_OBJECT` | server accepted a `want` but did not send the object (e.g. gc'd) — treated as a miss, not a failure |
| `BAD_STORE` | custom `store` is missing methods or returns Promises |
| `BAD_KEY` | a write key is not a valid relative path |
| `BAD_REF` | ref cannot be resolved in the local store |
| `BAD_ARG` | an argument has the wrong shape (e.g. `getMany(42)`, non-string key) |
| `CLOSED` | the instance was never `open()`ed, or `close()` already ran |
| `CAS_MISMATCH` | `putMany` `parent` != current tip |
| `NON_FAST_FORWARD` | push target is not a descendant of the remote tip |
| `PUSH_REJECTED` / `UNPACK_FAILED` | server refused the update / could not unpack |
| `WASM_ALLOC` / `WASM_RC` / `BAD_TREE_PATH` | 4MB arena exhausted / wasm error / wasm refused a path |

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
`wasm_commit[2]` returns `-14` for a path that cannot round-trip as a git tree
entry (empty segment, `.`/`..`/`.git`, NUL/backslash/control char) — checked
before any blob is stored, so a rejected batch has no side effects.
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
- No `AbortSignal` / timeout support — a hung request cannot be cancelled (`close()` waits for in-flight work, so it does not cancel it either)
- The store is append-only with no eviction: a reused instance grows monotonically. `close()` frees the wasm arena; bounding the store is the job of a custom `store`
- A custom `store` must be synchronous, so it cannot wrap an inherently async backend (IndexedDB, D1, R2) directly — buffer in memory or prehydrate
- No `package.json` / TypeScript declarations: install by downloading the two release files (or importing `src/host/portable.mjs` from a checkout)
- Test-only server (`tests/server.mjs`) shells out to `git`; the client chain never does

## License

Apache-2.0.
