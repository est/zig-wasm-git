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
//   await git.close();                         // release the wasm instance
//
// Model: one branch == one keyspace (path -> bytes), one commit == one version.
// Missing keys are skipped (getMany) / null, never errors — but a *network*
// failure is always thrown, never reported as an empty result. pull/push move
// the tip; push rejects on non-fast-forward (last-writer-wins, no merge).
//
// All public methods are async and run through one serializer, so they share a
// single ordering. wasm memory is shared too, which is why the queue exists;
// log() is local and never touches wasm, but is queued all the same so every
// method has the same ordering guarantee.
//
// close() releases the wasm instance and its linear memory. Call it when done;
// it waits for in-flight work first. After close(), methods throw CLOSED.
//
// Failures: every throw is a RemoteGitError with a stable `.code` (see ERR in
// utils.mjs) plus the original error in `.cause` where one exists.

import { memoryStore, deflateZlib, joinUrl, withBasicAuth, looseBody, enc, dec, hexOfBytes, concatU8, parseCommit, parseTreeEntries, commitParentsAndTree, netFetch, assertSyncStore, assertKeys, keyProblem, failed, isGitError, ERR, RemoteGitError } from "./utils.mjs";
import {
  fetchIntoStore, lsRemote,
  collectObjects, TYPE_NUM, ZERO_OID, decodeRefsTlv, decodeStatusTlv,
} from "./sync.mjs";

const ERR_NAMES = { 1: "NotFound", 2: "PathIsDir", 3: "NotATree", 4: "NotABlob", 5: "BadCommit" };

export { memoryStore, ERR, RemoteGitError, isGitError, keyProblem };

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

/// Write value -> bytes. Strings and byte views are what a caller actually
/// has; anything else is refused rather than silently stringified (an object
/// would land in git as the 15 bytes "[object Object]").
function toU8(v) {
  if (typeof v === "string") return enc.encode(v);
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  failed(ERR.BAD_ARG, `blob content must be a string or Uint8Array/ArrayBuffer; got ${typeName(v)}`);
}

const typeName = (v) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? v.constructor?.name ?? "object" : typeof v;

/// Keys argument -> array. A bare string is accepted as a one-key read, since
/// reading a single known key is the most common case there is.
const keyList = (paths) => (paths == null ? [] : typeof paths === "string" ? [paths] : [...paths]);

/// putMany entries -> [path, bytes] pairs. An object literal is the natural way
/// to write several named values in JS and stays the documented form; a Map is
/// accepted because callers often already hold one.
function entryPairs(entries) {
  if (entries == null) return [];
  if (entries instanceof Map) return [...entries].map(([k, v]) => [k, toU8(v)]);
  if (typeof entries !== "object" || Array.isArray(entries)) {
    failed(ERR.BAD_ARG, `putMany entries must be an object or Map; got ${typeName(entries)}`);
  }
  return Object.entries(entries).map(([k, v]) => [k, toU8(v)]);
}

