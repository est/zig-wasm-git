# Changelog

Notable changes, written for people using the library. Follows
[Keep a Changelog](https://keepachangelog.com/); versions are [SemVer](https://semver.org/).

## [Unreleased]

### Fixed

- **A too-old Node no longer looks like a network outage.** On a runtime with
  no filesystem — Node before 22.3, which has no `process.getBuiltinModule` —
  the default wasm lookup degraded into `fetch("file://…")` and failed with
  `NETWORK`, the code documented as "offline, DNS, TLS, CORS". A caller
  following the docs would have retried a connection that was never the
  problem. It is now `BAD_ARG`, naming the missing capability and the way out
  (pass bytes, a `WebAssembly.Module`, or an `http(s)` url).
- `package.json` now requires Node `>=22.3`, matching what the default wasm
  lookup actually needs.
- README: Node requirements said 18+, 20+ and 22.3+ in three places. They now
  agree, and explain why 22.3 is the floor.

### Changed

- README restructured around a reader's path: a runnable quick start, an
  authentication section (including the browser CORS caveat), and the
  `custom store` contract promoted out of a comment. Release process, build
  instructions and the `want`/`have`/`delta` capability matrix moved to
  `CONTRIBUTING.md` and `docs/CAPABILITIES.md`; content is unchanged, just no
  longer sitting between a user and the API.

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
