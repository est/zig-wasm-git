# 调研报告 — 纯 Zig 无 libc WASM Git 协议引擎复刻

> 对象：Cloudflare Artifacts 博客 https://blog.cloudflare.com/artifacts-git-for-agents-beta/ 中所述的 Zig WASM git 引擎（~100KB, 无 libc, 自实现 SHA-1/zlib/delta/pack/smart HTTP, 11+1 Host 回调）
> 目标：更简单的复刻，支持 `git http` 读写（smart HTTP fetch/push），本地可构建、可验证。

## 1. 原文能力拆解

| 能力 | 原文描述 | 复刻 MVP 取舍 |
|------|----------|---------------|
| SHA-1 | 自实现 | 必须，Zig std.crypto.sha1 或手写 |
| zlib inflate/deflate | 自实现 (RFC1950/1951) | 必须，对象存储压缩 |
| delta 编解码 | 自实现 | 必须（解）/可选（编码首版可不做寻优） |
| pack 解析/生成 | 自实现 | 必须，v2 pack |
| smart HTTP | 完整实现 | 必须，upload-pack / receive-pack + discovery |
| v1/v2, shallow, have/want | 支持 | 首版仅 v1 + 基础 v2 ls-refs，shallow 延后 |
| git-notes/LFS | 可扩展 | 不做 |
| 体积 ~100KB wasm | ReleaseSmall + 优化 | 目标 ≤150KB, wasm-opt -Oz |
| Host 接口 11+1 | host_* + host_emit_bytes | 抽象为最小可运行子集，本地用内存/SQLite 实现 |
| 双靶构建 | WASM 生产 + Native 测试对照 libgit2 | 保留 |

## 2. 协议与格式参考（需本地下载/缓存）

### 2.1 权威文档
- `git-scm.com/docs` — `gitformat-pack`, `gitformat-commit`, `gitformat-tree`, `gitformat-object`, `protocol-common`, `protocol-v2`, `http-protocol`
- `git/Documentation/technical/` — `pack-format.txt`, `pack-protocol.txt`, `protocol-v2.txt`, `http-protocol.txt`, `pack-heuristics.txt`
- RFC 1950 (zlib), RFC 1951 (deflate), RFC 1952 (gzip, 参考)
- FIPS 180-4 (SHA-1), RFC 3174
- WebAssembly core spec (wasm32-freestanding ABI)

