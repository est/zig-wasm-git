// src/host/wire.mjs — portable wasm call wrappers (no node: imports).
// Binds the git-protocol weight-lifting exports to JS callables over any
// WebAssembly.Instance with the 3 storage-free imports used by fetch paths.
// Object-store paths (get/commit) attach host_get/put_object separately
// (see browser.mjs / api.mjs); the helpers below only need host_emit_bytes.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function bootWasm(wasmBytes, extraEnv = {}) {
  const emitChunks = [];
  let inst;
  const mod = new WebAssembly.Module(wasmBytes);
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
