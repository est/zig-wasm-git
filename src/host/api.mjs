// zig-wasm-git Node API: thin adapter over the portable repo (portable.mjs).
//
// Single source of truth for get/commit/fetch/push lives in the portable
// chain (same code as browsers/CF Workers). This file only adds what Node
// needs on top:
//   - fileStore(dir): bare-repo layout on disk (get -> Buffer)
//   - Buffer-flavored get()/pushPack() (content/pack as Buffer, like before)
//   - sync log() via node:zlib (portable log is async; Node keeps it sync)
//   - load(wasmPath): reads the wasm file from disk
//
//   import { load } from "./api.mjs";
//   const repo = load("zig_wasm_git.wasm", { dir: "data/demo.git" });
//   repo.get("main", ["README.md"]);            // [{path, oid, content: Buffer}]
//   repo.commit("", "init", { "a.txt": "hi" }); // -> commit sha

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import zlib from "node:zlib";
import { join, dirname } from "node:path";
import { loadFromBytes, memoryStore as portableMemoryStore, createBlobService, withBasicAuth } from "./portable.mjs";
import { parseCommit } from "./utils.mjs";

export { createBlobService, loadFromBytes, withBasicAuth };
export const memoryStore = portableMemoryStore;

export function load(wasmPath, opts = {}) {
  const bytes = readFileSync(wasmPath);
  // 无 FS：直接传 store（Workers 侧零 FS）；有 FS：opts.dir 兜底
  const store = opts.store ?? (opts.dir != null ? fileStore(opts.dir) : memoryStore());
  const inner = loadFromBytes(bytes, { store });

  return {
    /** [{path, oid, content: Buffer}|{path, error}] — Buffer flavor of portable get() */
    get(ref, paths) {
      return inner.get(ref, paths).map((r) => (r.error ? r : { ...r, content: Buffer.from(r.content) }));
    },

    /** options: { author="<name> <email>", committer, time(sec), timezone } (all optional) */
    commit(parentRef, message, entriesObj, updateRef = "refs/heads/main", options = {}) {
      const entries = Object.fromEntries(
        Object.entries(entriesObj).map(([p, c]) => [p, typeof c === "string" ? Buffer.from(c) : c]),
      );
      return inner.commit(parentRef, message, entries, updateRef, options);
    },

    /** recent history: [{sha, tree, parents[], author, message}] — newest first, up to limit. */
    log(ref, limit = 10) {
      const sha0 = inner.resolveRef(ref);
      const out = [];
      let cur = sha0;
      for (let i = 0; i < limit && cur; i++) {
        const loose = store.get(cur);
        if (!loose) break;
        const raw = zlib.inflateSync(loose); // "<type> <size>\0<body>"
        const nul = raw.indexOf(0);
        const row = parseCommit(cur, raw.subarray(nul + 1).toString("utf8"));
        out.push(row);
        cur = row.parents[0];
      }
      return out;
    },

    resolveRef: inner.resolveRef,

    /** 低层 pack 组装:objects=[{hex, type, body}] -> pack Buffer (Buffer flavor) */
    async pushPack(objects) {
      return Buffer.from(await inner.pushPack(objects));
    },

    /** fetch/clone: smart HTTP v2 -> unpack(delta) -> store (无 FS/CLI,Worker 同代码) */
    fetch(url, ref = "main", opts = {}) {
      return inner.fetch(url, ref, opts);
    },

    lsRemote(url, opts = {}) {
      return inner.lsRemote(url, opts);
    },

    /** push(ref):discovery -> collect -> pack -> receive-pack,真 git 语义 */
    push(url, ref = "refs/heads/main", opts = {}) {
      return inner.push(url, ref, opts);
    },
  };
}

// ── file-backed store (bare repo layout) ──
export function fileStore(dir) {
  mkdirSync(join(dir, "objects"), { recursive: true });
  mkdirSync(join(dir, "refs/heads"), { recursive: true });
  if (!existsSync(join(dir, "HEAD"))) writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");

  return {
    get(hex) {
      const p = join(dir, "objects", hex.slice(0, 2), hex.slice(2));
      try {
        return readFileSync(p);
      } catch {
        return null;
      }
    },
    put(hex, loose) {
      const p = join(dir, "objects", hex.slice(0, 2), hex.slice(2));
      try {
        // loose 对象不可变:已存在直接跳过,省一次写
        if (existsSync(p)) return;
      } catch { /* fall through to write */ }
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, loose);
    },
    getRef(name) {
      const p = join(dir, name);
      try {
        return readFileSync(p, "utf8").trim();
      } catch {
        return null;
      }
    },
    putRef(name, sha) {
      const p = join(dir, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, sha + "\n");
    },
    heads() {
      // 递归走 refs/heads (支持 feature/x 这类嵌套分支),只收文件
      const out = [];
      const walk = (rel) => {
        let entries;
        try {
          entries = readdirSync(join(dir, "refs/heads", rel), { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.isDirectory()) walk(rel ? `${rel}/${e.name}` : e.name);
          else if (e.isFile()) out.push(rel ? `${rel}/${e.name}` : e.name);
        }
      };
      walk("");
      return out;
    },
  };
}
