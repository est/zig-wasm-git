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
// Missing keys are skipped, never errors — but a *network*
// failure is always thrown, never reported as an empty result. pull/push move
// the tip; push rejects on non-fast-forward (last-writer-wins, no merge).
//
// Async methods that touch wasm share one serializer (single shared memory).
// version()/log() are local and skip the queue: await the preceding write
// yourself if you need its result.
//
// Failures: operational failures throw GitError (kind io/protocol, see
// utils.mjs); usage mistakes throw TypeError; invariants throw Error.

import { memoryStore, deflateZlib, joinUrl, withBasicAuth, looseBody, enc, dec, hexOfBytes, concatU8, parseCommit, parseTreeEntries, commitParentsAndTree, netFetch, assertSyncStore, assertKeys, keyProblem, throwProtocol, throwUsage, GitError, SINGLE_BYTES, fmtSize } from "./utils.mjs";
import {
  fetchIntoStore, lsRemote,
  collectObjects, TYPE_NUM, ZERO_OID, decodeRefsTlv, decodeStatusTlv,
} from "./sync.mjs";

const ERR_NAMES = { 1: "NotFound", 2: "PathIsDir", 3: "NotATree", 4: "NotABlob", 5: "BadCommit" };

export { memoryStore, GitError, keyProblem };

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
  throwUsage(`blob content must be a string or Uint8Array/ArrayBuffer; got ${typeName(v)}`);
}

const typeName = (v) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? v.constructor?.name ?? "object" : typeof v;

/// Keys argument -> array. A bare string wraps to one key (a string is the
/// common single-read case; iterating it as chars would be the real bug).
const keyList = (paths) => {
  if (typeof paths === "string") return [paths];
  if (paths == null || typeof paths[Symbol.iterator] !== "function") throwUsage("getMany(paths) takes a key or an array of keys");
  return [...paths];
};

/// putMany entries -> [path, bytes | null] pairs. An object literal is the
/// natural way to write several named values in JS and stays the documented
/// form; a Map is accepted because callers often already hold one. A `null`
/// value deletes the key (missing keys are a no-op, empty dirs are pruned),
/// so one commit can mix upserts and deletes atomically.
function entryPairs(entries) {
  if (entries == null) return [];
  if (entries instanceof Map) return [...entries].map(([k, v]) => [k, v == null ? null : toU8(v)]);
  if (typeof entries !== "object" || Array.isArray(entries)) {
    throwUsage(`putMany entries must be an object or Map; got ${typeName(entries)}`);
  }
  return Object.entries(entries).map(([k, v]) => [k, v == null ? null : toU8(v)]);
}

function nodeFs() {
  const g = process?.getBuiltinModule;
  if (typeof g === "function") {
    try {
      return g("node:fs");
    } catch {}
  }
  return null;
}

