#!/usr/bin/env bash
# fetch-deps.sh — 下载 zig-wasm-git 复刻所需工具链与源码到 ./tmp 与 ./third_party
# 约定：不使用 /tmp，全部落在工程内相对路径，幂等，可重复执行
# 用法：
#   ./scripts/fetch-deps.sh              # 默认：zig 0.16.0 + wabt + git + artifact-fs
#   ./scripts/fetch-deps.sh --all        # 追加 libgit2 + isomorphic-git + wasmtime + binaryen
#   ./scripts/fetch-deps.sh --zig 0.15.2 # 指定 Zig 版本
#   ./scripts/fetch-deps.sh --force      # 强制重下/重克隆
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$ROOT/tmp"
TP="$ROOT/third_party"
FORCE=0
ZIG_VER="0.16.0"
WITH_ALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --all) WITH_ALL=1; shift ;;
    --zig) ZIG_VER="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$TMP" "$TP"
ARCH="$(uname -m)"
OS="$(uname -s)"
echo "[fetch-deps] ROOT=$ROOT ARCH=$ARCH OS=$OS ZIG=$ZIG_VER ALL=$WITH_ALL FORCE=$FORCE"
echo "[fetch-deps] TMP=$TMP TP=$TP"

need_cmd() { command -v "$1" >/dev/null 2>&1; }

fetch_url() {
  local url="$1" out="$2"
  if [[ -f "$out" && $FORCE -eq 0 ]]; then
    echo "[skip] exists $out"
    return 0
  fi
  echo "[fetch] $url -> $out"
  if need_cmd curl; then
    curl -L --fail --progress-bar -o "$out" "$url"
  elif need_cmd wget; then
    wget -O "$out" "$url"
  else
    echo "need curl or wget" >&2; return 1
  fi
}

# ---- 1) Zig ----
zig_url_for() {
  local ver="$1"
  case "$ver" in
    0.16.0) echo "https://ziglang.org/download/0.16.0/zig-aarch64-macos-0.16.0.tar.xz" ;;
    0.15.2) echo "https://ziglang.org/download/0.15.2/zig-aarch64-macos-0.15.2.tar.xz" ;;
    0.15.1) echo "https://ziglang.org/download/0.15.1/zig-aarch64-macos-0.15.1.tar.xz" ;;
    *)      echo "https://ziglang.org/download/${ver}/zig-aarch64-macos-${ver}.tar.xz" ;;
  esac
}

ZIG_URL="$(zig_url_for "$ZIG_VER")"
ZIG_TAR="$TMP/zig-aarch64-macos-${ZIG_VER}.tar.xz"
ZIG_DIR="$TP/zig"
if [[ ! -x "$ZIG_DIR/zig" || $FORCE -eq 1 ]]; then
  fetch_url "$ZIG_URL" "$ZIG_TAR"
  echo "[extract] $ZIG_TAR -> $ZIG_DIR"
  rm -rf "$ZIG_DIR"
  mkdir -p "$ZIG_DIR"
  # zig tar 顶层目录为 zig-aarch64-macos-*/，strip 1
  tar -xJf "$ZIG_TAR" -C "$ZIG_DIR" --strip-components=1
  chmod +x "$ZIG_DIR/zig" 2>/dev/null || true
  "$ZIG_DIR/zig" version || true
else
  echo "[skip] zig already at $ZIG_DIR ($("$ZIG_DIR/zig" version 2>&1 || echo unknown))"
fi

# ---- 2) wabt (wasm-opt 等) ----
# 优先用 brew，若无则从 GitHub release 拉取
WABT_DIR="$TP/wabt"
WABT_BIN="$WABT_DIR/bin/wasm-opt"
if [[ -x "$WABT_BIN" && $FORCE -eq 0 ]]; then
  echo "[skip] wabt at $WABT_BIN ($("$WABT_BIN" --version 2>&1 | head -1))"
else
  if need_cmd wasm-opt && [[ $FORCE -eq 0 ]]; then
    echo "[skip] system wasm-opt found: $(wasm-opt --version 2>&1 | head -1) (仍会尝试本地化到 $WABT_DIR，可 --force 覆盖)"
  fi
  # GitHub wabt release 资产名随版本变化，这里用 1.0.34 的 macos-14 包
  WABT_URL="https://github.com/WebAssembly/wabt/releases/download/1.0.34/wabt-1.0.34-macos-14.tar.gz"
  WABT_TAR="$TMP/wabt-1.0.34-macos-14.tar.gz"
  if fetch_url "$WABT_URL" "$WABT_TAR"; then
    echo "[extract] $WABT_TAR -> $WABT_DIR"
    rm -rf "$WABT_DIR"
    mkdir -p "$WABT_DIR"
    tar -xzf "$WABT_TAR" -C "$WABT_DIR" --strip-components=1
    chmod +x "$WABT_DIR/bin/"* 2>/dev/null || true
    "$WABT_DIR/bin/wasm-opt" --version 2>&1 | head -1 || true
  else
    echo "[warn] wabt 下载失败，可改用: brew install wabt" >&2
  fi
fi