/// Node-only fs probe: runtime string lookup, no static `node:` import —
/// the neutral bundle keeps building and browsers/workers never touch it.
/// Absent before Node 22.3 (process.getBuiltinModule) and in every non-Node
/// runtime; those callers pass bytes or an http(s) url instead.
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
  if (wasmOpt && (wasmOpt instanceof WebAssembly.Module || typeof wasmOpt !== "string")) {
    return wasmOpt; // typed array / ArrayBuffer; instantiate validates
  }
  // falsy, or a string
  const explicit = typeof wasmOpt === "string";
  const href = wasmOpt?.trim() || new URL("zig_wasm_git.wasm", import.meta.url).href;
  // Local file first: non-http(s) string on Node (plain path or file: URL).
  // Browsers skip this (no getBuiltinModule) and fetch instead.
  if (!/^https?:\/\//.test(href)) {
    const fs = nodeFs();
    if (fs) return new Uint8Array(fs.readFileSync(href.startsWith("file:") ? new URL(href) : href));
    // No filesystem to read it with, and it is not fetchable either (fetch
    // rejects file:// and bare paths outright). Falling through would surface a
    // NETWORK error, which reads as "your connection is down" and invites a
    // retry that can never succeed. Say what is actually missing.
    failed(
      ERR.BAD_ARG,
      explicit
        ? `cannot read the wasm from a filesystem path on this runtime (no Node fs): ${href}. ` +
          `Pass the bytes, a WebAssembly.Module, or an http(s) url instead.`
        : `cannot read zig_wasm_git.wasm next to this module on this runtime (no Node fs, ` +
          `so the default location ${href} is unreachable). Node before 22.3 lacks ` +
          `process.getBuiltinModule; upgrade, or pass { wasm } as bytes / an http(s) url.`,
      { ref: href },
    );
  }
  const r = await netFetch(fetch, href, undefined, `wasm fetch ${href}`);
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
    this._closed = false;
  }

  async _boot(wasmOpt) {
    // Fail before instantiating: a store that breaks the sync contract would
    // otherwise write commits this instance cannot read back, silently.
    assertSyncStore(this._store);
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
    this._assertLive();
    const t = this._tail.then(fn, fn);
    this._tail = t.catch(() => {});
    return t;
  }

  /// Guard every operation that needs a live wasm instance. The constructor is
  /// public (so `new RemoteGit(...)` type-checks), but an unbooted or closed
  /// instance has no wasm memory — say so instead of failing later with
  /// "Cannot read properties of null (reading 'wasm_reset')".
  _assertLive() {
    if (this._closed) {
      failed(ERR.CLOSED, "RemoteGit is closed (close() released the wasm instance)");
    }
    if (!this._wasm) {
      failed(
        ERR.CLOSED,
        "RemoteGit was never opened — use `await RemoteGit.open(url, opts)` " +
          "(instantiation is async, so the constructor cannot boot wasm)",
      );
    }
  }

  _resolveRef(ref) {
    const store = this._store;
    if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
    if (ref === "HEAD") {
      for (const b of store.heads()) {
        const v = store.getRef(`refs/heads/${b}`);
        if (v) return v;
      }
      failed(ERR.BAD_REF, "HEAD: no branch exists yet", { ref });
    }
    for (const p of [`refs/heads/${ref}`, `refs/tags/${ref}`, ref]) {
      const v = store.getRef(p);
      if (v) return v;
    }
    failed(ERR.BAD_REF, `cannot resolve ref: ${ref}`, { ref });
  }

  _withStore(fn) {
    const w = this._wasm;
    w.wasm_reset();
    const mem = () => new Uint8Array(w.memory.buffer);
    const ab = (b) => {
      const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
      if (!u8.length) return { ptr: 0, len: 0 };
      const ptr = w.wasm_alloc(u8.length);
      if (!ptr) failed(ERR.WASM_ALLOC, "wasm_alloc failed (heap full; call reset between ops)");
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
      if (rc !== 0) failed(ERR.WASM_RC, `wasm_get rc=${rc}`);
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
      if (rc !== 0) {
        // -14: wasm refused a path (defense in depth behind assertKeys).
        failed(rc === -14 ? ERR.BAD_TREE_PATH : ERR.WASM_RC, `wasm_commit rc=${rc}`);
      }
      const sha = rs(outHex, 40);
      if (this.ref) this._store.putRef(this.ref, sha);
      return sha;
    });
  }

  /// Local tip, or null when the keyspace is empty. Never touches the network.
  _localTip() {
    try {
      return this._resolveRef(this.ref);
    } catch {
      return null;
    }
  }

  /// Local tip, else structure-only bootstrap (blob:none; falls back to a
  /// full pull on servers without filter support).
  ///
  /// Returns null only when the remote genuinely has no such branch (an empty
  /// keyspace). A network/HTTP/protocol failure propagates: reporting "no
  /// commits" because the connection dropped would silently turn a transport
  /// error into "this key does not exist".
  async _tipInner() {
    try {
      return this._resolveRef(this.ref);
    } catch { /* empty store: bootstrap below */ }
    let firstErr;
    try {
      await this._pullInner({ filter: "blob:none" });
    } catch (e) {
      // blob:none may be unsupported; retry unfiltered before judging the failure.
      firstErr = e;
      try {
        await this._pullInner({});
      } catch (e2) {
        if (isGitError(e2, ERR.NO_REMOTE_REF)) return null; // empty remote — a real answer
        throw e2 instanceof RemoteGitError ? e2 : (firstErr ?? e2);
      }
    }
    try {
      return this._resolveRef(this.ref);
    } catch {
      return null;
    }
  }

  /// Batched read: memory hits first, then ONE `want=[oids]` roundtrip for
  /// all missing blobs, then re-read. Paths absent from the keyspace, and
  /// blobs the server declines to send (gc'd / unadvertised), are skipped —
  /// never fail the batch. Anything else (network, HTTP, protocol) throws.
  async _getManyInner(paths, opts = {}) {
    const bytes = await this._getManyBytes(paths, opts);
    if (opts.as !== "text") return bytes;
    return new Map([...bytes].map(([k, v]) => [k, dec.decode(v)]));
  }

  async _getManyBytes(paths, opts = {}) {
    const out = new Map();
    const tip = opts.local === true ? this._localTip() : await this._tipInner();
    if (!tip || !paths.length) return out;
    const rows = this._getInner(this.ref, paths);
    const missing = [];
    for (const row of rows) {
      if (!row.error) out.set(row.path, row.content);
      else missing.push(row.path);
    }
    if (!missing.length || opts.local === true) return out;
    const byPath = new Map((await collectBlobs(this._store, tip)).map((e) => [e.path, e.oid]));
    const oids = [...new Set(missing.map((p) => byPath.get(p)).filter(Boolean))];
    if (oids.length) {
      try {
        // setRef:false: the branch keeps pointing at the commit, not the blobs.
        await fetchIntoStore(this._wasm, this._store, this.url, oids, { setRef: false, ...this._net() });
      } catch (e) {
        // Only a genuinely-absent object stays a miss; a transport failure is
        // rethrown so the caller never reads "network down" as "no such key".
        if (!isGitError(e, ERR.NO_SUCH_OBJECT) && !isGitError(e, ERR.NO_REMOTE_REF)) throw e;
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
      if (!ptr) failed(ERR.WASM_ALLOC, "wasm_alloc failed (heap full; call reset between ops)");
      new Uint8Array(w.memory.buffer).set(u8, ptr);
      return { ptr, len: u8.length };
    };
    const devs = [];
    for (const o of objects) devs.push(await deflateZlib(o.body));
    if (w.wasm_pack_begin(objects.length) !== 0) failed(ERR.WASM_RC, "wasm_pack_begin failed");
    for (let i = 0; i < objects.length; i++) {
      const o = objects[i];
      const tn = TYPE_NUM[o.type];
      if (!tn) failed(ERR.WASM_RC, `unknown type: ${o.type}`);
      const d = allocBytes(devs[i]);
      const rc = w.wasm_pack_add(tn, o.body.length, d.ptr, d.len);
      if (rc !== 0) failed(ERR.WASM_RC, `wasm_pack_add failed rc=${rc}`);
    }
    if (w.wasm_pack_end() !== 0) failed(ERR.WASM_RC, "wasm_pack_end failed");
    return this._takeEmit();
  }

  async _pushInner(opts = {}) {
    const w = this._wasm;
    const store = this._store;
    const fi = opts.fetchImpl ?? this._net().fetchImpl;
    const newOid = this._resolveRef(this.ref).toLowerCase();
    const discRes = await netFetch(fi, joinUrl(this.url, "/info/refs?service=git-receive-pack"), undefined, "discovery (receive-pack)");
    const advert = new Uint8Array(await discRes.arrayBuffer());
    const allocBytes = (b) => {
      const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
      if (!u8.length) return { ptr: 0, len: 0 };
      const ptr = w.wasm_alloc(u8.length);
      if (!ptr) failed(ERR.WASM_ALLOC, "wasm_alloc failed (heap full; call reset between ops)");
      new Uint8Array(w.memory.buffer).set(u8, ptr);
      return { ptr, len: u8.length };
    };
    const allocStr = (s) => allocBytes(enc.encode(s));
    w.wasm_reset();
    this._takeEmit();
    const adv = allocBytes(advert);
    const lrPtrAddr = w.wasm_alloc(4);
    const lrLenAddr = w.wasm_alloc(4);
    if (w.wasm_list_refs(adv.ptr, adv.len, lrPtrAddr, lrLenAddr) !== 0) {
      failed(ERR.WASM_RC, "wasm_list_refs failed");
    }
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
        failed(
          ERR.NON_FAST_FORWARD,
          `push rejected: non-fast-forward (remote ${old.slice(0, 7)} is not an ancestor of ${newOid.slice(0, 7)}; pull first)`,
          { ref: this.ref },
        );
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
      failed(ERR.WASM_RC, "wasm_build_ref_update failed");
    }
    const head = this._takeEmit();
    const reqBody = new Uint8Array(head.length + packBuf.length);
    reqBody.set(head, 0);
    reqBody.set(packBuf, head.length);
    const postRes = await netFetch(fi, joinUrl(this.url, "/git-receive-pack"), {
      method: "POST",
      headers: { "Content-Type": "application/x-git-receive-pack-request" },
      body: reqBody,
    }, "receive-pack");
    const stBuf = new Uint8Array(await postRes.arrayBuffer());
    w.wasm_reset();
    const sp = allocBytes(stBuf);
    const soPtrAddr = w.wasm_alloc(4);
    const soLenAddr = w.wasm_alloc(4);
    const rc = w.wasm_parse_report_status(sp.ptr, sp.len, soPtrAddr, soLenAddr);
    const sdv = new DataView(w.memory.buffer);
    const soPtr = sdv.getUint32(soPtrAddr, true);
    const status = decodeStatusTlv(new Uint8Array(w.memory.buffer.slice(soPtr, soPtr + sdv.getUint32(soLenAddr, true))));
    if (rc === -2 || !status.unpackOk) {
      failed(ERR.UNPACK_FAILED, `unpack failed: ${status.unpackMsg}`, { ref: this.ref });
    }
    if (rc !== 0) {
      const row = status.refs.find((r) => r.ref === this.ref);
      failed(
        ERR.PUSH_REJECTED,
        `push rejected: ${row ? `${row.ref}: ${row.msg}` : `rc=${rc}`}`,
        { ref: this.ref },
      );
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
  /// exist remotely; throws NETWORK / HTTP / NO_V2 on failure.
  async remoteVersion() {
    return this._seq(async () => {
      const refs = await lsRemote(this._wasm, this.url, { fetchImpl: this._net().fetchImpl });
      return refs.find((r) => r.name === this.ref)?.oid ?? null;
    });
  }

  /// Batch read: Map(path -> Uint8Array). `paths` is an array of keys, or a
  /// single key string.
  ///
  /// Keys absent from the keyspace are skipped (no entry in the Map) — that is
  /// a real answer, not a failure. A network / HTTP / protocol failure is
  /// *thrown* (NETWORK, HTTP, NO_V2), never reported as an empty Map, so
  /// `if (!m.size)` cannot mistake a dropped connection for "no such key".
  ///
  /// opts.as === "text" decodes each value as UTF-8, returning a
  /// Map(path -> string) — handy for text keys. Binary keys should use the
  /// default byte form.
  ///
  /// NETWORK SIDE EFFECTS (see also list): a read may hit the network.
  ///   - cold store, no tip cached -> bootstraps structure via pull
  ///   - key in the tree but blob not cached -> one `want=[oids]` roundtrip
  ///   - key absent from the tree -> zero requests, skipped
  /// Pass opts.local === true for a strictly local read (no bootstrap, no
  /// on-demand fetch, never any I/O) — for offline use, or when a cache miss
  /// should stay a cheap miss instead of triggering a fetch.
  ///
  /// A blob the server declines to send (gc'd) is skipped as missing; any
  /// other failure propagates.
  async getMany(paths, opts = {}) {
    return this._seq(() => this._getManyInner(keyList(paths), opts));
  }

  /// Batch write (upsert): each call appends one version (commit) on the tip.
  /// Returns the new version sha. { parent } enables compare-and-swap: throws
  /// CAS_MISMATCH locally when the tip moved since you read it.
  ///
  /// `entries` is an object of { path: content } (a Map works too). Content is
  /// a string or Uint8Array/ArrayBuffer.
  ///
  /// Keys are relative paths ("docs/a.md") and are validated up front: a
  /// malformed key is rejected (BAD_KEY) rather than normalized, because the
  /// tree layer would turn e.g. "" or "/a.txt" into an unnamed entry that
  /// silently overwrites a sibling key in the same batch. All offenders in one
  /// call are reported together.
  async putMany(entries, message = "update", options = {}) {
    const { parent: expected, ...rest } = options;
    // Normalize and validate before taking the serializer slot, so a bad
    // argument throws BAD_ARG/BAD_KEY rather than queueing a doomed commit.
    const pairs = entryPairs(entries);
    assertKeys(pairs.map(([p]) => p));
    const flat = Object.fromEntries(pairs);
    return this._seq(async () => {
      let tip = null;
      try {
        tip = this._resolveRef(this.ref);
      } catch { /* empty keyspace */ }
      if (expected != null && (tip ?? "") !== expected) {
        failed(
          ERR.CAS_MISMATCH,
          `CAS mismatch: tip ${(tip ?? "").slice(0, 7) || "(empty)"} != expected ${String(expected).slice(0, 7)}`,
          { ref: this.ref },
        );
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
  ///
  /// Returns [] for a genuinely empty keyspace and throws NETWORK / HTTP /
  /// NO_V2 when the remote cannot be reached.
  ///
  /// NETWORK SIDE EFFECT: once the tip is cached this is a purely local tree
  /// walk, but the first call on a cold store bootstraps structure from the
  /// remote (a `blob:none` pull, so no blob bytes cross the wire). In a
  /// serverless/Worker context that means one request on the first call per
  /// instance. Pass opts.local === true to enumerate strictly from the local
  /// store — no bootstrap, no I/O, [] when the tip is not cached.
  async list(prefix = "", opts = {}) {
    return this._seq(async () => {
      const tip = opts.local === true ? this._localTip() : await this._tipInner();
      if (!tip) return [];
      const all = await collectBlobs(this._store, tip);
      return prefix ? all.filter((e) => e.path.startsWith(prefix)) : all;
    });
  }

  /// Recent history: [{sha, tree, parents[], author, message}], newest first.
  /// Walks commit parents in the local store only — no network, and it does not
  /// touch wasm memory, but it is still queued through the same serializer so
  /// every public method shares one ordering.
  async log(limit = 10) {
    return this._seq(() => this._logInner(limit));
  }

  async _logInner(limit) {
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
    const list_ = keyList(paths);
    return this._seq(async () => {
      await this._pullInner(opts.pull ?? {});
      return this._getManyInner(list_, opts);
    });
  }

  /// Release the wasm instance and its linear memory (a 4MB arena plus store
  /// scratch, held for the lifetime of the instance). Use it when you are done
  /// with a RemoteGit — in a serverless handler, a Worker, or a long-lived
  /// process that creates many short-lived instances.
  ///
  /// Queued behind in-flight work, so a concurrent operation finishes rather
  /// than crashing on a freed instance. The store is NOT cleared: pass a
  /// throwaway `store` if you want its objects collected too. Idempotent.
  async close() {
    if (this._closed) return;
    await this._tail.catch(() => {}); // let queued work drain
    this._closed = true;
    this._wasm = null;
    this._takeEmit = () => new Uint8Array(0);
  }

  /// True once close() has run.
  get closed() {
    return this._closed;
  }
}
