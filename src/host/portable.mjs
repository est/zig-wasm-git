// src/host/portable.mjs — RemoteGit: git remote as a versioned blob store.
// Browser / CF Workers / Node (no fs, no CLI). Single export; everything else
// is internal. Requires WebAssembly, fetch, CompressionStream,
// crypto.subtle, TextEncoder/Decoder (Node 18+/Workers/modern browsers).
//
//   import { RemoteGit } from "./portable.mjs";
//   const git = await RemoteGit.open("https://host/team/docs.git", {
//     wasm: "https://host/zig_wasm_git.wasm", // url | path (Node) | bytes | Module
//     ref: "main",
//   });
//   await git.getMany(["README.md"]);          // Map(path -> Uint8Array, missing skipped)
//   await git.putMany({ "a.txt": "hi" }, "update greeting"); // -> commit sha
//   await git.push();                          // fast-forward only
//
// Model: one branch == one keyspace (path -> bytes), one commit == one version.
// Missing keys are skipped (getMany) / null, never errors. pull/push move the
// tip; push rejects on non-fast-forward (last-writer-wins, no merge).
// All methods are async and serialized internally (one shared wasm memory).

import { memoryStore, deflateZlib, joinUrl, withBasicAuth, looseBody, enc, dec, hexOfBytes, concatU8, parseCommit, parseTreeEntries, commitParentsAndTree } from "./utils.mjs";
import {
  fetchIntoStore, lsRemote,
  collectObjects, TYPE_NUM, ZERO_OID, decodeRefsTlv, decodeStatusTlv,
} from "./sync.mjs";

const ERR_NAMES = { 1: "NotFound", 2: "PathIsDir", 3: "NotATree", 4: "NotABlob", 5: "BadCommit" };

export { memoryStore };

/// All file blobs under one commit: [{path, oid}]. Trees walked once;
/// gitlinks skipped (never materialized as blobs).
async function collectBlobs(store, commitSha) {
  const out = [];
  const { body: cbody } = await looseBody(store.get(commitSha));
  const root = commitParentsAndTree(cbody).tree;
  const stack = root ? [[root, ""]] : [];
  while (stack.length) {
    const [treeHex, pre] = stack.pop();
    const loose = store.get(treeHex);
    if (!loose) continue;
    const { body } = await looseBody(loose);
    for (const e of parseTreeEntries(body)) {
      if (e.mode === "40000" || e.mode === "040000") stack.push([e.oid, pre + e.name + "/"]);
      else if (e.mode !== "160000") out.push({ path: pre + e.name, oid: e.oid });
    }
  }
  return out;
}

const toU8 = (v) => (v instanceof Uint8Array ? v : enc.encode(v ?? ""));

/// Node-only fs probe: runtime string lookup, no static `node:` import —
/// the neutral bundle keeps building and browsers/workers never touch it.
/// old Node: do it yourself (pass bytes).
function nodeFs() {
  const g = process?.getBuiltinModule;
  if (typeof g === "function") {
    try {
      return g("node:fs");
    } catch {}
  }
  return null;
}

/*
  Normalize { wasm } to raw bytes. Accepted:
    - string: http(s) url, else a Node filesystem path
    - precompiled Module, typed array or ArrayBuffer (passed to instantiate as-is)
  Omitted: zig_wasm_git.wasm next to this module (fixed-name release files
  ship together; Node reads it, browsers fetch it). workerd has neither —
  pass the Module explicitly. Anything else fails in instantiate; figure it out.
*/
async function resolveWasmInput(wasmOpt) {
  if (wasmOpt instanceof WebAssembly.Module) return wasmOpt;
  if (wasmOpt == null) wasmOpt = new URL("zig_wasm_git.wasm", import.meta.url).href;
  if (typeof wasmOpt !== "string") return wasmOpt; // typed array / ArrayBuffer; instantiate validates
  const href = wasmOpt;
  // Local file first: non-http(s) string on Node (plain path or file: URL).
  // Browsers skip this (no getBuiltinModule) and fetch instead.
  if (!/^https?:\/\//.test(href)) {
    const fs = nodeFs();
    if (fs) return new Uint8Array(fs.readFileSync(href.startsWith("file:") ? new URL(href) : href));
  }
  const r = await fetch(href);
  if (!r.ok) throw new Error(`wasm fetch http ${r.status}: ${href}`);
  return new Uint8Array(await r.arrayBuffer());
}