### 2.2 源码对照
- **git/git** (https://github.com/git/git) — `pack-objects.c`, `unpack-objects.c`, `delta.c`, `sha1dc/`, `zlib.c`, `pkt-line.c`, `upload-pack.c`, `receive-pack.c`，作为行为真值
- **libgit2/libgit2** (https://github.com/libgit2/libgit2) — 用于 Native 测试对照（博客原文做法）
- **isomorphic-git/isomorphic-git** (https://github.com/isomorphic-git/isomorphic-git) — JS 侧纯实现参考（pack/Delta/pkt-line 逻辑可读性高）
- **cloudflare/artifact-fs** (https://github.com/cloudflare/artifact-fs) — 已开源的 blobless clone / hydrate 侧对照，非引擎本身但有助于验证大仓路径
- **wabt** (https://github.com/WebAssembly/wabt) — wasm-opt / wasm-strip / wat2wasm
- **wasmtime / wasm3 / Node --experimental-wasm** — 本地验证 WASM

### 2.3 数据格式速查
- ** loose object **: `"<type> <size>\0<content>"` → zlib deflate → 文件名 = hex(SHA1)
- ** pack v2 **: `PACK` + version(4) + n_objects(4) + [ object* ] + checksum(20); object header = VarInt(type, size) + [delta header] + zlib payload
- ** delta **: `base_size VarInt + result_size VarInt + [ copy(1-7) | insert ]*`; copy 指令编码见 `git/Documentation/technical/pack-format.txt`
- ** pkt-line **: 4 hex 长度前缀（含自身），`0000` flush, `0001` delim, `0002` response-end
- ** smart HTTP **:
  - Discovery: `GET /info/refs?service=git-upload-pack` → `001e# service=git-upload-pack\n0000` + pkt-line refs
  - Fetch: `POST /git-upload-pack` (或 `/git-upload-pack` / `/upload-pack`) body = pkt-line want/have/done
  - Push: `GET /info/refs?service=git-receive-pack` + `POST /git-receive-pack` body = pkt-line refs + pack

## 3. 复刻架构

```
[ git client ] --HTTP--> [ Host (TS/Bun/Node) ] --imports--> [ zig-wasm-git.wasm ]
                              |  host_* (11) + host_emit_bytes (1)
                              v
                        [ Storage: 内存 / SQLite / FS ]
                              - objects (loose/pack)
                              - refs (heads/tags)
                              - chunks (大对象分片，可延后)
```

Host 职责：HTTP 路由、鉴权（首版可无）、将请求体喂给 WASM、收集 `host_emit_bytes` 流式响应、实现 storage 回调。
WASM 职责：纯计算，无 I/O，无网络，无文件系统；所有持久化经 Host 回调。

## 4. 模块划分（对应 src/zig/）

- `oid.zig` — 20B SHA-1, hex 解析/格式化, 比较
- `sha1.zig` — FIPS180, 流式 + 一次性，可用 std.crypto.hash.Sha1 或手写以控体积
- `zlib.zig` — inflate/deflate, Adler-32, 需无 libc；首版可基于 std.compress.zlib
- `delta.zig` — apply / (可选) create, VarInt 编解码
- `object.zig` — commit/tree/blob/tag 解析与序列化, loose 编解码
- `pack.zig` — pack 生成/解析, 索引 (.idx v2) 可延后用线性扫描首版
- `pktline.zig` — pkt-line 编解码, flush/delim
- `refs.zig` — ref 发现、更新、校验
- `smart_http.zig` — discovery / upload-pack / receive-pack 状态机
- `host.zig` — extern 声明 + 分配器对接
- `root.zig` — WASM exports: alloc/dealloc/handle_*

## 5. 构建与体积策略

- Zig 版本锁定：建议 `0.16.0` (2026-04-13) 或 `0.15.2` (2025-10-11)，二选一并在 `docs/ENV_DEPS.md` 固化
- Target: `wasm32-freestanding` + `-Doptimize=ReleaseSmall` + `strip=true` + `lto=true`
- 二次优化：`wasm-opt -Oz`, `wasm-strip`
- 体积预算：~100KB (原文) → 首版 ≤150KB 即达标，后续裁 std 依赖可逼近 100KB
- Native 靶：`native` + `Debug` 用于 `zig test` 与 libgit2 对照

## 6. 测试策略（对齐原文）

- `zig test` 单元：sha1 向量、zlib round-trip、delta apply、pkt-line、pack 解析
- Host 集成：本地起 `bun src/host/server.ts`，用系统 `git` 做 `clone` / `fetch` / `push` / `ls-remote` conformance
- libgit2 对照：Native 构建跑同一 pack/对象集，与 libgit2 结果比对（可选，需本地编译 libgit2）
- 大对象/分片：首版可跳过，延后补

## 7. 风险与对策

- Zig std.compress API 跨版本不稳定 → 锁定版本 + 隔离 zlib 模块
- zlib 自实现工作量大 → 首版先用 std 实现跑通，再手写裁体积
- pack delta 寻优复杂 → 首版全量对象或复用已存 delta，不做 xdelta 搜索
- WASM 调试困难 → 保留 Native 靶，所有逻辑优先在 Native 单测通过

## 8. 本地缓存清单（下载到 ./tmp, ./third_party）

见 `docs/ENV_DEPS.md` 与 `scripts/fetch-deps.sh`：
- Zig 编译器 (aarch64-macos)
- wabt (wasm-opt 等)
- wasmtime (可选)
- git 源码 (浅克隆)
- libgit2 源码 (可选)
- artifact-fs 源码
- isomorphic-git 源码 (可选)
