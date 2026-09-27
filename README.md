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

- `zig_wasm_git.wasm` — the protocol engine (~69KB)
- `zig_wasm_git.portable.mjs` — single-file JS for browser/CF Worker/Node (`RemoteGit` + `memoryStore`)

## Quick start

```js
import { RemoteGit } from "zig-wasm-git";

const git = await RemoteGit.open("https://user:token@git.example.com/team/docs.git", {
  ref: "main",
  author: "bot <bot@example.com>",
});

await git.putMany({ "notes/hello.md": "# hello\n" }, "add hello"); // -> commit sha
await git.push();                                                  // fast-forward only

const blobs = await git.getMany(["notes/hello.md"], { as: "text" });
console.log(blobs.get("notes/hello.md")); // -> "# hello\n"

await git.close(); // release the ~5MB wasm arena
```

## What you get

- A **~69KB** `wasm32-freestanding ReleaseSmall` binary with no libc, importing
  only `env.host_*` — SHA-1, zlib inflate/deflate, pack v2 (incl. ofs/ref
  delta), delta apply, pkt-line, and smart HTTP (`v1` + `v2 ls-refs/fetch=filter`
  + receive-pack + upload-pack clients), all in Zig.
- A **small async JS API** on top. `fetch`, `CompressionStream`,
  `crypto.subtle` and a pluggable store are the only platform dependencies, so
  the same JS runs in Node, browsers and Workers with no `node:` imports.