# ---- 3) 可选：wasmtime / binaryen ----
if [[ $WITH_ALL -eq 1 ]]; then
  # wasmtime
  WASMTIME_DIR="$TP/wasmtime"
  if [[ ! -x "$WASMTIME_DIR/wasmtime" || $FORCE -eq 1 ]]; then
    WASMTIME_URL="https://github.com/bytecodealliance/wasmtime/releases/download/v27.0.0/wasmtime-v27.0.0-aarch64-macos.tar.xz"
    WASMTIME_TAR="$TMP/wasmtime-v27.0.0-aarch64-macos.tar.xz"
    if fetch_url "$WASMTIME_URL" "$WASMTIME_TAR"; then
      rm -rf "$WASMTIME_DIR"
      mkdir -p "$WASMTIME_DIR"
      tar -xJf "$WASMTIME_TAR" -C "$WASMTIME_DIR" --strip-components=1
      chmod +x "$WASMTIME_DIR/wasmtime" 2>/dev/null || true
      "$WASMTIME_DIR/wasmtime" --version 2>&1 | head -1 || true
    else
      echo "[warn] wasmtime 下载失败，可改用: brew install wasmtime" >&2
    fi
  else
    echo "[skip] wasmtime at $WASMTIME_DIR"
  fi
  # binaryen (另一份 wasm-opt)
  BINARYEN_DIR="$TP/binaryen"
  if [[ ! -x "$BINARYEN_DIR/bin/wasm-opt" || $FORCE -eq 1 ]]; then
    BINARYEN_URL="https://github.com/WebAssembly/binaryen/releases/download/version_123/binaryen-version_123-aarch64-macos.tar.gz"
    BINARYEN_TAR="$TMP/binaryen-version_123-aarch64-macos.tar.gz"
    if fetch_url "$BINARYEN_URL" "$BINARYEN_TAR"; then
      rm -rf "$BINARYEN_DIR"
      mkdir -p "$BINARYEN_DIR"
      tar -xzf "$BINARYEN_TAR" -C "$BINARYEN_DIR" --strip-components=1
      chmod +x "$BINARYEN_DIR/bin/"* 2>/dev/null || true
      "$BINARYEN_DIR/bin/wasm-opt" --version 2>&1 | head -1 || true
    else
      echo "[warn] binaryen 下载失败，可改用: brew install binaryen" >&2
    fi
  else
    echo "[skip] binaryen at $BINARYEN_DIR"
  fi
fi

# ---- 4) 源码：git / artifact-fs / (可选) libgit2 / isomorphic-git ----
clone_repo() {
  local url="$1" dest="$2" depth_args="--depth 1"
  if [[ -d "$dest/.git" && $FORCE -eq 0 ]]; then
    echo "[skip] clone exists $dest ($(git -C "$dest" log --oneline -1 2>&1 | head -1))"
    return 0
  fi
  if [[ -d "$dest" && $FORCE -eq 1 ]]; then
    echo "[force] rm $dest"
    rm -rf "$dest"
  fi
  echo "[clone] $url -> $dest"
  git clone $depth_args "$url" "$dest"
}

clone_repo "https://github.com/git/git.git" "$TP/git"
clone_repo "https://github.com/cloudflare/artifact-fs.git" "$TP/artifact-fs"

if [[ $WITH_ALL -eq 1 ]]; then
  clone_repo "https://github.com/libgit2/libgit2.git" "$TP/libgit2"
  clone_repo "https://github.com/isomorphic-git/isomorphic-git.git" "$TP/isomorphic-git"
fi

# ---- 5) 自检 ----
echo ""
echo "===== 自检 ====="
echo -n "zig:        "; "$ZIG_DIR/zig" version 2>&1 || echo "MISSING"
echo -n "wasm-opt:   "; (wasm-opt --version 2>&1 | head -1) || ("$WABT_DIR/bin/wasm-opt" --version 2>&1 | head -1) || echo "MISSING (brew install wabt / binaryen)"
if [[ $WITH_ALL -eq 1 ]]; then
  echo -n "wasmtime:   "; ("$WASMTIME_DIR/wasmtime" --version 2>&1 | head -1) || (wasmtime --version 2>&1 | head -1) || echo "MISSING"
fi
echo -n "git:        "; git --version 2>&1 | head -1
echo -n "node:       "; node --version 2>&1 | head -1
echo -n "bun:        "; bun --version 2>&1 | head -1
echo -n "pack-format:"; ls -lh "$TP/git/Documentation/technical/pack-format.txt" 2>&1 | awk '{print $9, $5}' || echo " MISSING"
echo -n "artifact-fs:"; ls -ld "$TP/artifact-fs" 2>&1 | head -1
if [[ $WITH_ALL -eq 1 ]]; then
  echo -n "libgit2:    "; ls -ld "$TP/libgit2" 2>&1 | head -1
  echo -n "isomorphic: "; ls -ld "$TP/isomorphic-git" 2>&1 | head -1
fi
echo ""
echo "[done] 全部下载到 ./tmp 与 ./third_party，未使用 /tmp"
echo "  下一步："
echo "    ./third_party/zig/zig version"
echo "    ./third_party/zig/zig build --help | head -20"
echo "    ls -lh ./third_party/git/Documentation/technical/"
echo "  完成后通知我开始 M1 开发。"
