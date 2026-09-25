// src/host/fetch.mjs — portable upload-pack v2 client (no node: imports).
// Runs in Node / Browser / CF Workers. Protocol weight lifting lives in wasm
// (see wire.mjs); here is IO + framing + pack assembly:
//   discovery -> ls-refs -> fetch(sideband demux) -> unpack(delta resolve) -> store.
//
// Store interface: { get(hex)->Uint8Array|null, put(hex,loose), getRef, putRef }.
// Loose bytes stored are zlib("type len\0body") — same layout as git loose objects,
// so get()/commit() in browser.mjs / api.mjs read them back directly.
//
// Only platform ABIs used: fetch, CompressionStream, crypto.subtle, TextEncoder/Decoder.

import { buildLsRefsReq, buildFetchReq, listRefs, decodePackHeaderJS, inflateOne, deltaApply } from "./wire.mjs";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const TYPE_NAME = { 1: "commit", 2: "tree", 3: "blob", 4: "tag", 6: "ofs_delta", 7: "ref_delta" };

const joinUrl = (base, path) => base.replace(/\/+$/, "") + path;
const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function needPlatform(fetchImpl, subtle) {
  if (!fetchImpl) throw new Error("fetch unavailable on this platform (pass fetchImpl)");
  if (!subtle) throw new Error("crypto.subtle unavailable on this platform");
  if (typeof CompressionStream === "undefined") throw new Error("CompressionStream unavailable on this platform");
}

