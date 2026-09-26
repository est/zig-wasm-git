// src/host/portable.mjs — portable repo for Browser / CF Workers / Node (no fs, no CLI).
// Zero node: imports. Requires WebAssembly, fetch, CompressionStream,
// crypto.subtle, TextEncoder/Decoder (Node 18+/Workers/modern browsers).
//
//   import { loadFromBytes, memoryStore } from "./portable.mjs";
//   const repo = loadFromBytes(wasmBytes, { store: memoryStore() });
//   ...or pass a precompiled Module where runtime codegen is forbidden:
//   const repo = loadFromBytes(precompiledModule, { store: memoryStore() });
//   await repo.fetch("https://git.example.com/repo.git", "main"); // smart HTTP v2
//   repo.get("main", ["README.md"]);      // [{path, oid, content: Uint8Array}]
//   repo.commit("", "init", {"a.txt": "hi"}); // -> sha (local; push to publish)
//
// Wire: git protocol weight lifting in wasm (utils.mjs); IO/compression/hash in JS;
// remote sync (fetch/push) in sync.mjs; blob facade below in this file.

import { memoryStore, toModule, deflateZlib, joinUrl, withBasicAuth, looseBody, enc, dec, hexOfBytes, concatU8, parseCommit, parseTreeEntries, commitParentsAndTree } from "./utils.mjs";
import {
  fetchIntoStore, lsRemote,
  collectObjects, TYPE_NUM, ZERO_OID, decodeRefsTlv, decodeStatusTlv,
} from "./sync.mjs";

const ERR_NAMES = { 1: "NotFound", 2: "PathIsDir", 3: "NotATree", 4: "NotABlob", 5: "BadCommit" };

export { memoryStore, withBasicAuth };

// ── RemoteGit: url-bound versioned blob store ──
//
// One branch == one keyspace. URL is bound once; reads auto-materialize
// missing blobs (batched into one roundtrip), writes carry author defaults
// and optional CAS parent, push is fast-forward only:
//
//   const git = new RemoteGit(url, { wasm: wasmBytes, ref: "main" });
//   await git.fetch();                       // optional warmup (full pull)
//   await git.readText("README.md");          // missing blobs fetched on demand
//   await git.list("docs/");                 // [{path, oid}] key enumeration
//   await git.remoteVersion();               // remote tip oid, store untouched
//   git.write({ "a.txt": "hi" }, "msg", { author: "A <a@x>" }); // -> sha
//   await git.push();
//
// Read path: cache hit returns from memory; a structural hit (tree knows
// the blob, bytes absent — e.g. after a blob:none fetch) triggers one
// `want=<blob-oid>` roundtrip (~blob size, byte-equal to a full fetch).
// Unknown paths return null with zero RTT. Network methods are serialized
// internally (one shared wasm memory — never call them concurrently).
// `user:pass@host` URLs are sent as Basic auth headers by default
// (workerd drops URL userinfo; stripping also keeps tokens out of logs).
//
// Constructor takes { wasm } (bytes | precompiled Module) because workerd
// forbids runtime compilation and constructors cannot await: browser/node
// callers pass `new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer())`,
// workerd callers pass their CompiledWasm Module.
//
// Server knobs (GitHub defaults are fine; self-hosted git needs these):
//   uploadpack.allowFilter=true              // blob:none structure bootstrap
//   uploadpack.allowTipSHA1InWant / allowReachableSHA1InWant  // blob fetch

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

export class RemoteGit {
  constructor(url, opts = {}) {
    if (!opts.wasm) throw new Error("RemoteGit needs { wasm }: wasm bytes or a precompiled WebAssembly.Module");
    this.url = url;
    this.ref = opts.ref?.startsWith("refs/") ? opts.ref : `refs/heads/${opts.ref ?? "main"}`;
    this.filter = opts.filter ?? "";
    this._wasm = opts.wasm;
    this._store = opts.store ?? memoryStore();
    this._fetchImplOpt = opts.fetchImpl ?? null;
    this._subtleOpt = opts.subtle ?? null;
    this._author = opts.author;
    this._committer = opts.committer;
    this._timezone = opts.timezone;
    this._repo = null;
    this._tail = Promise.resolve();
  }

  /// Lazy: `new` never touches wasm (cheap; safe before runtimes are ready).
  _repo_() {
    if (!this._repo) this._repo = loadFromBytes(this._wasm, { store: this._store });
    return this._repo;
  }

  _net() {
    return {
      fetchImpl: this._fetchImplOpt ?? withBasicAuth(globalThis.fetch.bind(globalThis)),
      subtle: this._subtleOpt ?? globalThis.crypto.subtle,
    };
  }

