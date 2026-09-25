# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning is [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Blob-service facade** (`src/host/blob.mjs`, portable, re-exported from
  `browser.mjs`/`api.mjs`): `createBlobService(repo, {ref, filter})` ->
  `read`/`readText`/`readMany`/`write`/`writeText`/`pull`/`publish`/`sync`/`version`.
  One branch == one keyspace, missing key is `null`, each write is a version,
  publish is fast-forward-only (last-writer-wins, no merge). `sync(url, paths)`
  pulls latest then returns keys; `filter: "blob:none"` pulls versions without
  bytes. Covered by `tests/test_blob.mjs` (local lifecycle + server sync + fsck).
- **upload-pack v2 客户端** (`repo.fetch(url, ref, {filter})` / `repo.clone()` / `repo.lsRemote()`):
  无 FS、无命令行,浏览器/CF Worker 同代码。协议举重在 wasm,IO 在 JS。
  - wasm 新增 `delta.zig` (git delta 展开:copy/insert + base/result varint,4 个单测) 与
    `fetch.zig` (v2 `ls-refs`/`fetch` 请求构造,与真 git 抓包同形,3 个单测);
    新导出 `wasm_build_lsrefs`/`wasm_build_fetch`/`wasm_decode_pack_header`/
    `wasm_inflate_one`(单遍拆包,精确 consumed,终结 trial-inflate)/
    `wasm_delta_apply`。体积 63 → ~69KB(预算锁放宽至 72KiB,见 `tests/test_wasm.mjs`)。
  - JS 新增可移植链路 (零 `node:` 导入,断言见 `tests/test_fetch.mjs`):
    `src/host/store.mjs`(memoryStore) / `wire.mjs`(wasm 调用封装) /
    `fetch.mjs`(discovery→ls-refs→fetch→sideband 解帧→trailer 校验→unpack:
    ofs-delta 位置解析 + ref-delta 两段哈希解析→loose 落盘) /
    `browser.mjs`(`loadFromBytes`:get/commit/log/fetch/clone/push 全 parity)。
  - `codec.mjs`/`push.mjs` 从 Buffer 迁到 Uint8Array+TextDecoder (Node 照常兼容),
    `browser.mjs` 的 push 复用同一 `collectObjects`。
  - `tests/test_fetch.mjs`:全量 fetch→`get()` 读文件;传输中 ofs-delta 内容精确还原;
    `--no-delta-base-offset` 真包 ref-delta 全量逐字节比对;`blob:none` promisor;
    browser 入口 fetch/get/commit/push 真 git 验收;`git fsck` 交叉验证。
- **receive-pack 客户端** (`repo.push(url, ref)`):协议在 wasm、IO/压缩在 JS。
  wasm 新增 `wasm_find_ref`/`wasm_list_refs`/`wasm_build_ref_update`/`wasm_pack_begin|add|end`/
  `wasm_parse_report_status` 导出;对象枚举 + `CompressionStream('deflate')` 压缩 + `fetch`
  收发在 `src/host/push.mjs`/`codec.mjs`。无 delta(包仍被 git 接受,gc 后服务端自行增量化)。
  wasm 体积 51,873 → 64,494B(预算锁 64KiB,见 `tests/test_wasm.mjs`)。
- `tests/test_pack.mjs` / `tests/test_push.mjs`:pack 经 `git index-pack`/`verify-pack` 真验证;
  wasm pack 与 JS 参考实现逐字节 differential 比对;JS 客户端直推本地 host、服务端 `fsck` 验收。

### Fixed

- 服务端 v2 fetch 回退路径此前只在 shallow 时发 `packfile` 段头,非 shallow 的
  filter 包被真 git 以 `expected 'packfile'` 拒绝;现恒发 `packfile` 头
  (`src/host/server.mjs`),`--filter=blob:none` 真机 clone 已通 (见 `scripts/e2e.sh`)。
- `push.zig` pkt 切分/listRefs/findRef 容忍 `0002` response-end (真 git v2
  ls-refs 响应尾部) 与 `version ` caps 行。
- `pack.zig buildPack` payload 纠正为 `zlib(body)`(此前 `zlib(header+body)` 必被 git 拒,
  已用真 git 对照验证);测试改为 trailer sha + inflate 往返断言,不止 `startsWith("PACK")`。
- stock git (`http.receivepack` 默认 false,ubuntu git 2.43) 下测试服 discovery 被
  `http-backend` 回空 body (`Service not enabled`),客户端见 0 refs 误走建分支,
  首推碰巧过、二次 push 被拒 `reference already exists` (CI: `test_push.mjs` noop)。
  现 `server.mjs ensureRepo` 固定写 `http.receivepack/uploadpack=true`;
  `push.zig listRefs` 对零 pkt token 广播返回 `EmptyAdvertisement` 大声报错,
  不再静默 0 refs (v2 空 `ls-refs` 的单个 `0000` 仍合法)。orb Ubuntu 复现+全量验证。

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
