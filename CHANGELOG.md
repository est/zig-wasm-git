# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning is [SemVer](https://semver.org/).

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
