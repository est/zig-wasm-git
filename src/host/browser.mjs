// src/host/browser.mjs — portable repo for Browser / CF Workers (no fs, no CLI).
// Zero node: imports. Only: WebAssembly, fetch, CompressionStream/
// DecompressionStream, crypto.subtle, TextEncoder/Decoder.
//
//   import { loadFromBytes, memoryStore } from "./browser.mjs";
//   const repo = loadFromBytes(wasmBytes, { store: memoryStore() });
//   await repo.fetch("https://git.example.com/repo.git", "main"); // smart HTTP v2
//   repo.get("main", ["README.md"]);      // [{path, oid, content: Uint8Array}]
//   repo.commit("", "init", {"a.txt": "hi"}); // -> sha (local; push to publish)
//
// Wire: git protocol weight lifting in wasm (wire.mjs); IO/compression/hash in JS.

import { memoryStore } from "./store.mjs";
import { bootWasm } from "./wire.mjs";
import * as wire from "./wire.mjs";
import { fetchIntoStore, lsRemote } from "./fetch.mjs";
import { createBlobService } from "./blob.mjs";
import { collectObjects, TYPE_NUM, ZERO_OID, decodeRefsTlv, decodeStatusTlv } from "./push.mjs";
import { deflateZlib } from "./codec.mjs";

const enc = new TextEncoder();
const dec = new TextDecoder();
const ERR_NAMES = { 1: "NotFound", 2: "PathIsDir", 3: "NotATree", 4: "NotABlob", 5: "BadCommit" };
const joinUrl = (base, path) => base.replace(/\/+$/, "") + path;

export { memoryStore, createBlobService };

