// src/host/utils.mjs — portable helpers shared by the repo entry and sync clients.
// Zero node: imports. Only: WebAssembly, CompressionStream/DecompressionStream,
// TextEncoder/Decoder, URL/Headers/btoa. Sections:
//   store: in-memory object store (same interface as the Node fileStore)
//   codec: hex/url/auth, zlib, loose/tree/commit parsing
//   wire:  wasm boot + git-protocol call wrappers (source of truth for pkt shapes)

const _dec = new TextDecoder();
const _enc = new TextEncoder();

// ── store ──

/// Portable in-memory object store (zero FS, zero node: deps).
/// get(hex) -> Uint8Array|null (loose zlib bytes); put(hex, loose) stores a copy.
export function memoryStore() {
  const objs = new Map();
  const refs = new Map();
  return {
    get(hex) {
      const v = objs.get(String(hex).toLowerCase());
      return v ? v.slice() : null;
    },
    put(hex, loose) {
      objs.set(String(hex).toLowerCase(), Uint8Array.from(loose));
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

// ── codec ──

export function hexOfBytes(b) {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export const joinUrl = (base, path) => base.replace(/\/+$/, "") + path;

/// Wrap a fetch impl so URLs carrying `user:pass@host` credentials are sent
/// as an `Authorization: Basic` header with the credentials stripped from
/// the URL. Some runtimes (notably Cloudflare workerd) drop URL userinfo
/// instead of applying it, so the same URL that works with curl gets a 401
/// from in-worker discovery; stripping also keeps tokens out of downstream
/// logs/proxies. URLs without userinfo (and pre-set Authorization headers)
/// pass through untouched. String-URL call sites (fetch/push/lsRemote).
export function withBasicAuth(fetchImpl) {
  return async (url, init) => {
    const raw = typeof url === "string" ? url : url?.url ?? String(url);
    let u;
    try {
      u = new URL(raw);
    } catch {
      return fetchImpl(url, init);
    }
    if (!u.username && !u.password) return fetchImpl(url, init);
    const creds = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
    const bytes = _enc.encode(creds);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const basic = btoa(bin);
    const fromReq = typeof url === "object" && url !== null ? url.headers : undefined;
    const headers = new Headers(fromReq ?? init?.headers);
    if (!headers.has("authorization")) headers.set("authorization", `Basic ${basic}`);
    u.username = "";
    u.password = "";
    return fetchImpl(u.toString(), { ...init, headers });
  };
}

function needCS() {
  if (typeof CompressionStream === "undefined" || typeof DecompressionStream === "undefined") {
    throw new Error("CompressionStream/DecompressionStream unavailable on this platform");
  }
}

export async function streamAll(stream, input) {
  const w = stream.writable.getWriter();
  await w.write(input);
  await w.close();
  const chunks = [];
  for await (const c of stream.readable) {
    chunks.push(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
  }
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/// pack 对象 payload:zlib(body)。直出,无需手工包头/adler。
export async function deflateZlib(body) {
  needCS();
  return streamAll(new CompressionStream("deflate"), body);
}

export async function inflateZlib(zlibBytes) {
  needCS();
  return streamAll(new DecompressionStream("deflate"), zlibBytes);
}

/// loose("type len\0body" zlib) -> {type, body: Uint8Array (copy)}
export async function looseBody(loose) {
  const raw = await inflateZlib(loose instanceof Uint8Array ? loose : new Uint8Array(loose));
  const nul = raw.indexOf(0);
  if (nul < 0) throw new Error("bad loose object");
  const [type, len] = _dec.decode(raw.subarray(0, nul)).split(" ");
  const body = raw.subarray(nul + 1);
  if (body.length !== Number(len)) throw new Error("loose length mismatch");
  return { type, body: body.slice() };
}

/// tree body -> [{mode, name, oid(hex)}]
export function parseTreeEntries(body) {
  const u8 = body instanceof Uint8Array ? body : new Uint8Array(body);
  const out = [];
  let i = 0;
  while (i < u8.length) {
    const sp = u8.indexOf(0x20, i);
    const nul = u8.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > u8.length) throw new Error("bad tree body");
    out.push({
      mode: _dec.decode(u8.subarray(i, sp)),
      name: _dec.decode(u8.subarray(sp + 1, nul)),
      oid: hexOfBytes(u8.subarray(nul + 1, nul + 21)),
    });
    i = nul + 21;
  }
  return out;
}

export function commitParentsAndTree(body) {
  const parents = [];
  let tree = null;
  const text = typeof body === "string" ? body : _dec.decode(body instanceof Uint8Array ? body : new Uint8Array(body));
  for (const line of text.split("\n")) {
    if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
    else if (line.startsWith("tree ") && tree === null) tree = line.slice(5, 45);
    else if (line === "") break;
  }
  return { parents, tree };
}

// ── wire ──

const enc = new TextEncoder();
const dec = new TextDecoder();

/// Accept wasm bytes or a precompiled WebAssembly.Module and return a Module.
/// Runtimes that forbid runtime codegen (e.g. Cloudflare workerd, where
/// `new WebAssembly.Module(bytes)` throws "Wasm code generation disallowed
/// by embedder") precompile at upload time (wrangler `CompiledWasm` rule)
/// and pass the Module straight in; Node/browsers keep passing bytes.
export function toModule(wasmBytesOrModule) {
  if (typeof WebAssembly.Module === "function" && wasmBytesOrModule instanceof WebAssembly.Module) {
    return wasmBytesOrModule;
  }
  return new WebAssembly.Module(wasmBytesOrModule);
}

export function bootWasm(wasmBytesOrModule, extraEnv = {}) {
  const emitChunks = [];
  let inst;
  const mod = toModule(wasmBytesOrModule);
  inst = new WebAssembly.Instance(mod, {
    env: {
      host_emit_bytes(ptr, len) {
        emitChunks.push(new Uint8Array(inst.exports.memory.buffer.slice(ptr, ptr + len)));
      },
      host_log() {},
      host_get_object() {
        return -1;
      },
      host_put_object() {
        return -1;
      },
      ...extraEnv,
    },
  });
  const wasm = inst.exports;
  const takeEmit = () => {
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
  };
  return { wasm, takeEmit };
}

function dv(wasm) {
  return new DataView(wasm.memory.buffer);
}

function allocBytes(wasm, b) {
  if (b.length === 0) return { ptr: 0, len: 0 };
  const ptr = wasm.wasm_alloc(b.length);
  if (!ptr) throw new Error("wasm_alloc failed (heap full; call reset between ops)");
  new Uint8Array(wasm.memory.buffer).set(b, ptr);
  return { ptr, len: b.length };
}

function allocStr(wasm, s) {
  return allocBytes(wasm, enc.encode(s));
}

function readOut(wasm, ptrAddr, lenAddr) {
  const d = dv(wasm);
  const p = d.getUint32(ptrAddr, true);
  const n = d.getUint32(lenAddr, true);
  return new Uint8Array(wasm.memory.buffer.slice(p, p + n));
}

/// Build the v2 ls-refs request body (wasm is source of truth for pkt shape).
export function buildLsRefsReq(wasm) {
  wasm.wasm_reset();
  const p = wasm.wasm_alloc(4);
  const l = wasm.wasm_alloc(4);
  if (wasm.wasm_build_lsrefs(p, l) !== 0) throw new Error("wasm_build_lsrefs failed");
  return readOut(wasm, p, l);
}

/// wants: string|string[] of 40-hex; filter: bare spec ("blob:none") or "".
export function buildFetchReq(wasm, wants, filter = "") {
  wasm.wasm_reset();
  const list = (Array.isArray(wants) ? wants : [wants]).join("\n");
  const w = allocStr(wasm, list);
  const f = allocStr(wasm, filter || "");
  const p = wasm.wasm_alloc(4);
  const l = wasm.wasm_alloc(4);
  const rc = wasm.wasm_build_fetch(w.ptr, w.len, f.ptr, f.len, p, l);
  if (rc !== 0) throw new Error(`wasm_build_fetch rc=${rc}`);
  return readOut(wasm, p, l);
}

/// Parse refs advertisement / v2 ls-refs response via wasm_list_refs.
/// Returns [{oid, name}]. Works for v1 discovery bodies and v2 ls-refs bodies.
export function listRefs(wasm, advertBytes) {
  wasm.wasm_reset();
  const a = allocBytes(wasm, advertBytes);
  const p = wasm.wasm_alloc(4);
  const l = wasm.wasm_alloc(4);
  if (wasm.wasm_list_refs(a.ptr, a.len, p, l) !== 0) throw new Error("wasm_list_refs failed");
  const tlv = readOut(wasm, p, l);
  return decodeRefsTlv(tlv);
}

export function decodeRefsTlv(buf) {
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  const n = d.getUint16(pos, true);
  pos += 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const oid = dec.decode(buf.subarray(pos, pos + 40));
    pos += 40;
    const nlen = d.getUint16(pos, true);
    pos += 2;
    const name = dec.decode(buf.subarray(pos, pos + nlen));
    pos += nlen;
    out.push({ oid, name });
  }
  return out;
}

/// Decode one pack object header at pos (mirrors wasm_decode_pack_header).
/// Returns {type, size, next}. Pure JS (no wasm roundtrip); equivalence with
/// wasm is asserted in tests.
export function decodePackHeaderJS(buf, pos = 0) {
  if (pos >= buf.length) throw new Error("pack header truncated");
  let b = buf[pos++];
  const type = (b >> 4) & 7;
  let size = b & 0x0f;
  let shift = 4;
  while (b & 0x80) {
    if (pos >= buf.length) throw new Error("pack header truncated");
    b = buf[pos++];
    size += (b & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { type, size, next: pos };
}

/// Inflate one zlib stream starting at pos via wasm (single pass, exact
/// consumed — no trial-inflate). Returns {body, consumed}.
export function inflateOne(wasm, buf, pos = 0) {
  wasm.wasm_reset();
  const total = buf.length - pos;
  const inp = wasm.wasm_alloc(total);
  new Uint8Array(wasm.memory.buffer).set(buf.subarray(pos), inp);
  const p = wasm.wasm_alloc(4);
  const l = wasm.wasm_alloc(4);
  const c = wasm.wasm_alloc(4);
  const rc = wasm.wasm_inflate_one(inp, total, p, l, c);
  if (rc !== 0) throw new Error(`wasm_inflate_one rc=${rc} at pack offset ${pos}`);
  const d = dv(wasm);
  const body = new Uint8Array(wasm.memory.buffer.slice(d.getUint32(p, true), d.getUint32(p, true) + d.getUint32(l, true)));
  return { body, consumed: d.getUint32(c, true) };
}

/// Apply a git delta (base + delta -> result) via wasm.
export function deltaApply(wasm, base, deltaBytes) {
  wasm.wasm_reset();
  const b = allocBytes(wasm, base);
  const d = allocBytes(wasm, deltaBytes);
  const p = wasm.wasm_alloc(4);
  const l = wasm.wasm_alloc(4);
  const rc = wasm.wasm_delta_apply(b.ptr, b.len, d.ptr, d.len, p, l);
  if (rc !== 0) throw new Error(`wasm_delta_apply rc=${rc}`);
  return readOut(wasm, p, l);
}
