# zig-wasm-git

[![CI](https://github.com/est/zig-wasm-git/actions/workflows/ci.yml/badge.svg)](https://github.com/est/zig-wasm-git/actions/workflows/ci.yml)

git engine without `fs` nor `git` command. WASM+JS that speaks directly to any git http. Inspired by [Cloudflare Artifacts](https://blog.cloudflare.com/artifacts-git-for-agents-beta/):

> The entire git protocol engine is written in pure Zig (no libc), compiled to a ~100KB WASM binary ... It implements SHA-1, zlib inflate/deflate, delta encoding/decoding, pack parsing, and the full git smart HTTP protocol — all from scratch, with zero external dependencies.

This repo is a minimal reproduction focused on **read/write a git remote as a versioned blob store, not a dev workspace.**

One branch == one keyspace (`path -> bytes`), one commit == one version.

There is no workdir, no merge, no checkout — just `read` / `write` / `fetch` / `push`.

## Install

Requires **Node 22.3+**, or any runtime with `fetch`, `CompressionStream` and
`crypto.subtle` (browsers, Cloudflare Workers, Deno, Bun).

> Node 22.3 is the floor because the default wasm lookup reads the file next to
> the JS module via `process.getBuiltinModule`, which does not exist earlier. On
> older Node, pass the engine yourself — bytes, a `WebAssembly.Module`, or an
> `http(s)` url — and everything else works unchanged.

### npm

```bash
npm install zig-wasm-git
```

```js
import { RemoteGit } from "zig-wasm-git"; // TypeScript types included

const git = await RemoteGit.open("https://git.example.com/team/docs.git");
```

No build step, no `wasm` option: the package ships the engine next to the JS,
so `open()` finds it on its own. Bundlers that want the binary as an asset can
import it explicitly:

```js
import wasmUrl from "zig-wasm-git/wasm?url"; // vite
const git = await RemoteGit.open(url, { wasm: wasmUrl });
```

### GitHub releases (no package manager)

Grab the prebuilt artefacts — no toolchain needed:

```bash
curl -LO https://github.com/est/zig-wasm-git/releases/latest/download/zig_wasm_git.wasm
curl -LO https://github.com/est/zig-wasm-git/releases/latest/download/zig_wasm_git.portable.mjs
```

Each release ships fixed-name files + `SHA256SUMS`, built by CI from the tagged
commit (pin a version via the per-tag download path):

- `zig_wasm_git.wasm` — the protocol engine (~65KB)
- `zig_wasm_git.portable.mjs` — single-file JS for browser/CF Worker/Node (`RemoteGit` + `memoryStore`)

## Quick start

```js
import { RemoteGit } from "zig-wasm-git";

const git = await RemoteGit.open("https://user:token@git.example.com/team/docs.git", {
  ref: "main",
});

await git.putMany({ "notes/hello.md": "# hello\n" }, "add hello"); // -> commit sha
await git.push();                                                  // fast-forward only

const blobs = await git.getMany(["notes/hello.md"]);
console.log(new TextDecoder().decode(blobs.get("notes/hello.md"))); // -> "# hello\n"
```

## What you get

- A **~65KB** `wasm32-freestanding ReleaseSmall` binary with no libc, importing
  only `env.host_*` — SHA-1, zlib inflate/deflate, pack v2 (incl. ofs/ref
  delta), delta apply, pkt-line, and smart HTTP (`v1` + `v2 ls-refs/fetch=filter`
  + receive-pack + upload-pack clients), all in Zig.
- A **small async JS API** on top. `fetch`, `CompressionStream`,
  `crypto.subtle` and a pluggable store are the only platform dependencies, so
  the same JS runs in Node, browsers and Workers with no `node:` imports.
- **Fails loudly.** Operational failures throw `GitError` (`kind: "io"` for
  transport, `"protocol"` for server refusals); programmer mistakes throw
  `TypeError`. A network failure is never reported as "key not found"
  ([Errors](#errors)).

## API

`RemoteGit` is the whole API. Always construct it with `await RemoteGit.open()`
— instantiation is async, so it is a factory, not a constructor. Async methods
that touch wasm share one queue (single shared memory); `version()`/`log()`
are local and skip it.

```js
const git = await RemoteGit.open(url, {
  ref: "main",                     // one branch == one keyspace
  // auth: "Bearer ghp_xxx",        // see Authentication
  // store: myStore,                // default memoryStore(); must be SYNCHRONOUS
  // wasm: ...,                     // see "Where the wasm comes from"
});
```

| method | returns | notes |
| --- | --- | --- |
| `getMany(paths, opts?)` | `Map(path -> bytes)` | `paths` is an array. Missing keys are **skipped**, not errors. May hit the network — see [Reads can touch the network](#reads-can-touch-the-network) |
| `putMany(entries, msg?, parent?)` | commit sha | one version (a commit) on the current tip. Upsert only, no delete. `parent` oid (or `{ parent }`) for CAS |
| `list(prefix?, opts?)` | `[{path, oid}]` | key enumeration. `""` (default) lists everything |
| `log(limit = 10)` | `[{sha, tree, parents, author, message}]` | newest first, local only |
| `version()` | `string \| null` | local tip oid; `null` when the keyspace is empty. Never hits the network |
| `remoteVersion()` | `string \| null` | remote tip oid, store untouched. Throws on network error |
| `pull(opts?)` | `PullResult` | refresh from the remote. `{ filter: "blob:none" }` for versions-without-bytes |
| `push()` | `PushResult` | fast-forward only; rejects on non-fast-forward |

### Read and write

```js
// Reads
await git.getMany(["some/path/README.md"]);         // Map(path -> Uint8Array)
await git.getMany(["config.json"], { local: true }); // cache-only, never any I/O

// Writes. Keys are relative paths: no empty segment, no `.` / `..` / `.git`; a
// malformed key throws TypeError rather than being normalized. Content is a
// string or Uint8Array/ArrayBuffer — anything else throws TypeError
// rather than being stored as "[object Object]".
await git.putMany({ "a.txt": "hi" }, "update greeting"); // -> commit sha
```

A transport failure throws instead of returning a partial Map, so `map.size`
is not a health check.

**Optimistic concurrency.** `putMany(..., { parent })` throws `CAS_MISMATCH`
when the tip moved since you read it, at no extra roundtrip:

```js
const tip = git.version(); // sync, local only; null when the keyspace is empty
if (tip) await git.putMany({ "a.txt": "v2" }, "cas write", { parent: tip });
```

Check `tip` for null — a null parent means "no check", which would turn a CAS
write into an unguarded one.

## Authentication

`auth` is a raw `Authorization` header value. Credentials in the URL work too:
they are sent as `Basic` and stripped from the request URL (this also works
around runtimes that drop URL userinfo, notably workerd).

```js
// 1. in the URL — simplest, and the credentials never reach the URL on the wire
await RemoteGit.open("https://user:token@git.example.com/team/docs.git");

// 2. a raw header value — tokens, Basic you built yourself
await RemoteGit.open(url, { auth: "Bearer ghp_xxx" });
await RemoteGit.open(url, { auth: `Basic ${btoa("user:token")}` });
```

**In the browser, the git server must send CORS headers** for both
`/info/refs?service=git-upload-pack` and the `POST /git-upload-pack`. GitHub
and GitLab do not serve smart-HTTP endpoints to arbitrary browser origins, so
browser use usually means going through a same-origin proxy. Workers have no
CORS restriction. If a request fails with `NETWORK` and the console mentions
CORS, that is why.

## Custom store

Objects live behind a four-method interface, in memory by default:

```js
const git = await RemoteGit.open(url, { store: myStore });
// { get(hex), put(hex, loose), getRef(name), putRef(name, sha) }
```

**A custom store must be synchronous.** It is called from wasm host callbacks
that cannot await, so a Promise-returning store would write commits it cannot
read back — a silent data-loss failure, not an error. `open()` probes the store
and throws `TypeError` if the contract is broken.

That means you cannot wrap an inherently async backend (IndexedDB, D1, R2)
directly. Buffer in memory and flush, or prehydrate before `open()`.

## Where the wasm comes from

`{ wasm }` accepts, in order of convenience:

| you pass | how it loads | use when |
| --- | --- | --- |
| nothing | `zig_wasm_git.wasm` **next to `portable.mjs`** | npm install, or a release pair kept in one directory |
| `"/path/to.wasm"` | `fs.readFileSync` (Node 22.3+ only) | a checkout — the built wasm is at `zig-out/bin/zig_wasm_git.wasm` |
| `"https://…/x.wasm"` | `fetch` | browsers / Workers, wasm served over HTTP |
| bytes / `ArrayBuffer` | passed straight to `instantiate` | you already fetched or embedded it |
| `WebAssembly.Module` | instantiated, no codegen | workerd `CompiledWasm` |

Omitting `wasm` **in a clone of this repo** fails with a raw filesystem error:

```
Error: ENOENT: no such file or directory, open '.../src/host/zig_wasm_git.wasm'
```

That is not a bug in the path — the file simply is not there. The built wasm
lands in `zig-out/`, so pass it:

```js
const git = await RemoteGit.open(url, { wasm: "zig-out/bin/zig_wasm_git.wasm" });
```

On a runtime with no filesystem *and* no reachable default (Node before 22.3,
workerd), the default location is unreachable and `open()` says so with
`TypeError` rather than a misleading `io/NETWORK` error.

## Reads can touch the network

`getMany` and `list` are reads, but on a cold store they do I/O:

| situation | what happens |
| --- | --- |
| no tip cached (cold store) | bootstrap: a `blob:none` pull for structure only, then continue |
| key in the tree, blob not cached | one `want=[oids]` roundtrip for all such keys |
| key not in the tree at all | **zero** requests — skipped |
| `pull()` already called | local store only, no requests |

So "read" is not "offline". In a serverless or Worker context the first read of
each instance costs a request. Pass `{ local: true }` when the answer must come
from cache — no bootstrap, no on-demand fetch, and a cache miss stays a cheap
miss:

```js
await git.getMany(["config.json"], { local: true }); // never any I/O
await git.list("", { local: true });                 // [] if the tip isn't cached
```

## Memory

Each instance holds a wasm linear memory of roughly 5MB (a 4MB arena plus
growth) for its lifetime — fine for a long-lived process, worth knowing in a
serverless handler or a Worker that creates instances per request.

**The store itself never shrinks.** It is append-only: every version you write
and every object you pull stays resident, because git history is the point.
A custom `store` is where you add an eviction policy (TTL, LRU, size cap) if a
long-lived process needs one — `memoryStore()` has none.

## Errors

Two kinds, one import. Branch on `.kind`, never on the message text:

```js
import { GitError } from "zig-wasm-git";

try {
  await git.push();
} catch (e) {
  if (GitError.isIO(e)) retryLater(e.status); // NETWORK or HTTP; .status is set for HTTP
  else if (GitError.isProtocol(e, "NON_FAST_FORWARD")) { /* pull, then rewrite */ }
  else if (GitError.isProtocol(e, "CAS_MISMATCH")) { /* someone else wrote; re-read */ }
  else throw e; // TypeError / Error: fix the code, don't retry
}
```

| you write | it means |
| --- | --- |
| `GitError.isIO(e)` | transport failed (`NETWORK` / `HTTP`) — retry later |
| `GitError.isProtocol(e)` | server refused (`CAS_MISMATCH`, `NON_FAST_FORWARD`, `PUSH_REJECTED`, `UNPACK_FAILED`, `NO_V2`, `NO_REMOTE_REF`, `NO_SUCH_OBJECT`, `PROTOCOL_ERROR`) — fix the request |
| `GitError.is(e)` | either kind |

Programmer mistakes are **not** `GitError` on purpose — catching them as
"retryable" would loop forever on a bug:

| thrown as | when |
| --- | --- |
| `TypeError` | bad key, bad arg, bad store (missing methods / async), unresolvable local ref, wasm path unreadable on this runtime |
| `Error` | internal invariant (wasm failure, corrupt local store) — report a bug |

A missing key stays a skip and a transport failure stays a throw — never
mistake one for the other.

## Limits

- **No delete.** `putMany` upserts; there is no way to remove a key, and full history is retained.
- **No merge.** `push` is fast-forward only. On `NON_FAST_FORWARD`, pull and rewrite — last writer
  wins, and nobody merges for you.
- **A custom store must be synchronous**, so it cannot wrap IndexedDB / D1 / R2 directly
  ([Custom store](#custom-store)).
- **The store is append-only** with no eviction, so a reused instance grows monotonically. Bounding the store is the job of a custom store.
- **Blobs are held whole in memory** — a 4MB wasm arena per call, one `arrayBuffer` per pack. Keys
  approaching megabytes may hit `WASM_ALLOC`.
- **Pull sends no `have` lines** (protocol v2 `fetch` is `want`-only), so incremental bandwidth
  relies on server-side `delta` plus a cached-tip short-circuit. **Push sends full objects** — no
  `delta` encode; the server re-deltifies on `gc`.
- **No `shallow` / `deepen` / `notes` / `LFS` / submodules**, and no `AbortSignal` or timeout — a
  hung request cannot be cancelled.
- **v1-only servers**  can be pushed to but not read from: `pull` and
  `remoteVersion` refuse with `NO_V2`.
- **The low-level wasm exports are untyped and unstable.** The shipped declarations cover
  `RemoteGit` only; use `RemoteGit`.

The protocol-level detail behind each of these — which `want`/`have`/`delta` mechanism is used, what
each filter does, and the module map — is in [docs/CAPABILITIES.md](docs/CAPABILITIES.md). Building,
testing and the release flow are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0.