export function loadFromBytes(wasmBytes, opts = {}) {
  const store = opts.store ?? memoryStore();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const subtle = opts.subtle ?? globalThis.crypto?.subtle;
  const { wasm, takeEmit } = bootWasm(wasmBytes);

  function allocBytes(b) {
    const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
    if (u8.length === 0) return { ptr: 0, len: 0 };
    const ptr = wasm.wasm_alloc(u8.length);
    if (!ptr) throw new Error("wasm_alloc failed (heap full; call reset between ops)");
    new Uint8Array(wasm.memory.buffer).set(u8, ptr);
    return { ptr, len: u8.length };
  }
  const allocStr = (s) => allocBytes(enc.encode(s));

  // Attach object-store callbacks by re-instantiating with host IO.
  // bootWasm used stubs; get/commit need real store access, so we rebind:
  // (re-instantiation is cheap; fetch-only callers never touch the store.)
  let bound = null;
  function storeWasm() {
    if (bound) return bound;
    const emitChunks = [];
    const mod = new WebAssembly.Module(wasmBytes);
    const inst = new WebAssembly.Instance(mod, {
      env: {
        host_emit_bytes(ptr, len) {
          emitChunks.push(new Uint8Array(inst.exports.memory.buffer.slice(ptr, ptr + len)));
        },
        host_log() {},
        host_get_object(oidHexPtr, outPtr, outCap, outLenPtr) {
          try {
            const hex = dec.decode(new Uint8Array(inst.exports.memory.buffer.slice(oidHexPtr, oidHexPtr + 40)));
            const obj = store.get(hex);
            if (!obj) return -1;
            const u8 = obj instanceof Uint8Array ? obj : new Uint8Array(obj);
            if (u8.length > outCap) {
              new DataView(inst.exports.memory.buffer).setUint32(outLenPtr >>> 0, u8.length, true);
              return 1;
            }
            if (u8.length > 0) new Uint8Array(inst.exports.memory.buffer).set(u8, outPtr);
            new DataView(inst.exports.memory.buffer).setUint32(outLenPtr >>> 0, u8.length, true);
            return 0;
          } catch {
            return -2;
          }
        },
        host_put_object(oidHexPtr, loosePtr, len) {
          try {
            const hex = dec.decode(new Uint8Array(inst.exports.memory.buffer.slice(oidHexPtr, oidHexPtr + 40)));
            store.put(hex, new Uint8Array(inst.exports.memory.buffer.slice(loosePtr, loosePtr + len)));
            return 0;
          } catch {
            return -2;
          }
        },
      },
    });
    bound = {
      wasm: inst.exports,
      takeEmit() {
        const parts = emitChunks.splice(0);
        let n = 0;
        for (const p of parts) n += p.length;
        const out = new Uint8Array(n);
        let o = 0;
        for (const p of parts) {
          out.set(p, o);
          o += p.length;
        }
        return out;
      },
    };
    return bound;
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

  function decodeGetTlv(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let pos = 0;
    const n = dv.getUint16(pos, true);
    pos += 2;
    const out = [];
    for (let i = 0; i < n; i++) {
      const status = u8[pos];
      pos += 1;
      const plen = dv.getUint16(pos, true);
      pos += 2;
      const path = dec.decode(u8.subarray(pos, pos + plen));
      pos += plen;
      if (status === 0) {
        const oidHex = Array.from(u8.subarray(pos, pos + 20), (b) => b.toString(16).padStart(2, "0")).join("");
        pos += 20;
        const clen = dv.getUint32(pos, true);
        pos += 4;
        const content = u8.slice(pos, pos + clen);
        pos += clen;
        out.push({ path, oid: oidHex, content });
      } else {
        out.push({ path, error: ERR_NAMES[status] ?? `Err${status}` });
      }
    }
    return out;
  }

  function encodeEntriesTlv(entries) {
    let n = 2;
    const ps = entries.map((e) => {
      const pb = enc.encode(e.path);
      const cb = e.content instanceof Uint8Array ? e.content : enc.encode(String(e.content));
      n += 2 + pb.length + 4 + cb.length;
      return { pb, cb };
    });
    const out = new Uint8Array(n);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, entries.length, true);
    let pos = 2;
    for (const { pb, cb } of ps) {
      dv.setUint16(pos, pb.length, true);
      pos += 2;
      out.set(pb, pos);
      pos += pb.length;
      dv.setUint32(pos, cb.length, true);
      pos += 4;
      out.set(cb, pos);
      pos += cb.length;
    }
    return out;
  }

  // Wrap a store-bound wasm instance with alloc helpers for one call.
  function withStore(fn) {
    const { wasm: w } = storeWasm();
    w.wasm_reset();
    const mem = () => new Uint8Array(w.memory.buffer);
    const ab = (b) => {
      const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
      if (!u8.length) return { ptr: 0, len: 0 };
      const ptr = w.wasm_alloc(u8.length);
      if (!ptr) throw new Error("wasm_alloc failed");
      mem().set(u8, ptr);
      return { ptr, len: u8.length };
    };
    const as = (s) => ab(enc.encode(s));
    const rs = (ptr, len) => dec.decode(mem().slice(ptr, ptr + len));
    return fn({ w, ab, as, rs, mem });
  }

  const repo = {
    get(ref, paths) {
      return withStore(({ w, as, mem }) => {
        const sha = resolveRef(ref);
        const oidHex = as(sha);
        const pj = as(paths.join("\n"));
        const outPtrAddr = w.wasm_alloc(4);
        const outLenAddr = w.wasm_alloc(4);
        const rc = w.wasm_get(oidHex.ptr, oidHex.len, pj.ptr, pj.len, outPtrAddr, outLenAddr);
        if (rc !== 0) throw new Error(`wasm_get rc=${rc}`);
        const dv = new DataView(w.memory.buffer);
        const tlvPtr = dv.getUint32(outPtrAddr, true);
        const tlvLen = dv.getUint32(outLenAddr, true);
        return decodeGetTlv(new Uint8Array(w.memory.buffer.slice(tlvPtr, tlvPtr + tlvLen)));
      });
    },

    commit(parentRef, message, entriesObj, updateRef = "refs/heads/main", options = {}) {
      return withStore(({ w, ab, as, rs }) => {
        const parent = parentRef ? resolveRef(parentRef) : "";
        const pHex = as(parent);
        const msg = as(message);
        const entries = Object.entries(entriesObj).map(([path, content]) => ({
          path,
          content: content instanceof Uint8Array ? content : enc.encode(String(content)),
        }));
        const ej = ab(encodeEntriesTlv(entries));
        const outHex = w.wasm_alloc(40);
        const author = options.author != null ? String(options.author) : "";
        const committer = options.committer != null ? String(options.committer) : author;
        const timeSec = options.time != null ? String(options.time) : "";
        const timezone = options.timezone != null ? String(options.timezone) : "+0000";
        const rc = w.wasm_commit2
          ? w.wasm_commit2(pHex.ptr, pHex.len, msg.ptr, msg.len, ej.ptr, ej.len,
              as(author).ptr, as(author).len, as(committer).ptr, as(committer).len,
              as(timeSec).ptr, as(timeSec).len, as(timezone).ptr, as(timezone).len, outHex)
          : w.wasm_commit(pHex.ptr, pHex.len, msg.ptr, msg.len, ej.ptr, ej.len, outHex);
        if (rc !== 0) throw new Error(`wasm_commit rc=${rc}`);
        const sha = rs(outHex, 40);
        if (updateRef) store.putRef(updateRef, sha);
        return sha;
      });
    },

    /** Fetch/clone a remote ref into this store (smart HTTP v2). */
    fetch(url, ref = "main", opts = {}) {
      return fetchIntoStore(wasm, store, url, ref, {
        fetchImpl,
        subtle,
        filter: opts.filter ?? "",
        setRef: opts.setRef,
        onProgress: opts.onProgress,
      });
    },

    /** Recent history without protocol (reads local store; async inflate). */
    async log(ref, limit = 10) {
      const { readLooseBody } = await import("./fetch.mjs");
      const sha0 = resolveRef(ref);
      const out = [];
      let cur = sha0;
      for (let i = 0; i < limit && cur; i++) {
        const loose = store.get(cur);
        if (!loose) break;
        const { body } = await readLooseBody(loose);
        const text = dec.decode(body);
        const lines = text.split("\n");
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

    lsRemote(url, opts = {}) {
      return lsRemote(wasm, url, { fetchImpl });
    },

    resolveRef,
    _wasm: wasm,
    _wire: wire,
    _takeEmit: takeEmit,

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

    async push(url, ref = "refs/heads/main", opts = {}) {
      const fi = opts.fetchImpl ?? fetchImpl;
      if (!fi) throw new Error("fetch unavailable on this platform (pass fetchImpl)");
      const fullRef = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
      const newOid = resolveRef(ref).toLowerCase();
      const discRes = await fi(joinUrl(url, "/info/refs?service=git-receive-pack"));
      if (!discRes.ok) throw new Error(`discovery http ${discRes.status}`);
      const advert = new Uint8Array(await discRes.arrayBuffer());
      wasm.wasm_reset();
      takeEmit();
      const adv = allocBytes(advert);
      const lrPtr = wasm.wasm_alloc(4);
      const lrLen = wasm.wasm_alloc(4);
      if (wasm.wasm_list_refs(adv.ptr, adv.len, lrPtr, lrLen) !== 0) throw new Error("wasm_list_refs failed");
      const dv = new DataView(wasm.memory.buffer);
      const refs = decodeRefsTlv(new Uint8Array(wasm.memory.buffer.slice(dv.getUint32(lrPtr, true), dv.getUint32(lrPtr, true) + dv.getUint32(lrLen, true))));
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
      const head = takeEmit();
      const reqBody = new Uint8Array(head.length + packBuf.length);
      reqBody.set(head, 0);
      reqBody.set(packBuf, head.length);
      const postRes = await fi(joinUrl(url, "/git-receive-pack"), {
        method: "POST",
        headers: { "Content-Type": "application/x-git-receive-pack-request" },
        body: reqBody,
      });
      if (!postRes.ok) throw new Error(`receive-pack http ${postRes.status}`);
      const stBuf = new Uint8Array(await postRes.arrayBuffer());
      wasm.wasm_reset();
      const sp = allocBytes(stBuf);
      const soPtr = wasm.wasm_alloc(4);
      const soLen = wasm.wasm_alloc(4);
      const rc = wasm.wasm_parse_report_status(sp.ptr, sp.len, soPtr, soLen);
      const sdv = new DataView(wasm.memory.buffer);
      const status = decodeStatusTlv(new Uint8Array(wasm.memory.buffer.slice(sdv.getUint32(soPtr, true), sdv.getUint32(soPtr, true) + sdv.getUint32(soLen, true))));
      if (rc === -2 || !status.unpackOk) throw new Error(`unpack failed: ${status.unpackMsg}`);
      if (rc !== 0) {
        const row = status.refs.find((r) => r.ref === fullRef);
        throw new Error(`push rejected: ${row ? `${row.ref}: ${row.msg}` : `rc=${rc}`}`);
      }
      return { updated: true, ref: fullRef, old, new: newOid, objects: objects.length, packBytes: packBuf.length };
    },
  };
  return repo;
}
