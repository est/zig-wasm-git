# 环境与源码依赖清单 — zig-wasm-git 复刻

> 约定：所有下载缓存落在工程内 `./tmp/` (下载产物) 与 `./third_party/` (解压/克隆源码)，**不使用 /tmp**。
> 本机：macOS arm64 (Apple Silicon)，已探明 `node v22.19.0 / bun 1.3.14 / git 2.50.1 / clang 21` 可用，`zig / wasm-opt / wasmtime` 待安装。

## 1. 必装工具链

| # | 名称 | 作用 | 版本建议 | 获取方式 | 落点 | 体积 | 校验 |
|---|------|------|----------|----------|------|------|------|
| 1 | Zig | 编译 `wasm32-freestanding` 与 `native` 双靶 | **0.16.0** (2026-04-13) 首选；备选 0.15.2 | 官网 `zig-aarch64-macos-0.16.0.tar.xz` | `./tmp/zig-aarch64-macos-0.16.0.tar.xz` 解压到 `./third_party/zig/` | ~50MB | `zig version` |
| 2 | wabt (wasm-opt/wasm-strip/wat2wasm) | WASM 二次优化与体积 | 最新 release (≥1.0.34) | `brew install wabt` 或 GitHub release `wabt-*-macos-14.tar.gz` | `./tmp/wabt-*.tar.gz` → `./third_party/wabt/` | ~5MB | `wasm-opt --version` |
| 3 | wasmtime (可选) | 本地无浏览器验证 WASM | 最新 | `brew install wasmtime` 或 GitHub release | `./tmp/wasmtime-*.tar.xz` | ~8MB | `wasmtime --version` |
| 4 | Node.js + Bun | Host HTTP 服务 | 已有 `node 22 / bun 1.3.14` | — | — | — | `node --version && bun --version` |

> 备选：`binaryen` (提供另一份 `wasm-opt`)，与 wabt 二选一；`wasm-opt` 来自 binaryen 时包名不同，注意区分。

Zig 官方下载（本机对应）：
- 0.16.0: `https://ziglang.org/download/0.16.0/zig-aarch64-macos-0.16.0.tar.xz` (+ `.minisig`)
- 0.15.2: `https://ziglang.org/download/0.15.2/zig-aarch64-macos-0.15.2.tar.xz`
- master: `https://ziglang.org/builds/zig-aarch64-macos-0.17.0-dev.1824+7988f7952.tar.xz`

wabt / wasmtime:
- wabt: `https://github.com/WebAssembly/wabt/releases`
- wasmtime: `https://github.com/bytecodealliance/wasmtime/releases`
- binaryen: `https://github.com/WebAssembly/binaryen/releases`

## 2. 必备源码（用于学习/对照/测试）

| # | 仓库 | 用途 | 克隆方式 | 落点 | 大小(浅克隆) | 备注 |
|---|------|------|----------|------|--------------|------|
| A | `git/git` | pack/delta/pkt-line/http 真值 | `git clone --depth 1 https://github.com/git/git.git` | `./third_party/git/` | ~30MB | 重点看 `Documentation/technical/` |
| B | `cloudflare/artifact-fs` | 已开源的 ArtifactFS 实现对照 | `git clone --depth 1 https://github.com/cloudflare/artifact-fs.git` | `./third_party/artifact-fs/` | ~1MB | 非 WASM 引擎但验证 blobless 思路 |
| C | `libgit2/libgit2` (可选) | Native 对照测试 (原文做法) | `git clone --depth 1 https://github.com/libgit2/libgit2.git` | `./third_party/libgit2/` | ~15MB | 需 cmake 编译，可延后 |
| D | `isomorphic-git/isomorphic-git` (可选) | JS 侧 pack/delta/pkt-line 可读实现 | `git clone --depth 1 https://github.com/isomorphic-git/isomorphic-git.git` | `./third_party/isomorphic-git/` | ~5MB | 辅助理解 |

文档离线缓存（可选）：
- `git-scm.com/docs` 相关页、`RFC 1950/1951`、`FIPS 180-4` 已在 `docs/RESEARCH.md` 列出，`scripts/fetch-deps.sh` 会尝试 `curl` 拉取到 `./tmp/docs/`。

## 3. 目录约定

```
./tmp/                  # 下载产物（tar.xz / tar.gz），.gitignore
./third_party/          # 解压后工具链与克隆源码，.gitignore
  zig/                  # zig 二进制
  wabt/ 或 binaryen/    # wasm-opt 等
  wasmtime/             # 可选
  git/
  artifact-fs/
  libgit2/              # 可选
  isomorphic-git/       # 可选
./docs/RESEARCH.md      # 调研报告
./docs/ENV_DEPS.md      # 本文件
./.mimocode/plans/zig-wasm-git-plan.md  # 复刻方案
```

## 4. 一键下载

```bash
chmod +x ./scripts/fetch-deps.sh
./scripts/fetch-deps.sh          # 默认：Zig 0.16.0 + wabt + git + artifact-fs
./scripts/fetch-deps.sh --all    # 追加 libgit2 + isomorphic-git + wasmtime + binaryen
./scripts/fetch-deps.sh --zig 0.15.2  # 指定 Zig 版本
```

脚本幂等：已存在则跳过；支持 `--force` 重下；所有路径均为相对路径，不写 /tmp。

## 5. 下载后自检

```bash
./third_party/zig/zig version
wasm-opt --version || ./third_party/wabt/bin/wasm-opt --version
wasmtime --version 2>&1 | head -1  # 可选
ls -lh ./third_party/git/Documentation/technical/pack-format.txt
ls -lh ./third_party/artifact-fs/
./third_party/zig/zig build --help | head -20
```

全部通过后再通知我开始 M1 开发（SHA-1/zlib/oid/object）。

## 6. 网络与权限注意

- Zig 官网与 GitHub release 需公网；若受限可改用 `brew install zig wabt wasmtime`（brew 版 Zig 可能非 0.16.0，注意 `zig version` 核对）。
- `git clone --depth 1` 最省流量；如需查历史再 `git fetch --unshallow`。
- 本清单与脚本均不写 /tmp，CI/本地均可复现。