  /// Serialize async ops (single shared wasm memory). Public async methods
  /// never call each other — they all funnel through unlocked _inners here.
  _seq(fn) {
    const t = this._tail.then(fn, fn);
    this._tail = t.catch(() => {});
    return t;
  }

  version() {
    try {
      return this._repo_().resolveRef(this.ref);
    } catch {
      return null;
    }
  }

  /// Local tip, else structure-only bootstrap (blob:none; falls back to a
  /// full pull on servers without filter support). Null when unreachable.
  async _tipInner() {
    let tip = this.version();
    if (!tip) {
      try {
        await this._repo_().fetch(this.url, this.ref, { filter: "blob:none", ...this._net() });
      } catch {
        try {
          await this._repo_().fetch(this.url, this.ref, { ...this._net() });
        } catch {
          return null;
        }
      }
      tip = this.version();
    }
    return tip;
  }

  /// Unlocked batched read: memory hits first, then ONE `want=[oids]`
  /// roundtrip for all missing blobs, then re-read. Unknown paths and
  /// gc'd blobs stay missing (null), never fail the batch.
  async _readManyInner(paths) {
    const out = new Map();
    const tip = await this._tipInner();
    if (!tip || !paths.length) return out;
    const rows = this._repo_().get(this.ref, paths);
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
        await this._repo_().fetch(this.url, oids, { setRef: false, ...this._net() });
      } catch {
        /* gc'd blobs stay missing */
      }
      for (const row of this._repo_().get(this.ref, missing)) {
        if (!row.error) out.set(row.path, row.content);
      }
    }
    return out;
  }

  async _pullInner(opts = {}) {
    return this._repo_().fetch(this.url, this.ref, { filter: this.filter, ...this._net(), ...opts });
  }

  read(path) {
    return this._seq(async () => (await this._readManyInner([path])).get(path) ?? null);
  }

  async readText(path) {
    const b = await this._seq(async () => (await this._readManyInner([path])).get(path) ?? null);
    return b == null ? null : dec.decode(b);
  }

  readMany(paths) {
    return this._seq(() => this._readManyInner(paths ?? []));
  }

  /// Key enumeration: [{path, oid}], optionally filtered by prefix.
  /// Local-only once the tip is known (first call bootstraps structure).
  list(prefix = "") {
    return this._seq(async () => {
      const tip = await this._tipInner();
      if (!tip) return [];
      const all = await collectBlobs(this._store, tip);
      return prefix ? all.filter((e) => e.path.startsWith(prefix)) : all;
    });
  }

  /// Remote tip oid without touching the store (1 ls-refs roundtrip).
  /// Null when the ref doesn't exist remotely or the network fails.
  remoteVersion() {
    return this._seq(async () => {
      try {
        const refs = await this._repo_().lsRemote(this.url, { fetchImpl: this._net().fetchImpl });
        return refs.find((r) => r.name === this.ref)?.oid ?? null;
      } catch {
        return null;
      }
    });
  }

  /// Author/time plumbing: per-call options win, constructor defaults fill
  /// the gaps. { author: "Name <mail>", committer, time (unix sec), timezone,
  /// parent } — parent enables compare-and-swap: the write throws locally
  /// when the tip moved since you read it, instead of failing at push time.
  write(files, message = "update", options = {}) {
    const entries = {};
    for (const [path, content] of Object.entries(files ?? {})) {
      entries[path] = content instanceof Uint8Array ? content : toU8(content);
    }
    const { parent: expected, ...rest } = options;
    const tip = this.version() ?? "";
    if (expected != null && tip !== expected) {
      throw new Error(`CAS mismatch: tip ${tip.slice(0, 7) || "(empty)"} != expected ${String(expected).slice(0, 7)}`);
    }
    return this._repo_().commit(expected ?? tip, message, entries, this.ref, {
      ...(this._author != null ? { author: this._author } : null),
      ...(this._committer != null ? { committer: this._committer } : null),
      ...(this._timezone != null ? { timezone: this._timezone } : null),
      ...rest,
    });
  }

  writeText(path, text, message = "update", options = {}) {
    return this.write({ [path]: enc.encode(text) }, message, options);
  }

  /// Full pull (explicit refresh). No merge: unpushed writes must be pushed
  /// first, else the fetch moves the tip underneath them (still reachable by sha).
  pull(opts = {}) {
    return this._seq(() => this._pullInner(opts));
  }

  /// Optional warmup (same as pull). Reads work without it — the first read
  /// bootstraps structure itself — but warming avoids per-key roundtrips.
  fetch(opts = {}) {
    return this._seq(() => this._pullInner(opts));
  }

  /// Fast-forward publish of the local tip; rejects on non-fast-forward.
  push(opts = {}) {
    return this._seq(() => this._repo_().push(this.url, this.ref, { ...this._net(), ...opts }));
  }

  /// One-shot: pull latest, then return the requested keys.
  async sync(paths, opts = {}) {
    return this._seq(async () => {
      await this._pullInner(opts.pull ?? {});
      return this._readManyInner(paths ?? []);
    });
  }
}