- **Fails loudly.** Every throw is a `GitError` with a stable `.code`, and
  a network or HTTP failure is never reported as "key not found"
  ([Errors](#errors)).

## API

`RemoteGit` is the whole API. Always construct it with `await RemoteGit.open()`
— instantiation is async, so it is a factory, not a constructor. Every method is
async and runs through one queue, so they share a single ordering.

```js
const git = await RemoteGit.open(url, {
  ref: "main",                     // one branch == one keyspace
  author: "bot <bot@example.com>", // default author; per-write options win
  // auth: "user:token",            // see Authentication
  // store: myStore,                // default memoryStore(); must be SYNCHRONOUS
  // wasm: ...,                     // see "Where the wasm comes from"
});
```

| method | returns | notes |
| --- | --- | --- |
| `getMany(paths, opts?)` | `Map(path -> bytes)` | `paths` is an array or one string. Missing keys are **skipped**, not errors. May hit the network — see [Reads can touch the network](#reads-can-touch-the-network) |
| `putMany(entries, msg?, opts?)` | commit sha | one version (a commit) on the current tip. Upsert only, no delete. `{ parent }` for CAS |
| `list(prefix?, opts?)` | `[{path, oid}]` | key enumeration. `""` (default) lists everything |
| `log(limit = 10)` | `[{sha, tree, parents, author, message}]` | newest first, local only |
| `version()` | `string \| null` | local tip oid; `null` when the keyspace is empty. Never hits the network |
| `remoteVersion()` | `string \| null` | remote tip oid, store untouched. Throws on network error |
| `pull(opts?)` | `PullResult` | refresh from the remote. `{ filter: "blob:none" }` for versions-without-bytes |
| `push()` | `PushResult` | fast-forward only; rejects on non-fast-forward |
| `sync(paths, opts?)` | `Map(path -> bytes)` | one-shot: pull latest, then read |
| `close()` | — | releases the wasm instance. Idempotent. Methods after throw `CLOSED` |

### Read and write

```js
// Reads
await git.getMany(["some/path/README.md"]);         // Map(path -> Uint8Array)
await git.getMany("a.txt");                         // a single key works too
await git.getMany(["a.txt"], { as: "text" });       // Map(path -> string)
await git.getMany(["config.json"], { local: true }); // cache-only, never any I/O

// Writes. Keys are relative paths: no empty segment, no `.` / `..` / `.git`; a
// malformed key is rejected (BAD_KEY) rather than normalized. Content is a
// string or Uint8Array/ArrayBuffer — anything else is rejected with BAD_ARG
// rather than stored as "[object Object]".
await git.putMany({ "a.txt": "hi" }, "update greeting"); // -> commit sha
```

A missing key is simply absent from the Map, so `map.size` is not a health
check. A transport failure throws instead.

**Optimistic concurrency.** `putMany(..., { parent })` throws `CAS_MISMATCH`
when the tip moved since you read it, at no extra roundtrip:

```js
const tip = await git.version();
if (tip) await git.putMany({ "a.txt": "v2" }, "cas write", { parent: tip });
```

Check `tip` for null — a null parent means "no check", which would turn a CAS
write into an unguarded one.

## Authentication

Credentials can travel three ways. All of them end up as an `Authorization`
header; the URL-credential form is also stripped from the request URL, which
keeps tokens out of downstream logs and works around runtimes that drop URL
userinfo (notably workerd).

```js
// 1. in the URL — simplest, and the credentials never reach the URL on the wire
await RemoteGit.open("https://user:token@git.example.com/team/docs.git");

// 2. explicit "user:pass" — sent as Basic
await RemoteGit.open(url, { auth: "user:token" });

// 3. a raw header value — tokens, Basic you built yourself
await RemoteGit.open(url, { auth: "Bearer ghp_xxx" });
```

A value containing whitespace is sent verbatim; `user:pass` is the only shape
that gets encoded into Basic for you.

**In the browser, the git server must send CORS headers** for both
`/info/refs?service=git-upload-pack` and the `POST /git-upload-pack`. GitHub
and GitLab do not serve smart-HTTP endpoints to arbitrary browser origins, so
browser use usually means going through a same-origin proxy. Workers have no
CORS restriction. If a request fails with `NETWORK` and the console mentions
CORS, that is why.

## Custom store

Objects live behind a five-method interface, in memory by default:

```js
const git = await RemoteGit.open(url, { store: myStore });
// { get(hex) -> Uint8Array|null, put(hex, loose), getRef(name), putRef(name, sha), heads() }
```

**A custom store must be synchronous.** It is called from wasm host callbacks
that cannot await, so a Promise-returning store would write commits it cannot
read back — a silent data-loss failure, not an error. `open()` probes the store
and throws `BAD_STORE` if the contract is broken.

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
`BAD_ARG` rather than a misleading `NETWORK` error.

## Reads can touch the network

`getMany`, `list` and `sync` are reads, but on a cold store they do I/O:

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

## Releasing memory

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

## Errors

Every throw is a `GitError` with a stable `.code`. Branch on the code, never on
the message text. One import covers the class and its codes:

```js
import { GitError } from "zig-wasm-git";

try {
  await git.putMany({ "a.txt": "v2" }, "cas write", { parent: tip });
} catch (e) {
  if (GitError.is(e, "CAS_MISMATCH")) { /* someone else wrote; re-read */ }
  else if (GitError.is(e, "NON_FAST_FORWARD")) { /* pull, then rewrite */ }
  else if (GitError.is(e, "NETWORK", "HTTP")) {
    retryLater(e.status);          // .status is set for HTTP
  } else throw e;
}
```

`GitError.is` is variadic, and that is the whole API — no separate `anyOf`:

| you write | it means | `.code` narrows to |
| --- | --- | --- |
| `GitError.is(e)` | is this one of ours? | the full union |
| `GitError.is(e, "NETWORK")` | that one code | `"NETWORK"` |
| `GitError.is(e, "NETWORK", "HTTP")` | any of these | `"NETWORK" \| "HTTP"` |

In TypeScript that narrowing is real, so `e.status` and `e.cause` stay typed
and the code is checked against the real list:

```ts
if (GitError.is(e, "HTTP")) console.log(e.status);   // number | undefined
if (GitError.is(e, "TYPO")) { }                      // compile error
```

Three ways to handle errors, in the order you are likely to need them:

```js
// 1. one known code — plain equality is fine
if (e instanceof GitError && e.code === "CLOSED") reopen();

// 2. a set of codes — GitError.is
if (GitError.is(e, "NETWORK", "HTTP")) retryLater();

// 3. every code — switch, with `never` so a new code fails the build
if (e instanceof GitError) {
  switch (e.code) {
    case "CAS_MISMATCH": return reRead();
    case "NON_FAST_FORWARD": return pullAndRewrite();
    default: { const _exhaustive: never = e; throw e; }
  }
}
```

`GitError.is` also recognizes a `GitError` thrown by a *different copy* of this
module — the npm package and the single-file release bundle are separate
classes, and an app can load both. `instanceof` cannot do that, which is the
one place the two differ.

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
| `BAD_ARG` | an argument has the wrong shape (e.g. `getMany(42)`, non-string key) or cannot work on this runtime |
| `CLOSED` | the instance was never `open()`ed, or `close()` already ran |
| `CAS_MISMATCH` | `putMany` `parent` != current tip |
| `NON_FAST_FORWARD` | push target is not a descendant of the remote tip |
| `PUSH_REJECTED` / `UNPACK_FAILED` | server refused the update / could not unpack |
| `WASM_ALLOC` / `WASM_RC` / `BAD_TREE_PATH` | 4MB arena exhausted / wasm error / wasm refused a path |

The distinction that matters most: **a missing key is a skip, a transport
failure is a throw.** A key genuinely absent from the keyspace has no entry in
the `Map`; a dropped connection raises `NETWORK` or `HTTP`. Only a key that is
really not there reads as "not there".

## Limits

- **No delete.** `putMany` upserts; there is no way to remove a key, and full history is retained.
- **No merge.** `push` is fast-forward only. On `NON_FAST_FORWARD`, pull and rewrite — last writer
  wins, and nobody merges for you.
- **A custom store must be synchronous**, so it cannot wrap IndexedDB / D1 / R2 directly
  ([Custom store](#custom-store)).
- **The store is append-only** with no eviction, so a reused instance grows monotonically. `close()`
  frees the wasm arena; bounding the store is the job of a custom store.
- **Blobs are held whole in memory** — a 4MB wasm arena per call, one `arrayBuffer` per pack. Keys
  approaching megabytes may hit `WASM_ALLOC`.
- **Pull sends no `have` lines** (protocol v2 `fetch` is `want`-only), so incremental bandwidth
  relies on server-side `delta` plus a cached-tip short-circuit. **Push sends full objects** — no
  `delta` encode; the server re-deltifies on `gc`.
- **No `shallow` / `deepen` / `notes` / `LFS` / submodules**, and no `AbortSignal` or timeout — a
  hung request cannot be cancelled. `close()` waits for in-flight work, it does not cancel it.
- **v1-only servers**  can be pushed to but not read from: `pull` and
  `remoteVersion` refuse with `NO_V2`.
- **The low-level wasm exports are untyped and unstable.** The shipped declarations cover
  `RemoteGit` only; use `RemoteGit`.

The protocol-level detail behind each of these — which `want`/`have`/`delta` mechanism is used, what
each filter does, and the module map — is in [docs/CAPABILITIES.md](docs/CAPABILITIES.md). Building,
testing and the release flow are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0.