export class RemoteGit {
  /// Async factory: boots wasm (async instantiate, works under workerd CSP)
  /// before returning. All instance methods serialize on one wasm memory.
  static async open(url, opts = {}) {
    const g = new RemoteGit(url, opts);
    await g._boot(opts.wasm);
    return g;
  }

  constructor(url, opts = {}) {
    this.url = url;
    this.ref = opts.ref?.startsWith("refs/") ? opts.ref : `refs/heads/${opts.ref ?? "main"}`;
    this._store = opts.store ?? memoryStore();
    this._fetchImplOpt = opts.fetchImpl ?? null;
    this._subtleOpt = opts.subtle ?? null;
    this._auth = opts.auth ?? null;
    this._author = opts.author;
    this._committer = opts.committer;
    this._timezone = opts.timezone;
    this._tail = Promise.resolve();
    this._wasm = null;
  }

  async _boot(wasmOpt) {
    const input = await resolveWasmInput(wasmOpt);
    const store = this._store;
    const emitChunks = [];
    let inst;
    const imports = {
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
    };
    // Async instantiate: bytes compile off-thread; precompiled Modules
    // (workerd CompiledWasm) instantiate directly with no codegen.
    const r = await WebAssembly.instantiate(input, imports);
    inst = r instanceof WebAssembly.Instance ? r : r.instance;
    this._wasm = inst.exports;
    this._takeEmit = () => concatU8(emitChunks.splice(0));
  }

  _net() {
    let f = withBasicAuth(this._fetchImplOpt ?? globalThis.fetch.bind(globalThis));
    if (this._auth != null) {
      const inner = f;
      // "user:pass" -> Basic; anything else ("Bearer x", "Basic y") verbatim.
      const value = typeof this._auth === "string" && !/^\S+\s/.test(this._auth) && this._auth.includes(":")
        ? `Basic ${btoa(String.fromCharCode(...enc.encode(this._auth)))}`
        : this._auth;
      f = (url, init) => {
        const headers = new Headers(init?.headers);
        if (!headers.has("authorization")) headers.set("authorization", value);
        return inner(url, { ...init, headers });
      };
    }
    return { fetchImpl: f, subtle: this._subtleOpt ?? globalThis.crypto.subtle };
  }

  /// Serialize async ops (single shared wasm memory).
  _seq(fn) {
    const t = this._tail.then(fn, fn);
    this._tail = t.catch(() => {});
    return t;
  }

