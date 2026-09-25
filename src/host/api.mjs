// zig-wasm-git high-level JS API (TLV framing)
//
//   import { load } from "./api.mjs";
//   const repo = await load("path/to/zig_wasm_git.wasm", { dir: "data/demo.git" });
//   repo.get("main", ["README.md", "src/a.txt"]);          // [{path, oid, content}|{path, error}]
//   repo.commit("", "init", { "a.txt": "hello" });          // -> commit sha

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import zlib from "node:zlib";
import { join, dirname } from "node:path";
import { collectObjects, decodeRefsTlv, decodeStatusTlv, TYPE_NUM, ZERO_OID, joinUrl, deflateZlib } from "./push.mjs";
import { createBlobService } from "./blob.mjs";

const ERR_NAMES = { 1: "NotFound", 2: "PathIsDir", 3: "NotATree", 4: "NotABlob", 5: "BadCommit" };

export { createBlobService };

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
  const emitChunks = [];
  const takeEmit = () => {
    const out = Buffer.concat(emitChunks.splice(0));
    return out;
  };

  const mod = new WebAssembly.Module(bytes);
  inst = new WebAssembly.Instance(mod, {
    env: {
      host_emit_bytes(ptr, len) {
        const mem = new Uint8Array(inst.exports.memory.buffer);
        emitChunks.push(Buffer.from(mem.slice(ptr, ptr + len)));
      },
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

    /** 低层 pack 组装:objects=[{hex, type, body}] -> pack Buffer(线协议在 wasm,压缩在 JS) */
    async pushPack(objects) {
      wasm.wasm_reset();
      takeEmit();
      const devs = [];
      for (const o of objects) devs.push(await deflateZlib(o.body));
      if (wasm.wasm_pack_begin(objects.length) !== 0) throw new Error("wasm_pack_begin failed");
      for (let i = 0; i < objects.length; i++) {
        const o = objects[i];
        const tn = TYPE_NUM[o.type];
        if (!tn) throw new Error(`unknown type: ${o.type}`);
        const d = allocBytes(devs[i]);
        const rc = wasm.wasm_pack_add(tn, o.body.length, d.ptr, d.len);
        if (rc !== 0) throw new Error(`wasm_pack_add failed rc=${rc}`);
      }
      if (wasm.wasm_pack_end() !== 0) throw new Error("wasm_pack_end failed");
      return takeEmit();
    },

    /** fetch/clone: smart HTTP v2 -> unpack(delta) -> store (无 FS/CLI,Worker 同代码) */
    async fetch(url, ref = "main", opts = {}) {
      const { fetchIntoStore } = await import("./fetch.mjs");
      return fetchIntoStore(wasm, store, url, ref, {
        fetchImpl: opts.fetchImpl ?? fetch,
        subtle: opts.subtle ?? globalThis.crypto?.subtle,
        filter: opts.filter ?? "",
        setRef: opts.setRef,
        onProgress: opts.onProgress,
      });
    },

    /** clone 别名:fetch + 落 ref(语义同 fetch,setRef 默认 true) */
    async clone(url, ref = "main", opts = {}) {
      return this.fetch(url, ref, opts);
    },

    async lsRemote(url, opts = {}) {
      const { lsRemote } = await import("./fetch.mjs");
      return lsRemote(wasm, url, { fetchImpl: opts.fetchImpl ?? fetch });
    },

    /** push(ref):discovery -> collect -> pack -> receive-pack,真 git 语义 */
    async push(url, ref = "refs/heads/main", { fetchImpl = fetch } = {}) {
      const fullRef = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
      const newOid = resolveRef(ref).toLowerCase();
      const discRes = await fetchImpl(joinUrl(url, "/info/refs?service=git-receive-pack"));
      if (!discRes.ok) throw new Error(`discovery http ${discRes.status}`);
      const advert = Buffer.from(await discRes.arrayBuffer());
      wasm.wasm_reset();
      takeEmit();
      const adv = allocBytes(advert);
      const lrPtr = wasm.wasm_alloc(4);
      const lrLen = wasm.wasm_alloc(4);
      if (wasm.wasm_list_refs(adv.ptr, adv.len, lrPtr, lrLen) !== 0) throw new Error("wasm_list_refs failed");
      const dv = new DataView(wasm.memory.buffer);
      const refs = decodeRefsTlv(Buffer.from(new Uint8Array(wasm.memory.buffer).slice(dv.getUint32(lrPtr, true), dv.getUint32(lrPtr, true) + dv.getUint32(lrLen, true))));
      const remote = refs.find((r) => r.name === fullRef);
      const old = remote ? remote.oid.toLowerCase() : ZERO_OID;
      if (old === newOid) return { updated: false, ref: fullRef, old, new: newOid, reason: "already-up-to-date" };
      const haves = new Set(old === ZERO_OID ? refs.map((r) => r.oid) : [old]);
      const objects = await collectObjects(store, newOid, haves);
      const packBuf = await this.pushPack(objects);
      wasm.wasm_reset();
      takeEmit();
      const oHex = allocStr(old);
      const nHex = allocStr(newOid);
      const rf = allocStr(fullRef);
      const caps = allocStr("report-status");
      if (wasm.wasm_build_ref_update(oHex.ptr, oHex.len, nHex.ptr, nHex.len, rf.ptr, rf.len, caps.ptr, caps.len) !== 0) {
        throw new Error("wasm_build_ref_update failed");
      }
      const reqBody = Buffer.concat([takeEmit(), packBuf]);
      const postRes = await fetchImpl(joinUrl(url, "/git-receive-pack"), {
        method: "POST",
        headers: { "Content-Type": "application/x-git-receive-pack-request" },
        body: reqBody,
      });
      if (!postRes.ok) throw new Error(`receive-pack http ${postRes.status}`);
      const stBuf = Buffer.from(await postRes.arrayBuffer());
      wasm.wasm_reset();
      const sp = allocBytes(stBuf);
      const soPtr = wasm.wasm_alloc(4);
      const soLen = wasm.wasm_alloc(4);
      const rc = wasm.wasm_parse_report_status(sp.ptr, sp.len, soPtr, soLen);
      const sdv = new DataView(wasm.memory.buffer);
      const status = decodeStatusTlv(Buffer.from(new Uint8Array(wasm.memory.buffer).slice(sdv.getUint32(soPtr, true), sdv.getUint32(soPtr, true) + sdv.getUint32(soLen, true))));
      if (rc === -2 || !status.unpackOk) throw new Error(`unpack failed: ${status.unpackMsg}`);
      if (rc !== 0) {
        const row = status.refs.find((r) => r.ref === fullRef);
        throw new Error(`push rejected: ${row ? `${row.ref}: ${row.msg}` : `rc=${rc}`}`);
      }
      return { updated: true, ref: fullRef, old, new: newOid, objects: objects.length, packBytes: packBuf.length };
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
