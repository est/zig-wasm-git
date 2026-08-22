// zig-wasm-git high-level JS API
//
// Usage:
//   import { load } from "./api.mjs";
//   const repo = await load("path/to/zig_wasm_git.wasm", { dir: "data/demo.git" });
//   const blobs = repo.get("main", ["README.md", "src/a.txt"]);   // [{path, oid, content}]
//   const commit = repo.commit("main", "msg", { "a.txt": "hello" }); // -> commit sha (and updates ref)
//
// storage: loose objects on disk (objects/xx/yyyy...), refs on disk (refs/heads/main)

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

export function load(wasmPath, opts = {}) {
  const bytes = readFileSync(wasmPath);
  const store = opts.store ?? fileStore(opts.dir ?? "data/demo.git");
  let inst;

  const mod = new WebAssembly.Module(bytes);
  inst = new WebAssembly.Instance(mod, {
    env: {
      host_emit_bytes() {},
      host_log() {},
      host_get_object(oidHexPtr, outPtr, outCap, outLenPtr) {
        try {
          const hex = readStr(oidHexPtr, 40);
          const obj = store.get(hex);
          if (!obj) return -1;
          if (obj.length > outCap) {
            // report required size so wasm can retry
            new DataView(inst.exports.memory.buffer).setUint32(outLenPtr >>> 0, obj.length, true);
            return 1;
          }
          new Uint8Array(inst.exports.memory.buffer).set(obj, outPtr);
          new DataView(inst.exports.memory.buffer).setUint32(outLenPtr >>> 0, obj.length, true);
          return 0;
        } catch {
          return -2;
        }
      },
      host_put_object(oidHexPtr, loosePtr, len) {
        try {
          const hex = readStr(oidHexPtr, 40);
          const mem = new Uint8Array(inst.exports.memory.buffer);
          store.put(hex, Buffer.from(mem.slice(loosePtr, loosePtr + len)));
          return 0;
        } catch {
          return -2;
        }
      },
    },
  });

  const wasm = inst.exports;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function readStr(ptr, len) {
    const mem = new Uint8Array(wasm.memory.buffer);
    return Buffer.from(mem.slice(ptr, ptr + len)).toString("utf8");
  }

  function allocBytes(b) {
    if (b.length === 0) return { ptr: 0, len: 0 };
    const ptr = wasm.wasm_alloc(b.length);
    if (!ptr || ptr < 0) throw new Error("wasm_alloc failed (heap full; call reset between ops)");
    new Uint8Array(wasm.memory.buffer).set(b, ptr);
    return { ptr, len: b.length };
  }
  function allocStr(s) {
    return allocBytes(enc.encode(s));
  }

  // ── ref resolution (host side; WASM deals in sha1 only) ──
  function resolveRef(ref) {
    if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
    if (ref === "HEAD") {
      // symref to first branch that exists
      for (const b of store.heads()) {
        return store.getRef(`refs/heads/${b}`);
      }
      throw new Error(`HEAD: no branch exists yet`);
    }
    // branch/tag shorthand
    for (const p of [`refs/heads/${ref}`, `refs/tags/${ref}`, ref]) {
      const v = store.getRef(p);
      if (v) return v;
    }
    throw new Error(`cannot resolve ref: ${ref}`);
  }

  function reset() {
    wasm.wasm_reset();
  }

  // ── public API ──
  const api = {
    /** read blobs at paths from commit `ref` (sha1 | branch | HEAD).
     *  returns [{path, oid, content(Buffer)}|{path, error}] */
    get(ref, paths) {
      reset();
      const sha = resolveRef(ref);
      const oidHex = allocStr(sha);
      const pj = allocStr(JSON.stringify(paths));
      const outPtrAddr = wasm.wasm_alloc(4);
      const outLenAddr = wasm.wasm_alloc(4);
      const rc = wasm.wasm_get(oidHex.ptr, oidHex.len, pj.ptr, pj.len, outPtrAddr, outLenAddr);
      if (rc !== 0) throw new Error(`wasm_get rc=${rc}`);
      const dv = new DataView(wasm.memory.buffer);
      const jsonPtr = dv.getUint32(outPtrAddr, true);
      const jsonLen = dv.getUint32(outLenAddr, true);
      const mem = new Uint8Array(wasm.memory.buffer);
      const json = Buffer.from(mem.slice(jsonPtr, jsonPtr + jsonLen)).toString("utf8");
      return JSON.parse(json).map((e) =>
        e.error ? e : { path: e.path, oid: e.oid, content: Buffer.from(e.content_b64, "base64") }
      );
    },

    /** commit {path: content|string} on top of `parentRef` ("" => new repo).
     *  returns commit sha; updates ref `updateRef` (default "refs/heads/main") when set. */
    commit(parentRef, message, entriesObj, updateRef = "refs/heads/main") {
      reset();
      const parent = parentRef ? resolveRef(parentRef) : "";
      const pHex = allocStr(parent);
      const msg = allocStr(message);
      const entries = Object.entries(entriesObj).map(([path, content]) => ({
        path,
        content_b64: Buffer.isBuffer(content) ? content.toString("base64") : Buffer.from(String(content)).toString("base64"),
      }));
      const ej = allocStr(JSON.stringify(entries));
      const outHex = wasm.wasm_alloc(40);
      const rc = wasm.wasm_commit(pHex.ptr, pHex.len, msg.ptr, msg.len, ej.ptr, ej.len, outHex);
      if (rc !== 0) throw new Error(`wasm_commit rc=${rc}`);
      const sha = readStr(outHex, 40);
      if (updateRef) store.putRef(updateRef, sha);
      return sha;
    },

    /** resolve a ref to sha (exposed for convenience) */
    resolveRef,
    _wasm: wasm,
  };
  return api;
}

// ── file-backed store (bare repo layout) ──
export function fileStore(dir) {
  mkdirSync(join(dir, "objects"), { recursive: true });
  mkdirSync(join(dir, "refs/heads"), { recursive: true });
  if (!existsSync(join(dir, "HEAD"))) writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");

  return {
    get(hex) {
      const p = join(dir, "objects", hex.slice(0, 2), hex.slice(2));
      if (!existsSync(p)) return null;
      return readFileSync(p);
    },
    put(hex, loose) {
      const d = join(dir, "objects", hex.slice(0, 2));
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, hex.slice(2)), loose);
    },
    getRef(name) {
      const p = join(dir, name);
      if (!existsSync(p)) return null;
      return readFileSync(p, "utf8").trim();
    },
    putRef(name, sha) {
      const p = join(dir, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, sha + "\n");
    },
    heads() {
      // best effort: main then any single head (MVP)
      const m = join(dir, "refs/heads/main");
      if (existsSync(m)) return ["main"];
      try {
        return readdirSync(join(dir, "refs/heads"));
      } catch {
        return [];
      }
    },
  };
}