  _resolveRef(ref) {
    const store = this._store;
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

  _withStore(fn) {
    const w = this._wasm;
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

  _decodeGetTlv(buf) {
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
        const oidHex = hexOfBytes(u8.subarray(pos, pos + 20));
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

  _encodeEntriesTlv(entries) {
    let n = 2;
    const ps = entries.map((e) => {
      const pb = enc.encode(e.path);
      const cb = e.content instanceof Uint8Array ? e.content : enc.encode(e.content);
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

  _getInner(ref, paths) {
    return this._withStore(({ w, as, mem }) => {
      const sha = this._resolveRef(ref);
      const oidHex = as(sha);
      const pj = as(paths.join("\n"));
      const outPtrAddr = w.wasm_alloc(4);
      const outLenAddr = w.wasm_alloc(4);
      const rc = w.wasm_get(oidHex.ptr, oidHex.len, pj.ptr, pj.len, outPtrAddr, outLenAddr);
      if (rc !== 0) throw new Error(`wasm_get rc=${rc}`);
      const dv = new DataView(w.memory.buffer);
      const tlvPtr = dv.getUint32(outPtrAddr, true);
      const tlvLen = dv.getUint32(outLenAddr, true);
      return this._decodeGetTlv(new Uint8Array(w.memory.buffer.slice(tlvPtr, tlvPtr + tlvLen)));
    });
  }

  _commitInner(parent, message, entriesObj, options = {}) {
    return this._withStore(({ w, ab, as, rs }) => {
      const pHex = as(parent);
      const msg = as(message);
      const entries = Object.entries(entriesObj).map(([path, content]) => ({
        path,
        content: typeof content === "string" ? enc.encode(content) : content,
      }));
      const ej = ab(this._encodeEntriesTlv(entries));
      const outHex = w.wasm_alloc(40);
      const author = options.author != null ? String(options.author) : "";
      const committer = options.committer != null ? String(options.committer) : author;
      const timeSec = options.time != null ? String(options.time) : String(Math.floor(Date.now() / 1000));
      const timezone = options.timezone != null ? String(options.timezone) : "+0000";
      const rc = w.wasm_commit2
        ? w.wasm_commit2(pHex.ptr, pHex.len, msg.ptr, msg.len, ej.ptr, ej.len,
            as(author).ptr, as(author).len, as(committer).ptr, as(committer).len,
            as(timeSec).ptr, as(timeSec).len, as(timezone).ptr, as(timezone).len, outHex)
        : w.wasm_commit(pHex.ptr, pHex.len, msg.ptr, msg.len, ej.ptr, ej.len, outHex);
      if (rc !== 0) throw new Error(`wasm_commit rc=${rc}`);
      const sha = rs(outHex, 40);
      if (this.ref) this._store.putRef(this.ref, sha);
      return sha;
    });
  }

  /// Local tip, else structure-only bootstrap (blob:none; falls back to a
  /// full pull on servers without filter support). Null when unreachable.
  async _tipInner() {
    try {
      return this._resolveRef(this.ref);
    } catch { /* empty store: bootstrap below */ }
    try {
      await this._pullInner({ filter: "blob:none" });
    } catch {
      try {
        await this._pullInner({});
      } catch {
        return null;
      }
    }
    try {
      return this._resolveRef(this.ref);
    } catch {
      return null;
    }
  }

  /// Batched read: memory hits first, then ONE `want=[oids]` roundtrip for
  /// all missing blobs, then re-read. Unknown paths and gc'd blobs stay
  /// missing (skipped), never fail the batch.
  async _getManyInner(paths) {
    const out = new Map();
    const tip = await this._tipInner();
    if (!tip || !paths.length) return out;
    const rows = this._getInner(this.ref, paths);
    const missing = [];
    for (const row of rows) {
      if (!row.error) out.set(row.path, row.content);
      else missing.push(row.path);
    }
    if (!missing.length) return out;
    const byPath = new Map((await collectBlobs(this._store, tip)).map((e) => [e.path, e.oid]));
    const oids = [...new Set(missing.map((p) => byPath.get(p)).filter(Boolean))];
    if (oids.length) {
      try {
        // setRef:false: the branch keeps pointing at the commit, not the blobs.
        await fetchIntoStore(this._wasm, this._store, this.url, oids, { setRef: false, ...this._net() });
      } catch {
        /* gc'd blobs stay missing */
      }
      for (const row of this._getInner(this.ref, missing)) {
        if (!row.error) out.set(row.path, row.content);
      }
    }
    return out;
  }

  _pullInner(opts = {}) {
    return fetchIntoStore(this._wasm, this._store, this.url, this.ref, { ...this._net(), ...opts });
  }

  async _packObjects(objects) {
    const w = this._wasm;
    w.wasm_reset();
    this._takeEmit();
    const allocBytes = (b) => {
      const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
      if (u8.length === 0) return { ptr: 0, len: 0 };
      const ptr = w.wasm_alloc(u8.length);
      if (!ptr) throw new Error("wasm_alloc failed (heap full; call reset between ops)");
      new Uint8Array(w.memory.buffer).set(u8, ptr);
      return { ptr, len: u8.length };
    };
    const devs = [];
    for (const o of objects) devs.push(await deflateZlib(o.body));
    if (w.wasm_pack_begin(objects.length) !== 0) throw new Error("wasm_pack_begin failed");
    for (let i = 0; i < objects.length; i++) {
      const o = objects[i];
      const tn = TYPE_NUM[o.type];
      if (!tn) throw new Error(`unknown type: ${o.type}`);
      const d = allocBytes(devs[i]);
      const rc = w.wasm_pack_add(tn, o.body.length, d.ptr, d.len);
      if (rc !== 0) throw new Error(`wasm_pack_add failed rc=${rc}`);
    }
    if (w.wasm_pack_end() !== 0) throw new Error("wasm_pack_end failed");
    return this._takeEmit();
  }

  async _pushInner(opts = {}) {
    const w = this._wasm;
    const store = this._store;
    const fi = opts.fetchImpl ?? this._net().fetchImpl;
    const newOid = this._resolveRef(this.ref).toLowerCase();
    const discRes = await fi(joinUrl(this.url, "/info/refs?service=git-receive-pack"));
    if (!discRes.ok) throw new Error(`discovery http ${discRes.status}`);
    const advert = new Uint8Array(await discRes.arrayBuffer());
    const allocBytes = (b) => {
      const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
      if (!u8.length) return { ptr: 0, len: 0 };
      const ptr = w.wasm_alloc(u8.length);
      if (!ptr) throw new Error("wasm_alloc failed");
      new Uint8Array(w.memory.buffer).set(u8, ptr);
      return { ptr, len: u8.length };
    };
    const allocStr = (s) => allocBytes(enc.encode(s));
    w.wasm_reset();
    this._takeEmit();
    const adv = allocBytes(advert);
    const lrPtrAddr = w.wasm_alloc(4);
    const lrLenAddr = w.wasm_alloc(4);
    if (w.wasm_list_refs(adv.ptr, adv.len, lrPtrAddr, lrLenAddr) !== 0) throw new Error("wasm_list_refs failed");
    const dv = new DataView(w.memory.buffer);
    const lrPtr = dv.getUint32(lrPtrAddr, true);
    const refs = decodeRefsTlv(new Uint8Array(w.memory.buffer.slice(lrPtr, lrPtr + dv.getUint32(lrLenAddr, true))));
    const remote = refs.find((r) => r.name === this.ref);
    const old = remote ? remote.oid.toLowerCase() : ZERO_OID;
    if (old === newOid) return { updated: false, ref: this.ref, old, new: newOid, reason: "already-up-to-date" };
    if (old !== ZERO_OID) {
      // Client-side fast-forward check (stock git rejects locally too):
      // `receive-pack` accepts empty-pack rewinds with `ok`, so the server
      // is not a reliable backstop. old must be reachable from newOid.
      const seen = new Set([newOid]);
      const queue = [newOid];
      let ff = false;
      while (queue.length && seen.size < 20000) {
        const hex = queue.pop();
        if (hex === old) {
          ff = true;
          break;
        }
        const loose = store.get(hex);
        if (!loose) continue;
        const { type, body } = await looseBody(loose);
        if (type !== "commit") continue;
        for (const p of commitParentsAndTree(body).parents) {
          const lp = p.toLowerCase();
          if (!seen.has(lp)) {
            seen.add(lp);
            queue.push(lp);
          }
        }
      }
      if (!ff) {
        throw new Error(`push rejected: non-fast-forward (remote ${old.slice(0, 7)} is not an ancestor of ${newOid.slice(0, 7)}; pull first)`);
      }
    }
    const haves = new Set(old === ZERO_OID ? refs.map((r) => r.oid) : [old]);
    const objects = await collectObjects(store, newOid, haves);
    const packBuf = await this._packObjects(objects);
    w.wasm_reset();
    this._takeEmit();
    const oHex = allocStr(old);
    const nHex = allocStr(newOid);
    const rf = allocStr(this.ref);
    const caps = allocStr("report-status");
    if (w.wasm_build_ref_update(oHex.ptr, oHex.len, nHex.ptr, nHex.len, rf.ptr, rf.len, caps.ptr, caps.len) !== 0) {
      throw new Error("wasm_build_ref_update failed");
    }
    const head = this._takeEmit();
    const reqBody = new Uint8Array(head.length + packBuf.length);
    reqBody.set(head, 0);
    reqBody.set(packBuf, head.length);
    const postRes = await fi(joinUrl(this.url, "/git-receive-pack"), {
      method: "POST",
      headers: { "Content-Type": "application/x-git-receive-pack-request" },
      body: reqBody,
    });
    if (!postRes.ok) throw new Error(`receive-pack http ${postRes.status}`);
    const stBuf = new Uint8Array(await postRes.arrayBuffer());
    w.wasm_reset();
    const sp = allocBytes(stBuf);
    const soPtrAddr = w.wasm_alloc(4);
    const soLenAddr = w.wasm_alloc(4);
    const rc = w.wasm_parse_report_status(sp.ptr, sp.len, soPtrAddr, soLenAddr);
    const sdv = new DataView(w.memory.buffer);
    const soPtr = sdv.getUint32(soPtrAddr, true);
    const status = decodeStatusTlv(new Uint8Array(w.memory.buffer.slice(soPtr, soPtr + sdv.getUint32(soLenAddr, true))));
    if (rc === -2 || !status.unpackOk) throw new Error(`unpack failed: ${status.unpackMsg}`);
    if (rc !== 0) {
      const row = status.refs.find((r) => r.ref === this.ref);
      throw new Error(`push rejected: ${row ? `${row.ref}: ${row.msg}` : `rc=${rc}`}`);
    }
    return { updated: true, ref: this.ref, old, new: newOid, objects: objects.length, packBytes: packBuf.length };
  }

  // ── public: all async ──

  /// Local tip oid, or null when the keyspace is empty.
  async version() {
    return this._seq(async () => {
      try {
        return this._resolveRef(this.ref);
      } catch {
        return null;
      }
    });
  }

  /// Remote tip oid without touching the store. Null when the ref doesn't
  /// exist remotely; throws on network failure.
  async remoteVersion() {
    return this._seq(async () => {
      const refs = await lsRemote(this._wasm, this.url, { fetchImpl: this._net().fetchImpl });
      return refs.find((r) => r.name === this.ref)?.oid ?? null;
    });
  }

  /// Batch read: Map(path -> Uint8Array), missing keys skipped.
  /// Unknown paths cost zero RTT; known-but-absent blobs are fetched in one
  /// `want=[oids]` roundtrip.
  async getMany(paths) {
    return this._seq(() => this._getManyInner(paths ?? []));
  }

  /// Batch write (upsert): each call appends one version (commit) on the tip.
  /// Returns the new version sha. { parent } enables compare-and-swap: throws
  /// locally when the tip moved since you read it.
  async putMany(entries, message = "update", options = {}) {
    const { parent: expected, ...rest } = options;
    return this._seq(async () => {
      let tip = null;
      try {
        tip = this._resolveRef(this.ref);
      } catch { /* empty keyspace */ }
      if (expected != null && (tip ?? "") !== expected) {
        throw new Error(`CAS mismatch: tip ${(tip ?? "").slice(0, 7) || "(empty)"} != expected ${String(expected).slice(0, 7)}`);
      }
      const flat = {};
      for (const [path, content] of Object.entries(entries ?? {})) {
        flat[path] = content instanceof Uint8Array ? content : toU8(content);
      }
      return this._commitInner(expected ?? tip ?? "", message, flat, {
        ...(this._author != null ? { author: this._author } : null),
        ...(this._committer != null ? { committer: this._committer } : null),
        ...(this._timezone != null ? { timezone: this._timezone } : null),
        ...rest,
      });
    });
  }

  /// Key enumeration: [{path, oid}], optionally filtered by prefix.
  /// Local-only once the tip is known (first call bootstraps structure).
  async list(prefix = "") {
    return this._seq(async () => {
      const tip = await this._tipInner();
      if (!tip) return [];
      const all = await collectBlobs(this._store, tip);
      return prefix ? all.filter((e) => e.path.startsWith(prefix)) : all;
    });
  }

  /// Recent history: [{sha, tree, parents[], author, message}], newest first.
  async log(limit = 10) {
    const out = [];
    let cur;
    try {
      cur = this._resolveRef(this.ref);
    } catch {
      return out;
    }
    for (let i = 0; i < limit && cur; i++) {
      const loose = this._store.get(cur);
      if (!loose) break;
      const { body } = await looseBody(loose);
      const row = parseCommit(cur, dec.decode(body));
      out.push(row);
      cur = row.parents[0];
    }
    return out;
  }

  /// Full pull (explicit refresh). No merge: unpushed writes must be pushed
  /// first, else the fetch moves the tip underneath them.
  async pull(opts = {}) {
    return this._seq(() => this._pullInner(opts));
  }

  /// Fast-forward publish of the local tip; rejects on non-fast-forward.
  async push(opts = {}) {
    return this._seq(() => this._pushInner({ ...this._net(), ...opts }));
  }

  /// One-shot: pull latest, then return the requested keys.
  async sync(paths, opts = {}) {
    return this._seq(async () => {
      await this._pullInner(opts.pull ?? {});
      return this._getManyInner(paths ?? []);
    });
  }
}