/// wasmBytesOrModule: Uint8Array bytes, or a precompiled WebAssembly.Module
/// (workerd `CompiledWasm`; see wire.toModule).
/// Prerequisites (no runtime checks): WebAssembly, fetch, crypto.subtle,
/// CompressionStream/DecompressionStream, TextEncoder/Decoder — Node 18+,
/// CF workerd, or modern browsers. Missing pieces fail naturally at the
/// call site. Pass { fetchImpl, subtle } only to override (tests/auth).
export function loadFromBytes(wasmBytesOrModule, opts = {}) {
  const store = opts.store ?? memoryStore();
  // 延迟绑定:只做 get/commit 的调用方不应因为缺 fetch/subtle 而在
  // load 时就抛错;network 方法调用时再 resolve,默认值走 globalThis。
  const fetchOpt = opts.fetchImpl ?? null;
  const subtleOpt = opts.subtle ?? null;
  const lazyFetch = () => fetchOpt ?? globalThis.fetch.bind(globalThis);
  const lazySubtle = () => subtleOpt ?? globalThis.crypto.subtle;
  // 单实例:Module 只编译一次,直连 store 回调(protocol 方法不碰 store,
  // 回调闲置即可;省掉第二份线性内存与第二套 alloc  helper)。
  const emitChunks = [];
  const mod = toModule(wasmBytesOrModule);
  let inst;
  inst = new WebAssembly.Instance(mod, {
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
  const wasm = inst.exports;
  const takeEmit = () => concatU8(emitChunks.splice(0));

  function allocBytes(b) {
    const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
    if (u8.length === 0) return { ptr: 0, len: 0 };
    const ptr = wasm.wasm_alloc(u8.length);
    if (!ptr) throw new Error("wasm_alloc failed (heap full; call reset between ops)");
    new Uint8Array(wasm.memory.buffer).set(u8, ptr);
    return { ptr, len: u8.length };
  }
  const allocStr = (s) => allocBytes(enc.encode(s));

  function resolveRef(ref) {
    if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
    // 注:HEAD 取第一个 heads() 分支,不读符号 HEAD 文件。本库定位是
    // 单分支 blob-store,调用方(及 blob 门面)永远传明确分支名;HEAD
    // 只是兼容保留,不做真 git 语义。
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

  function encodeEntriesTlv(entries) {
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

  // Wrap the single store-bound instance with alloc helpers for one call.
  function withStore(fn) {
    const w = wasm;
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
          content: typeof content === "string" ? enc.encode(content) : content,
        }));
        const ej = ab(encodeEntriesTlv(entries));
        const outHex = w.wasm_alloc(40);
        const author = options.author != null ? String(options.author) : "";
        const committer = options.committer != null ? String(options.committer) : author;
        // Default to wall-clock seconds (portable: Date.now exists in
        // browsers/workers/node). Empty string would land in wasm as 0
        // (1970-01-01), so always send an explicit timestamp here; pass
        // options.time explicitly for deterministic hashes in tests.
        const timeSec = options.time != null ? String(options.time) : String(Math.floor(Date.now() / 1000));
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

    /** Fetch/clone into this store (smart HTTP v2). ref: branch/tag/sha,
        or an array of blob oids (batch single-roundtrip fetch, no ref update). */
    fetch(url, ref = "main", opts = {}) {
      return fetchIntoStore(wasm, store, url, ref, {
        fetchImpl: opts.fetchImpl ?? lazyFetch(),
        subtle: opts.subtle ?? lazySubtle(),
        filter: opts.filter ?? "",
        setRef: opts.setRef,
        onProgress: opts.onProgress,
      });
    },

    /** Recent history without protocol (reads local store; async inflate). */
    async log(ref, limit = 10) {
      const sha0 = resolveRef(ref);
      const out = [];
      let cur = sha0;
      for (let i = 0; i < limit && cur; i++) {
        const loose = store.get(cur);
        if (!loose) break;
        const { body } = await looseBody(loose);
        const row = parseCommit(cur, dec.decode(body));
        out.push(row);
        cur = row.parents[0];
      }
      return out;
    },

    lsRemote(url, opts = {}) {
      return lsRemote(wasm, url, { fetchImpl: opts.fetchImpl ?? lazyFetch() });
    },

    resolveRef,

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
      const fi = opts.fetchImpl ?? lazyFetch();
      const fullRef = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
      const newOid = resolveRef(ref).toLowerCase();
      const discRes = await fi(joinUrl(url, "/info/refs?service=git-receive-pack"));
      if (!discRes.ok) throw new Error(`discovery http ${discRes.status}`);
      const advert = new Uint8Array(await discRes.arrayBuffer());
      wasm.wasm_reset();
      takeEmit();
      const adv = allocBytes(advert);
      const lrPtrAddr = wasm.wasm_alloc(4);
      const lrLenAddr = wasm.wasm_alloc(4);
      if (wasm.wasm_list_refs(adv.ptr, adv.len, lrPtrAddr, lrLenAddr) !== 0) throw new Error("wasm_list_refs failed");
      const dv = new DataView(wasm.memory.buffer);
      const lrPtr = dv.getUint32(lrPtrAddr, true);
      const refs = decodeRefsTlv(new Uint8Array(wasm.memory.buffer.slice(lrPtr, lrPtr + dv.getUint32(lrLenAddr, true))));
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
      const soPtrAddr = wasm.wasm_alloc(4);
      const soLenAddr = wasm.wasm_alloc(4);
      const rc = wasm.wasm_parse_report_status(sp.ptr, sp.len, soPtrAddr, soLenAddr);
      const sdv = new DataView(wasm.memory.buffer);
      const soPtr = sdv.getUint32(soPtrAddr, true);
      const status = decodeStatusTlv(new Uint8Array(wasm.memory.buffer.slice(soPtr, soPtr + sdv.getUint32(soLenAddr, true))));
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

// ── blob-service facade ──
//
// Standpoint: the remote git repo is a versioned blob store, not a
// developer workspace. Callers think in keys and bytes:
//
//   read(path) -> bytes | null        // missing key is null, not an error
//   write({path: bytes}, message) -> version (commit sha, ref tip moves)
//   pull(url) / publish(url)          // network sync; no workdir, no merge
//
// Keyspace model: one branch == one keyspace (default refs/heads/main).
// Each write is a full-snapshot commit of the given keys on top of the
// current tip (last-writer-wins; push rejects on non-fast-forward).

const toU8 = (v) => (v instanceof Uint8Array ? v : enc.encode(v ?? ""));

export function createBlobService(repo, opts = {}) {
  const shortRef = opts.ref ?? "main";
  const fullRef = shortRef.startsWith("refs/") ? shortRef : `refs/heads/${shortRef}`;
  const filter = opts.filter ?? "";

  function version() {
    try {
      return repo.resolveRef(fullRef);
    } catch {
      return null;
    }
  }

  function pickOne(rows, path) {
    const row = rows.find((r) => r.path === path);
    if (!row || row.error) return null;
    return row.content instanceof Uint8Array ? row.content : new Uint8Array(row.content ?? []);
  }

  function read(path) {
    const tip = version();
    if (!tip) return null;
    return pickOne(repo.get(fullRef, [path]), path);
  }

  function readText(path) {
    const b = read(path);
    return b == null ? null : dec.decode(b);
  }

  function readMany(paths) {
    const tip = version();
    const out = new Map();
    if (!tip || !paths.length) return out;
    for (const row of repo.get(fullRef, paths)) {
      if (!row.error) out.set(row.path, row.content);
    }
    return out;
  }

  function write(files, message = "update", options = {}) {
    const entries = {};
    for (const [path, content] of Object.entries(files ?? {})) {
      entries[path] = content instanceof Uint8Array ? content : toU8(content);
    }
    const parent = version() ?? "";
    return repo.commit(parent, message, entries, fullRef, options);
  }

  function writeText(path, text, message = "update", options = {}) {
    return write({ [path]: enc.encode(text) }, message, options);
  }

  // Network: pull == fetch remote tip into local store (plus ref update).
  function pull(url, pullOpts = {}) {
    return repo.fetch(url, fullRef, { filter, ...pullOpts });
  }

  // Network: publish == push local tip (fast-forward only; rejects otherwise).
  function publish(url, publishOpts = {}) {
    return repo.push(url, fullRef, publishOpts);
  }

  // One-shot blob sync: pull latest, then return the requested keys.
  // No merge: local unpushed writes must be published first, else the
  // fetch moves the ref tip underneath them (they stay reachable by sha).
  async function sync(url, paths, syncOpts = {}) {
    await pull(url, syncOpts.pull ?? {});
    return readMany(paths ?? []);
  }

  return { ref: fullRef, filter, version, read, readText, readMany, write, writeText, pull, publish, sync };
}
