# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning is [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **receive-pack 客户端** (`repo.push(url, ref)`):协议在 wasm、IO/压缩在 JS。
  wasm 新增 `wasm_find_ref`/`wasm_list_refs`/`wasm_build_ref_update`/`wasm_pack_begin|add|end`/
  `wasm_parse_report_status` 导出;对象枚举 + `CompressionStream('deflate')` 压缩 + `fetch`
  收发在 `src/host/push.mjs`/`codec.mjs`。无 delta(包仍被 git 接受,gc 后服务端自行增量化)。
  wasm 体积 51,873 → 64,494B(预算锁 64KiB,见 `tests/test_wasm.mjs`)。
- `tests/test_pack.mjs` / `tests/test_push.mjs`:pack 经 `git index-pack`/`verify-pack` 真验证;
  wasm pack 与 JS 参考实现逐字节 differential 比对;JS 客户端直推本地 host、服务端 `fsck` 验收。

### Fixed

- `pack.zig buildPack` payload 纠正为 `zlib(body)`(此前 `zlib(header+body)` 必被 git 拒,
  已用真 git 对照验证);测试改为 trailer sha + inflate 往返断言,不止 `startsWith("PACK")`。

## [1.1.0] — 2026-08-22

### Added

- **Pure in-memory store** (`memoryStore()`): zero-FS operation, default when `load()` is
  called without `dir`/`store`. Designed for CF Workers-style runtimes where storage adapters
  (KV/R2/D1) plug into the same `{get, put, getRef, putRef}` interface.
- **`repo.commit(..., options)`**: optional `{ author, committer, time, timezone }`
  (new `wasm_commit2` export; legacy `wasm_commit` untouched). Fixed-identity placeholder removed as a requirement.
- **`repo.log(ref, limit)`**: newest-first parent-chain walk returning `{sha, tree, parents[], author, message}` —
  the cheap "recent history only" path for agents (no protocol negotiation at all).
- **Server-side shallow groundwork**: `deepen`/`deepen-since`/`deepen-not` parsing, shallow/unshallow
  section + `packfile` framing in the v2 fetch fallback path.

### Known issue (Apple Git)

This host's smart-HTTP layer does not yet advertise `fetch=shallow`: git 2.50.1-Darwin clients
stop after `ls-refs` when the token is present and the request carries `--depth`. Explicit
low-level clients that send `deepen` directly work fine; object-level consumers are unaffected.

## [1.0.0] — 2026-08-22

First stable release. Pure-Zig WASM git engine + Node host, `git http` read/write with partial clone.

### Added

- **WASM engine** (`zig-out/bin/zig_wasm_git.wasm`, 47KB, `wasm32-freestanding`, no libc):
  - Object-level API: `wasm_get(oid, paths)` / `wasm_commit(parent, msg, entries)` with binary TLV framing
  - Smart HTTP protocol: v1 discovery (`# service=...`) + v2 (`version 2 / ls-refs / fetch=filter`)
  - Partial clone filters: `blob:none`, `blob:limit=<n>[kmg]`, `tree:0`, `object:type=`, `combine:+`
  - SHA-1, zlib (stored-block writer + flate inflate reader), pack v2, pkt-line, delta-free tree rebuild
- **JS glue** `src/host/api.mjs`: `load(wasm, {dir})` → `repo.get(ref, paths)` / `repo.commit(parent, msg, {path: content})`;
  refs accept sha1 / branch name / HEAD
- **Host** `src/host/server.mjs`: smart HTTP server over a bare repo in `data/<repo>.git`
- CI: GitHub Actions test workflow + release workflow publishing the wasm artifact on tags
- Tests: `tests/run.sh` (18 zig unit tests + wasm filter tests + API e2e verified against real `git fsck --strict`)

### Fixed

- `wasm_alloc` now returns 8-byte aligned pointers (unaligned `*usize` deref could trap)
- Tree entry sorting no longer allocates (freestanding `page_allocator` silently failed → wrong dir order)
- `hostGetObject` two-phase size probe; was burning 64KB of the 4MB arena per object

## [0.x] — internal

Prototyping: smart HTTP server, partial clone e2e, first object-level API (JSON+b64 framing, 114KB wasm).
