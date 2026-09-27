# Changelog

Notable changes, written for people using the library. Follows
[Keep a Changelog](https://keepachangelog.com/); versions are [SemVer](https://semver.org/).

## [Unreleased]

### Breaking

- **One write path: `putMany` takes `null` deletes, `removeMany` is gone.**
  `putMany({ "a.txt": null }, msg)` deletes (missing keys are a no-op,
  empty dirs are pruned), so one commit can mix upserts and deletes
  atomically — previously impossible without two versions. Rename in one
  version: `putMany({ "old.txt": null, "new.txt": "hi" }, "rename")`.
- **`get` and `readAll` are gone; `getMany` is the only read.**
  A single key needs no wrapper: `getMany("a.txt")`. Small keyspaces are
  `list` + `getMany`, two calls.
- **`putMany` parent is `{ parent }` only.** A bare oid string throws
  `TypeError` instead of writing unguarded — a dropped brace fails loudly.
- **`GitError.is(e)` is gone.** Branch on `GitError.isIO(e)` /
  `GitError.isProtocol(e, ...codes)`; either matches exactly the errors of
  its kind.
- **Smaller engine (~60KB): server-side wasm helpers are out.**
  `wasm_handle_discovery`, `wasm_parse_filter`, `wasm_should_omit`,
  `wasm_pktline_encode` and `wasm_find_ref` no longer ship in the binary
  (`filter`/`partial`/`proto` stay unit-tested but unlinked). The export
  list is client-only: `wasm_get`/`wasm_commit`, pack build, fetch/ls-refs
  build, inflate, delta, ref/status parse.

### Fixed

- **Capacity failures are `TypeError` with the failing limit named.**
  Writes past the measured ceiling used to surface as a bare
  `Error: wasm_commit rc=-1` (the "report a bug" class). They now say
  whether one value (`~768KB` round-trip safe) or the whole batch
  (`~1MB` per `putMany`) overflowed and how to split.
  Reads loop key-by-key, so a `getMany` larger than the old ~1MB
  batch cap works as long as each blob fits.

## [1.7.0] — 2026-09-27

### Breaking

- **Errors are two kinds: `io` vs `protocol`. Usage mistakes throw `TypeError`.**
  `RemoteGitError` / `ERR` / `isGitError` are gone; one import remains:
  `GitError.isIO(e)` means "retry later" (`NETWORK` / `HTTP`, with `.status`
  on HTTP), `GitError.isProtocol(e, ...codes)` means "fix the request"
  (`CAS_MISMATCH`, `NON_FAST_FORWARD`, `PUSH_REJECTED`, `UNPACK_FAILED`,
  `NO_V2`, `NO_REMOTE_REF`, `NO_SUCH_OBJECT`, `PROTOCOL_ERROR`). Bad keys,
  bad args, oversize values, bad stores and never-`open`ed instances throw
  `TypeError` — don't catch them as retryable. Corrupt packs/sidebands from
  the server, previously bare `Error`, now throw `protocol/PROTOCOL_ERROR`,
  so `GitError.is(e)` catches every operational failure.

  ```js
  // before (1.6)
  import { isGitError, ERR } from "zig-wasm-git";
  if (isGitError(e, ERR.CAS_MISMATCH)) { ... }
  if (isGitError(e) && (e.code === ERR.NETWORK || e.code === ERR.HTTP)) { ... }

  // after
  import { GitError } from "zig-wasm-git";
  if (GitError.isProtocol(e, "CAS_MISMATCH")) { ... }
  if (GitError.isIO(e)) { ... }
  ```

- **Smaller surface: `close()`, `sync()` and per-write identity are gone.**
  Dropping the instance frees the ~5MB wasm arena, so `close()`/`closed`
  pulled no weight. `sync()` was redundant — `getMany` already bootstraps a
  cold store and batch-fetches missing blobs. Author/committer/time/timezone
  options are gone; every commit uses the fixed identity
  `zig-wasm-git <zig-wasm-git@localhost>`. The store is four methods
  (`{get, put, getRef, putRef}`); `heads()` and `dump?()` are removed.
- **`version()` is sync.** It never touched the network, so it no longer
  returns a `Promise`. Existing `await git.version()` keeps working (awaiting
  a string is a no-op); only `.then()` chains break.

### Added

- **`removeMany(paths, msg?, parent?)`** deletes keys as one version (commit).
  Missing keys are a no-op, empty dirs are pruned, history is retained like
  any other version. Same CAS contract as `putMany`.
- **`get(path, opts?)`** reads one key (`bytes | string | null`, `null` when
  absent) and **`readAll(prefix?, opts?)`** does `list` + batched `getMany`
  in one call. Both accept `{ as: "text" }` for UTF-8 decode, as `getMany` does.
- **`git.store` getter** exposes the backing store, for sharing across instances.
- **`pull()` accepts a bare filter string** (`pull("blob:none")` === `pull({ filter: "blob:none" })`).

### Fixed

- `GitError.is*` recognizes errors from another copy of the module (npm
  package next to the single-file bundle) via a `Symbol.for` brand instead
  of `instanceof`.
- A runtime without a filesystem (Node before 22.3) throws `TypeError` naming
  the missing capability — no longer a misleading `io/NETWORK`. `package.json`
  requires Node `>=22.3`, matching what the default wasm lookup needs.

### Changed

- **`push()` takes `{ fetchImpl }` only.** The old `Partial<PullOptions>`
  type implied a `filter` that push never sent.

## [1.6.0] — 2026-09-27

First release on npm: `npm install zig-wasm-git`. TypeScript types included.

### Breaking

- **A failed read now throws instead of returning nothing.** `getMany` and
  `list` used to swallow network errors and hand back an empty result, so a
  dropped connection was indistinguishable from "this key does not exist" —
  and `if (!result.size)` silently read a network failure as a cache miss.
  They now throw with a `code` you can branch on. If you want the old
  never-throw behaviour, pass `{ local: true }` for a cache-only read.
- **`new RemoteGit(url)` is no longer usable on its own.** Boot is async, so the
  constructor cannot load the engine; use `await RemoteGit.open(url)`. Calling a
  method on an unopened instance now says so, instead of failing with
  `Cannot read properties of null`.

### Added

- **Error codes.** Every failure is a `RemoteGitError` with a stable `code`
  (`NETWORK`, `HTTP`, `NO_V2`, `CAS_MISMATCH`, `NON_FAST_FORWARD`, `BAD_KEY`,
  …), the original error in `cause`, and `status` on HTTP failures. Branch on
  the code instead of matching message text. Existing messages are unchanged, so
  code that matched on them keeps working.
- **npm package** with the engine bundled next to the JS, so `open()` needs no
  `wasm` option and no build step. `zig-wasm-git/wasm` exposes the binary for
  bundlers that want it as a separate asset.
- **TypeScript declarations** covering the whole `RemoteGit` API.
  `isGitError(e, ERR.NETWORK)` narrows the error, so `e.code` is a literal type
  and no cast is needed.
- **`close()`** releases the engine and its ~5MB of memory. Worth calling in a
  serverless handler or anywhere instances are short-lived. Idempotent; waits
  for in-flight work. **`getMany(paths, { local: true })`** and
  **`list(prefix, { local: true })`** read from cache only, never touching the
  network. **`getMany(paths, { as: "text" })`** returns strings instead of
  bytes, and `getMany` accepts a single key as well as an array.

### Fixed

- **Writes could report success while losing data.** Two malformed keys in one
  `putMany` call (`""` and `"/a.txt"`) collapsed onto the same git tree entry,
  so one of them vanished and you still got a commit sha back. Keys are now
  validated up front — relative paths, no empty segment, no `.` / `..` / `.git`
  — and a bad key is rejected before anything is written.
- **A custom `store` that returned Promises corrupted quietly.** `putMany`
  returned a plausible sha while every subsequent read came back empty. A store
  must be synchronous; `open()` now checks and says so.
- An unopened instance failed with a raw `TypeError` (see Breaking).
- `log()` now shares the same queue as every other method, so all methods have
  one consistent ordering. (It was already safe — it never touched shared
  memory — this only makes the guarantee uniform.)

## [1.5.0] — 2026-09-26

Documentation only.

## [1.3.0] — 2026-09-26

- Releases now ship a single-file JS bundle alongside the wasm, so browser and
  Worker users can grab one file instead of wiring up a build.

## [1.2.0] — 2026-09-25

- Documented the boundary with v1-only git servers, verified
  against a live host: reads refuse loudly, `push` works.
- Test coverage extended to the fetch, push and blob paths.

## [1.1.0] — 2026-08-22

- **`memoryStore()`**: an in-memory store, so the library runs with no
  filesystem at all — the default in Workers-style runtimes. Bring your own
  (KV/R2/D1) by implementing the same five-method interface.
- **Commit author, committer, time and timezone** are settable, per instance or
  per write.
- **`log()`**: recent history without any protocol negotiation.

## [1.0.0] — 2026-08-22

First stable release. A git remote as a versioned blob store, with no `fs` and
no `git` command: read and write keys over smart HTTP, with partial-clone
filters (`blob:none`, `blob:limit`, `tree:0`, `object:type`). The protocol
engine is a ~47KB pure-Zig wasm binary with no libc; the JavaScript layer is
`fetch` and a pluggable store. Verified against real `git` (`fsck --strict`).

## [0.x] — internal

Prototyping: smart HTTP server, partial clone end to end, first object-level
API.
