// zig-wasm-git high-level JS API (TLV framing)
//
//   import { load } from "./api.mjs";
//   const repo = await load("path/to/zig_wasm_git.wasm", { dir: "data/demo.git" });
//   repo.get("main", ["README.md", "src/a.txt"]);          // [{path, oid, content}|{path, error}]
//   repo.commit("", "init", { "a.txt": "hello" });          // -> commit sha

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import zlib from "node:zlib";
import { join, dirname } from "node:path";

const ERR_NAMES = { 1: "NotFound", 2: "PathIsDir", 3: "NotATree", 4: "NotABlob", 5: "BadCommit" };

export function memoryStore() {
  const objs = new Map();
  const refs = new Map();
  return {
    get(hex) {
      return objs.get(hex) ?? null;
    },
    put(hex, loose) {
      objs.set(hex, Buffer.from(loose));
    },
    getRef(name) {
      return refs.get(name) ?? null;
    },
    putRef(name, sha) {
      refs.set(name, sha);
    },
    heads() {
      const out = [];
      for (const k of refs.keys()) if (k.startsWith("refs/heads/")) out.push(k.slice("refs/heads/".length));
      return out;
    },
    dump() {
      return { objects: objs.size, refs: refs.size };
    },
  };
}

export function load(wasmPath, opts = {}) {
  const bytes = readFileSync(wasmPath);
  // 无 FS：直接传 store（Workers 侧零 FS）；有 FS：opts.dir 兜底
  const store = opts.store ?? (opts.dir != null ? fileStore(opts.dir) : memoryStore());
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
            new DataView(inst.exports.memory.buffer).setUint32(outLenPtr >>> 0, obj.length, true);
            return 1; // report required size
          }
          if (obj.length > 0) new Uint8Array(inst.exports.memory.buffer).set(obj, outPtr);
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

  function resolveRef(ref) {
    if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
    if (ref === "HEAD") {
      for (const b of store.heads()) {
        const v = store.getRef(`refs/heads/${b}`);
        if (v) return v;
      }
      throw new Error("HEAD: no branch exists yet");
    }
    for (const p of [`refs/heads/${ref}`, `refs/tags/${ref}`, ref]) {
      const v = store.getRef(p);
      if (v) return v;
    }
    throw new Error(`cannot resolve ref: ${ref}`);
  }

  /** decode get() TLV: u16 n; per entry: u8 st, u16 plen, path, [st==0: 20B oid, u32 clen, content] */
  function decodeGetTlv(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let pos = 0;
    const n = dv.getUint16(pos, true); pos += 2;
    const out = [];
    for (let i = 0; i < n; i++) {
      const status = buf[pos]; pos += 1;
      const plen = dv.getUint16(pos, true); pos += 2;
      const path = Buffer.from(buf.subarray(pos, pos + plen)).toString("utf8"); pos += plen;
      if (status === 0) {
        const oidHex = Buffer.from(buf.subarray(pos, pos + 20)).toString("hex"); pos += 20;
        const clen = dv.getUint32(pos, true); pos += 4;
        const content = Buffer.from(buf.subarray(pos, pos + clen)); pos += clen;
        out.push({ path, oid: oidHex, content });
      } else {
        out.push({ path, error: ERR_NAMES[status] ?? `Err${status}` });
      }
    }
    return out;
  }

  /** encode commit() entries as TLV: u16 n; per entry: u16 plen, path, u32 clen, content */
  function encodeEntriesTlv(entries) {
    const parts = [Buffer.alloc(2)];
    parts[0].writeUInt16LE(entries.length, 0);
    for (const e of entries) {
      const ph = Buffer.alloc(2); ph.writeUInt16LE(e.path.length, 0);
      const ch = Buffer.alloc(4); ch.writeUInt32LE(e.content.length, 0);
      parts.push(ph, Buffer.from(e.path, "utf8"), ch, e.content);
    }
    return Buffer.concat(parts);
  }

  return {
    get(ref, paths) {
      wasm.wasm_reset();
      const sha = resolveRef(ref);
      const oidHex = allocStr(sha);
      const pj = allocStr(paths.join("\n"));
      const outPtrAddr = wasm.wasm_alloc(4);
      const outLenAddr = wasm.wasm_alloc(4);
      const rc = wasm.wasm_get(oidHex.ptr, oidHex.len, pj.ptr, pj.len, outPtrAddr, outLenAddr);
      if (rc !== 0) throw new Error(`wasm_get rc=${rc}`);
      const dv = new DataView(wasm.memory.buffer);
      const tlvPtr = dv.getUint32(outPtrAddr, true);
      const tlvLen = dv.getUint32(outLenAddr, true);
      const mem = new Uint8Array(wasm.memory.buffer);
      return decodeGetTlv(Buffer.from(mem.slice(tlvPtr, tlvPtr + tlvLen)));
    },

    /** options: { author="<name> <email>", committer, time(sec), timezone } (all optional) */
    commit(parentRef, message, entriesObj, updateRef = "refs/heads/main", options = {}) {
      wasm.wasm_reset();
      const parent = parentRef ? resolveRef(parentRef) : "";
      const pHex = allocStr(parent);
      const msg = allocStr(message);
      const entries = Object.entries(entriesObj).map(([path, content]) => ({
        path,
        content: Buffer.isBuffer(content) ? content : Buffer.from(String(content)),
      }));
      const ej = allocBytes(encodeEntriesTlv(entries));
      const outHex = wasm.wasm_alloc(40);
      const author = options.author != null ? String(options.author) : "";
      const committer = options.committer != null ? String(options.committer) : author;
      const timeSec = options.time != null ? String(options.time) : "";
      const timezone = options.timezone != null ? String(options.timezone) : "+0000";
      const authorB = allocStr(author);
      const committerB = allocStr(committer);
      const timeB = allocStr(timeSec);
      const tzB = allocStr(timezone);
      const rc = wasm.wasm_commit2
        ? wasm.wasm_commit2(pHex.ptr, pHex.len, msg.ptr, msg.len, ej.ptr, ej.len, authorB.ptr, authorB.len, committerB.ptr, committerB.len, timeB.ptr, timeB.len, tzB.ptr, tzB.len, outHex)
        : wasm.wasm_commit(pHex.ptr, pHex.len, msg.ptr, msg.len, ej.ptr, ej.len, outHex);
      if (rc !== 0) throw new Error(`wasm_commit rc=${rc}`);
      const sha = readStr(outHex, 40);
      if (updateRef) store.putRef(updateRef, sha);
      return sha;
    },

    /** recent history: [{sha, tree, parents[], author, message}] — newest first, up to limit. */
    log(ref, limit = 10) {
      const sha0 = resolveRef(ref);
      const out = [];
      let cur = sha0;
      for (let i = 0; i < limit && cur; i++) {
        const loose = store.get(cur);
        if (!loose) break;
        const raw = zlib.inflateSync(loose); // "<type> <size>\0<body>"
        const nul = raw.indexOf(0);
        const body = raw.subarray(nul + 1).toString("utf8");
        const lines = body.split("\n");
        const hdrEnd = lines.indexOf("");
        const headers = lines.slice(0, hdrEnd);
        const message = lines.slice(hdrEnd + 1).join("\n").trim();
        const tree = (headers.find((l) => l.startsWith("tree ")) ?? "").slice(5);
        const parents = headers.filter((l) => l.startsWith("parent ")).map((l) => l.slice(7));
        const authorLine = headers.find((l) => l.startsWith("author ")) ?? "";
        out.push({ sha: cur, tree, parents, author: authorLine.slice(7), message });
        cur = parents[0];
      }
      return out;
    },

    resolveRef,
    _wasm: wasm,
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
      try {
        return readdirSync(join(dir, "refs/heads"));
      } catch {
        return [];
      }
    },
  };
}