async function resolveWasmInput(wasmOpt) {
  // hey these few line does many jobs, eliminate them doesn't improve much.
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
    throwUsage(
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
  static async open(url, opts = {}) {
    const g = Object.create(RemoteGit.prototype);
    g._init(url, opts);
    await g._boot(opts.wasm);
    return g;
  }

  constructor() {
    throwUsage("use `await RemoteGit.open(url, opts)` (instantiation is async, so the constructor cannot boot wasm)");
  }

  _init(url, opts = {}) {
    this.url = url;
    this.ref = opts.ref?.startsWith("refs/") ? opts.ref : `refs/heads/${opts.ref ?? "main"}`;
    this._store = opts.store ?? memoryStore();
    this._fetchImplOpt = opts.fetchImpl ?? null;
    this._subtleOpt = opts.subtle ?? null;
    this._auth = opts.auth ?? null;
    this._tail = Promise.resolve();
    this._wasm = null;
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
      const value = this._auth;
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

  _assertLive() {
    if (!this._wasm) {
      throwUsage(
        "RemoteGit was never opened — use `await RemoteGit.open(url, opts)` " +
          "(instantiation is async, so the constructor cannot boot wasm)",
      );
    }
  }

  _resolveRefOrNull(ref) {
    try {
      return this._resolveRef(ref);
    } catch (e) {
      if (e instanceof TypeError) return null;
      throw e;
    }
  }

  _resolveRef(ref) {
    if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
    const v = this._store.getRef(ref);
    if (v) return v;
    throwUsage(`cannot resolve ref: ${ref}`, { ref });
  }

  _withStore(fn) {
    const w = this._wasm;
    w.wasm_reset();
    const mem = () => new Uint8Array(w.memory.buffer);
    const ab = (b) => {
      const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
      if (!u8.length) return { ptr: 0, len: 0 };
      const ptr = w.wasm_alloc(u8.length);
      if (!ptr) throwUsage(`input too large for one wasm call (${fmtSize(u8.length)}) — split it into smaller putMany batches`);
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
      if (e.content == null) return { pb, cb: null }; // deletion marker
      const cb = e.content instanceof Uint8Array ? e.content : enc.encode(e.content);
      n += 2 + pb.length + 4 + cb.length;
      return { pb, cb };
    });
    // account for deletion markers (no content bytes, len word only)
    for (const { pb, cb } of ps) if (cb === null) n += 2 + pb.length + 4;
    const out = new Uint8Array(n);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, entries.length, true);
    let pos = 2;
    for (const { pb, cb } of ps) {
      dv.setUint16(pos, pb.length, true);
      pos += 2;
      out.set(pb, pos);
      pos += pb.length;
      if (cb === null) {
        dv.setUint32(pos, 0xffffffff, true); // must match wasm_commit's marker
        pos += 4;
        continue;
      }
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
      if (rc === -1) {
        // Arena OOM inside wasm (the only realistic failure once the inputs
        // staged fine): a capacity limit, not a corrupt store — say so.
        throwUsage(paths.length === 1
          ? `blob too large to materialize ("${paths[0]}" is over the ~768KB single-blob limit — split the value across multiple keys)`
          : `read batch too large for one wasm call (${paths.length} keys) — read fewer keys per getMany call`);
      }
      if (rc !== 0) throw new Error(`wasm_get rc=${rc}`);
      const dv = new DataView(w.memory.buffer);
      const tlvPtr = dv.getUint32(outPtrAddr, true);
      const tlvLen = dv.getUint32(outLenAddr, true);
      return this._decodeGetTlv(new Uint8Array(w.memory.buffer.slice(tlvPtr, tlvPtr + tlvLen)));
    });
  }

  /// One value past the readable ceiling is refused up front: writes have
  /// ~250KB more arena headroom than reads (reads add a copy), so a reactive
  /// check would happily store a value that can never be read back.
  _assertValueSizes(pairs) {
    for (const [path, content] of pairs) {
      if (content && content.length > SINGLE_BYTES) {
        throwUsage(`value too large: "${path}" is ${fmtSize(content.length)} — single values must stay under ~768KB; split the value across multiple keys`);
      }
    }
  }

  /// The reactive form, for a batch that outgrew the per-call buffer. Every
  /// value is already known to fit, so only the total can be the problem.
  _batchTooLarge(entriesObj) {
    let total = 0;
    for (const content of Object.values(entriesObj)) total += content?.length ?? 0;
    throwUsage(`write batch too large (${fmtSize(total)} total) — each putMany call must fit ~1MB; use fewer or smaller keys per call`);
  }

  _commitInner(parent, message, entriesObj) {
    return this._withStore(({ w, ab, as, rs }) => {
      const pHex = as(parent);
      const msg = as(message);
      const entries = Object.entries(entriesObj).map(([path, content]) => ({
        path,
        content: content == null ? null : typeof content === "string" ? enc.encode(content) : content,
      }));
      const ej = ab(this._encodeEntriesTlv(entries));
      const outHex = w.wasm_alloc(40);
      if (!outHex) this._batchTooLarge(entriesObj);
      const rc = w.wasm_commit(pHex.ptr, pHex.len, msg.ptr, msg.len, ej.ptr, ej.len, outHex);
      if (rc === -1) this._batchTooLarge(entriesObj);
      if (rc !== 0) throw new Error(`wasm_commit rc=${rc}`);
      const sha = rs(outHex, 40);
      if (this.ref) this._store.putRef(this.ref, sha);
      return sha;
    });
  }

  /// Local tip, or null when the keyspace is empty. Never touches the network.
  _localTip() {
    return this._resolveRefOrNull(this.ref);
  }

  /// Local tip, else a structure-only bootstrap (blob:none, unfiltered retry).
  /// Null only when the remote genuinely has no such branch. Failures
  /// propagate — a dropped connection must never read as "empty keyspace".
  async _tipInner() {
    const cached = this._resolveRefOrNull(this.ref);
    if (cached) return cached;
    let firstErr;
    try {
      await this._pullInner({ filter: "blob:none" });
    } catch (e) {
      // blob:none may be unsupported; retry unfiltered before judging the failure.
      firstErr = e;
      try {
        await this._pullInner({});
      } catch (e2) {
        if (GitError.isProtocol(e2, "NO_REMOTE_REF")) return null; // empty remote — a real answer
        throw e2 instanceof GitError ? e2 : (firstErr ?? e2);
      }
    }
    return this._resolveRefOrNull(this.ref);
  }

  async _getManyInner(paths, opts = {}) {
    return this._getManyBytes(paths, opts);
  }

  /// One wasm_get per key: a single call materializes every blob into one
  /// TLV, so a batched call is bounded by the ~1MB per-call buffer no matter
  /// how small each value is. Key-by-key keeps the bound at one blob; the
  /// extra calls are local and cheap (no network).
  _getRows(paths) {
    const rows = [];
    for (const p of paths) rows.push(...this._getInner(this.ref, [p]));
    return rows;
  }

  async _getManyBytes(paths, opts = {}) {
    const out = new Map();
    const tip = opts.local === true ? this._localTip() : await this._tipInner();
    if (!tip || !paths.length) return out;
    const rows = this._getRows(paths);
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
        if (!GitError.isProtocol(e, "NO_SUCH_OBJECT", "NO_REMOTE_REF")) throw e;
      }
      for (const row of this._getRows(missing)) {
        if (!row.error) out.set(row.path, row.content);
      }
    }
    return out;
  }

  _pullInner(opts = {}) {
    if (typeof opts === "string") opts = { filter: opts };
    return fetchIntoStore(this._wasm, this._store, this.url, this.ref, { ...this._net(), ...opts });
  }

  _allocInto(w, b) {
    const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
    if (u8.length === 0) return { ptr: 0, len: 0 };
    const ptr = w.wasm_alloc(u8.length);
    if (!ptr) throwUsage(`data too large for one wasm call (${fmtSize(u8.length)}) — split it into smaller calls`);
    new Uint8Array(w.memory.buffer).set(u8, ptr);
    return { ptr, len: u8.length };
  }

  async _packObjects(objects) {
    const w = this._wasm;
    w.wasm_reset();
    this._takeEmit();
    const allocBytes = (b) => this._allocInto(w, b);
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
    const discRes = await netFetch(fi, joinUrl(this.url, "/info/refs?service=git-receive-pack"), undefined, "discovery (receive-pack)");
    const advert = new Uint8Array(await discRes.arrayBuffer());
    const allocBytes = (b) => this._allocInto(w, b);
    const allocStr = (s) => allocBytes(enc.encode(s));
    w.wasm_reset();
    this._takeEmit();
    const adv = allocBytes(advert);
    const lrPtrAddr = w.wasm_alloc(4);
    const lrLenAddr = w.wasm_alloc(4);
    if (w.wasm_list_refs(adv.ptr, adv.len, lrPtrAddr, lrLenAddr) !== 0) {
      throw new Error("wasm_list_refs failed");
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
        throwProtocol(
          "NON_FAST_FORWARD",
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
      throw new Error("wasm_build_ref_update failed");
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
throwProtocol("UNPACK_FAILED", `unpack failed: ${status.unpackMsg}`, { ref: this.ref });
    }
    if (rc !== 0) {
      const row = status.refs.find((r) => r.ref === this.ref);
      throwProtocol(
        "PUSH_REJECTED",
        `push rejected: ${row ? `${row.ref}: ${row.msg}` : `rc=${rc}`}`,
        { ref: this.ref },
      );
    }
    return { updated: true, ref: this.ref, old, new: newOid, objects: objects.length, packBytes: packBuf.length };
  }

  // ── public: all async ──

  /// The object store behind this instance (advanced use: share it across
  /// instances, inspect refs). The store itself stays synchronous by contract.
  get store() {
    return this._store;
  }

  version() {
    return this._resolveRefOrNull(this.ref);
  }

  async remoteVersion() {
    return this._seq(async () => {
      const refs = await lsRemote(this._wasm, this.url, { fetchImpl: this._net().fetchImpl });
      return refs.find((r) => r.name === this.ref)?.oid ?? null;
    });
  }

  async getMany(paths, opts = {}) {
    const list_ = keyList(paths);
    const map = await this._seq(() => this._getManyInner(list_, opts));
    if (opts.as === "text") {
      const out = new Map();
      for (const [k, v] of map) out.set(k, dec.decode(v));
      return out;
    }
    return map;
  }

  /// Write keys as one version (commit); returns the new sha. A `null` value
  /// deletes the key — missing keys are a no-op, empty dirs are pruned — so
  /// one call can mix upserts and deletes atomically. Pass `{ parent }` for
  /// compare-and-swap.
  async putMany(entries, message = "update", options) {
    if (typeof options === "string") {
      throwUsage("putMany parent must be { parent }, not a bare oid string");
    }
    const expected = options?.parent;
    const pairs = entryPairs(entries);
    assertKeys(pairs.map(([p]) => p));
    this._assertValueSizes(pairs);
    const flat = Object.fromEntries(pairs);
    return this._seq(async () => {
      const tip = this._resolveRefOrNull(this.ref);
      if (expected != null && (tip ?? "") !== expected) {
        throwProtocol(
          "CAS_MISMATCH",
          `CAS mismatch: tip ${(tip ?? "").slice(0, 7) || "(empty)"} != expected ${String(expected).slice(0, 7)}`,
          { ref: this.ref },
        );
      }
      return this._commitInner(expected ?? tip ?? "", message, flat);
    });
  }

  async list(prefix = "", opts = {}) {
    return this._seq(async () => {
      const tip = opts.local === true ? this._localTip() : await this._tipInner();
      if (!tip) return [];
      const all = await collectBlobs(this._store, tip);
      return prefix ? all.filter((e) => e.path.startsWith(prefix)) : all;
    });
  }

  async log(limit = 10) {
    this._assertLive();
    return this._logInner(limit);
  }

  async _logInner(limit) {
    const out = [];
    let cur = this._resolveRefOrNull(this.ref);
    if (!cur) return out;
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

  async pull(opts = {}) {
    if (typeof opts === "string") opts = { filter: opts };
    return this._seq(() => this._pullInner(opts));
  }

  async push(opts = {}) {
    return this._seq(() => this._pushInner({ ...this._net(), ...opts }));
  }
}