async function streamAll(stream, input) {
  const w = stream.writable.getWriter();
  await w.write(input);
  await w.close();
  const chunks = [];
  for await (const c of stream.readable) chunks.push(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
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

export const deflateRaw = (body) => streamAll(new CompressionStream("deflate"), body);

function looseBytes(type, body) {
  const head = enc.encode(`${type} ${body.length}\0`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

async function sha1Hex(subtle, bytes) {
  const d = await subtle.digest("SHA-1", bytes);
  return hexOf(new Uint8Array(d));
}

/// Split a pkt-line stream into payloads. Returns {lines:[Uint8Array], flushSeen}.
/// Tolerates flush (0000), delim (0001), response-end (0002).
export function splitPktLines(body) {
  const lines = [];
  let pos = 0;
  while (pos + 4 <= body.length) {
    const tag = dec.decode(body.subarray(pos, pos + 4));
    if (tag === "0000" || tag === "0001" || tag === "0002") {
      pos += 4;
      continue;
    }
    const len = parseInt(tag, 16);
    if (!Number.isFinite(len) || len < 4 || pos + len > body.length) throw new Error("bad pkt-line length");
    lines.push(body.subarray(pos + 4, pos + len));
    pos += len;
  }
  return lines;
}

/// Demux a v2 fetch response (sideband-64k) into {pack, shallow, progress}.
/// Accepts: [shallow lines + flush] + pkt("packfile\n") + band-1/2/3 chunks + flush.
/// Also tolerates a bare "PACK..." body (no sideband) for leniency.
export function decodeSideband(body) {
  if (body.length >= 4 && dec.decode(body.subarray(0, 4)) === "PACK") return { pack: body.slice(), shallow: [], progress: [] };
  const shallow = [];
  const progress = [];
  const packParts = [];
  let pos = 0;
  let inPack = false;
  while (pos + 4 <= body.length) {
    const tag = dec.decode(body.subarray(pos, pos + 4));
    if (tag === "0000" || tag === "0002") {
      pos += 4;
      continue;
    }
    if (tag === "0001") {
      pos += 4;
      inPack = true; // delim separates args from packfile section in some servers
      continue;
    }
    const len = parseInt(tag, 16);
    if (!Number.isFinite(len) || len < 4 || pos + len > body.length) throw new Error("bad sideband pkt-line");
    const payload = body.subarray(pos + 4, pos + len);
    pos += len;
    if (!inPack) {
      const text = dec.decode(payload);
      if (text === "packfile\n" || text === "packfile") {
        inPack = true;
        continue;
      }
      if (text.startsWith("shallow ")) {
        shallow.push(text.slice(8).trim());
        continue;
      }
      // Unknown preface: treat band-prefixed payloads as pack data anyway.
      if (payload.length > 0 && payload[0] <= 3) {
        inPack = true;
      } else {
        continue;
      }
    }
    if (payload.length === 0) continue;
    const band = payload[0];
    if (band === 1) packParts.push(payload.subarray(1));
    else if (band === 2) progress.push(dec.decode(payload.subarray(1)));
    else if (band === 3) throw new Error(`remote error: ${dec.decode(payload.subarray(1))}`);
    else throw new Error(`unknown sideband ${band}`);
  }
  let n = 0;
  for (const p of packParts) n += p.length;
  const pack = new Uint8Array(n);
  let o = 0;
  for (const p of packParts) {
    pack.set(p, o);
    o += p.length;
  }
  return { pack, shallow, progress };
}

function readU32BE(buf, pos) {
  return (buf[pos] * 2 ** 24 + (buf[pos + 1] << 16) + (buf[pos + 2] << 8) + buf[pos + 3]) >>> 0;
}

/// Unpack a pack buffer into resolved objects plus pending ref-deltas.
/// Returns {objects: [{type, body}], pending: [{baseHex, delta, expectSize}]}.
/// Non-delta + ofs-delta resolve here (offsets are positional, no hashing).
/// ref-delta needs base oid -> body, which requires SHA-1 (async subtle);
/// callers resolve `pending` via resolveRefDeltas() after hashing.
export function unpackPack(wasm, pack) {
  if (pack.length < 32 || dec.decode(pack.subarray(0, 4)) !== "PACK") throw new Error("not a pack");
  if (readU32BE(pack, 4) !== 2) throw new Error("unsupported pack version");
  const n = readU32BE(pack, 8);
  const end = pack.length - 20;
  let pos = 12;
  const byOffset = new Map(); // pack offset -> {type, body}
  const objects = [];
  const ofsdeltas = [];
  const pending = [];
  for (let i = 0; i < n; i++) {
    if (pos >= end) throw new Error("pack truncated");
    const h = decodePackHeaderJS(pack, pos);
    const objOffset = pos;
    pos = h.next;
    if (h.type <= 4) {
      const { body: inflated, consumed } = inflateOne(wasm, pack, pos);
      pos += consumed;
      if (inflated.length !== h.size) throw new Error(`size mismatch at offset ${objOffset}: header ${h.size} vs inflated ${inflated.length}`);
      const rec = { offset: objOffset, type: TYPE_NAME[h.type], body: inflated };
      objects.push(rec);
      byOffset.set(objOffset, rec);
    } else if (h.type === 6) {
      // ofs-delta: 裸 base 距离 varint (pack-format 的 +1 偏置编码,不在 zlib 流内) + zlib(delta 指令)
      const { baseDistance, next } = decodeOfsBaseOffset(pack, pos);
      pos = next;
      const { body: inflated, consumed } = inflateOne(wasm, pack, pos);
      pos += consumed;
      if (inflated.length !== h.size) throw new Error(`delta size mismatch at offset ${objOffset}`);
      ofsdeltas.push({ offset: objOffset, baseAbs: objOffset - baseDistance, delta: inflated, expectSize: decodeDeltaResultSize(inflated) });
    } else if (h.type === 7) {
      // ref-delta: 裸 20B base oid + zlib(delta 指令)
      if (pos + 20 > end) throw new Error("ref-delta base truncated");
      const baseHex = hexOf(pack.subarray(pos, pos + 20));
      pos += 20;
      const { body: inflated, consumed } = inflateOne(wasm, pack, pos);
      pos += consumed;
      if (inflated.length !== h.size) throw new Error(`delta size mismatch at offset ${objOffset}`);
      pending.push({ baseHex, delta: inflated, expectSize: decodeDeltaResultSize(inflated), offset: objOffset });
    } else {
      throw new Error(`unsupported pack type ${h.type} at offset ${objOffset}`);
    }
  }
  // ofs-delta to fixpoint (bases always precede: backward offsets)
  let guard = ofsdeltas.length * 2 + 8;
  while (ofsdeltas.length && guard-- > 0) {
    const p = ofsdeltas.shift();
    const base = byOffset.get(p.baseAbs) ?? null;
    if (!base) {
      ofsdeltas.push(p);
      continue;
    }
    const out = deltaApply(wasm, base.body, p.delta);
    if (out.length !== p.expectSize) throw new Error(`delta result size mismatch at offset ${p.offset}`);
    const rec = { offset: p.offset, type: base.type, body: out };
    objects.push(rec);
    byOffset.set(p.offset, rec);
  }
  if (ofsdeltas.length) throw new Error(`unresolvable ofs-deltas: ${ofsdeltas.length} (missing base — thin pack?)`);
  return { objects, pending, count: n, trailerEnd: end };
}

/// Resolve pending ref-deltas given hex-> {type, body} map (hashed pass-1
/// objects + optional store assist). Mutates `known`, returns newly resolved.
export function resolveRefDeltas(wasm, pending, known) {
  const out = [];
  let guard = pending.length * 2 + 8;
  while (pending.length && guard-- > 0) {
    const p = pending.shift();
    const base = known.get(p.baseHex) ?? null;
    if (!base) {
      pending.push(p);
      continue;
    }
    const body = deltaApply(wasm, base.body, p.delta);
    if (body.length !== p.expectSize) throw new Error(`ref-delta result size mismatch (base ${p.baseHex.slice(0, 7)})`);
    out.push({ type: base.type, body });
  }
  return out;
}
/// Decode an ofs-delta base distance from raw pack bytes at pos.
/// Encoding (pack-format): n bytes, MSB set on all but last; value = concat
/// lower 7 bits with +1 bias per continuation: off=(off+1)<<7|(c&127).
/// Returns {baseDistance, next}.
function decodeOfsBaseOffset(buf, pos) {
  let c = buf[pos++];
  let off = c & 127;
  while (c & 128) {
    off += 1;
    c = buf[pos++];
    off = (off << 7) | (c & 127);
  }
  return { baseDistance: off, next: pos };
}

/// Delta result size = second MSB varint in the inflated delta
/// (base_size, result_size, opcodes...). wasm re-validates on apply.
function decodeDeltaResultSize(delta) {
  let pos = 0;
  for (let k = 0; k < 2; k++) {
    let shift = 0;
    let v = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error("delta varint truncated");
      const c = delta[pos++];
      v |= (c & 127) << shift;
      if (!(c & 128)) break;
      shift += 7;
    }
    if (k === 1) return v;
  }
  throw new Error("unreachable");
}

/// Portable zlib inflate (DecompressionStream, Uint8Array in/out).
export const inflateZlib = (bytes) => streamAll(new DecompressionStream("deflate"), bytes);

/// Parse loose bytes ("type len\0body" after inflate) -> {type, body}.
export async function readLooseBody(loose) {
  const raw = await inflateZlib(new Uint8Array(loose));
  const nul = raw.indexOf(0);
  if (nul < 0) throw new Error("bad loose object");
  const head = dec.decode(raw.subarray(0, nul));
  const sp = head.indexOf(" ");
  const type = head.slice(0, sp);
  const len = Number(head.slice(sp + 1));
  const body = raw.subarray(nul + 1);
  if (body.length !== len) throw new Error("loose length mismatch");
  return { type, body };
}

export async function verifyPackTrailer(subtle, pack) {
  if (pack.length < 20) throw new Error("pack too short");
  const body = pack.subarray(0, pack.length - 20);
  const want = pack.subarray(pack.length - 20);
  const got = new Uint8Array(await subtle.digest("SHA-1", body));
  for (let i = 0; i < 20; i++) if (got[i] !== want[i]) throw new Error("pack trailer sha1 mismatch");
}

/// Full clone/fetch into store (portable).
/// opts: {fetchImpl=globalThis.fetch, subtle=globalThis.crypto.subtle,
///        filter="", ref="refs/heads/main", setRef=true, onProgress}
/// Returns {ref, oid, objects, packBytes, shallow}.
export async function fetchIntoStore(wasm, store, url, want, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const subtle = opts.subtle ?? globalThis.crypto?.subtle;
  needPlatform(fetchImpl, subtle);
  const filter = opts.filter ?? "";
  const headers = { "Git-Protocol": "version=2" };

  // 1. discovery (v2 gate)
  const discRes = await fetchImpl(joinUrl(url, "/info/refs?service=git-upload-pack"), { headers });
  if (!discRes.ok) throw new Error(`discovery http ${discRes.status}`);
  const disc = new Uint8Array(await discRes.arrayBuffer());
  if (!dec.decode(disc).includes("version 2")) throw new Error("server lacks protocol v2 (need version 2 advertisement)");

  // 2. ls-refs
  const lsBody = buildLsRefsReq(wasm);
  const lsRes = await fetchImpl(joinUrl(url, "/git-upload-pack"), {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-git-upload-pack-request" },
    body: lsBody,
  });
  if (!lsRes.ok) throw new Error(`ls-refs http ${lsRes.status}`);
  const refs = listRefs(wasm, new Uint8Array(await lsRes.arrayBuffer()));
  if (!refs.length) throw new Error("remote has no refs (empty repo — nothing to fetch)");

  // resolve want: full ref, short name, or raw oid
  let wantOid = null;
  let wantRef = null;
  if (/^[0-9a-f]{40}$/i.test(want)) {
    wantOid = want.toLowerCase();
    wantRef = refs[0]?.name ?? null;
  } else {
    const full = want.startsWith("refs/") ? want : `refs/heads/${want}`;
    const hit = refs.find((r) => r.name === full) ?? refs.find((r) => r.name === want);
    if (!hit) throw new Error(`remote ref not found: ${want} (have: ${refs.map((r) => r.name).join(", ")})`);
    wantOid = hit.oid.toLowerCase();
    wantRef = hit.name;
  }

  // 3. fetch (skip if already present)
  if (store.get(wantOid)) {
    if (opts.setRef !== false && wantRef) store.putRef(wantRef, wantOid);
    return { ref: wantRef, oid: wantOid, objects: 0, packBytes: 0, shallow: [], cached: true, refs };
  }
  const fetchBody = buildFetchReq(wasm, [wantOid], filter);
  const fRes = await fetchImpl(joinUrl(url, "/git-upload-pack"), {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-git-upload-pack-request" },
    body: fetchBody,
  });
  if (!fRes.ok) throw new Error(`fetch http ${fRes.status}`);
  const raw = new Uint8Array(await fRes.arrayBuffer());
  const { pack, shallow, progress } = decodeSideband(raw);
  if (opts.onProgress && progress.length) opts.onProgress(progress);
  if (pack.length < 32) throw new Error(`fetch response has no pack (${pack.length}B, progress: ${progress.join("; ").slice(0, 200)})`);
  await verifyPackTrailer(subtle, pack);

  // 4. unpack: pass 1 (sync, no hashing) -> hash -> resolve ref-deltas.
  const { objects, pending } = unpackPack(wasm, pack);
  const known = new Map(); // hex -> {type, body}
  for (const o of objects) {
    const hex = await sha1Hex(subtle, looseBytes(o.type, o.body));
    o.hex = hex;
    known.set(hex, o);
  }
  if (pending.length) {
    // On-demand store assist (thin-pack bases already local): inflate loose async.
    for (const p of pending) {
      if (!known.has(p.baseHex)) {
        const loose = store.get(p.baseHex);
        if (loose) {
          const { type, body } = await readLooseBody(loose);
          known.set(p.baseHex, { type, body, hex: p.baseHex });
        }
      }
    }
    const extra = resolveRefDeltas(wasm, pending, known);
    for (const o of extra) {
      const hex = await sha1Hex(subtle, looseBytes(o.type, o.body));
      o.hex = hex;
      known.set(hex, o);
      objects.push(o);
    }
    if (pending.length) throw new Error(`unresolvable ref-deltas: ${pending.length} (base ${pending[0].baseHex.slice(0, 7)} missing — thin pack or filter omission?)`);
  }
  // 5. store as loose
  let stored = 0;
  for (const o of objects) {
    const raw_loose = looseBytes(o.type, o.body);
    const z = await deflateRaw(raw_loose);
    store.put(o.hex, z);
    stored++;
  }
  // sanity: wantOid must now exist (unless filter omitted it — e.g. blob:none never omits commits)
  if (!store.get(wantOid)) throw new Error(`fetched pack lacks wanted object ${wantOid} (got ${stored} objects)`);
  if (opts.setRef !== false && wantRef) store.putRef(wantRef, wantOid);
  return { ref: wantRef, oid: wantOid, objects: stored, packBytes: pack.length, shallow, refs };
}

/// List remote refs without fetching objects.
export async function lsRemote(wasm, url, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const headers = { "Git-Protocol": "version=2" };
  const discRes = await fetchImpl(joinUrl(url, "/info/refs?service=git-upload-pack"), { headers });
  if (!discRes.ok) throw new Error(`discovery http ${discRes.status}`);
  const lsBody = buildLsRefsReq(wasm);
  const lsRes = await fetchImpl(joinUrl(url, "/git-upload-pack"), {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-git-upload-pack-request" },
    body: lsBody,
  });
  if (!lsRes.ok) throw new Error(`ls-refs http ${lsRes.status}`);
  return listRefs(wasm, new Uint8Array(await lsRes.arrayBuffer()));
}
