// src/host/sync.mjs — remote sync clients (JS side: IO + enumeration; wire protocol in wasm).
// Prerequisites: fetch, CompressionStream, crypto.subtle (Node 18+/Workers/
// modern browsers; no runtime checks — missing pieces fail naturally).
// fetchImpl/subtle are required opts, resolved once by loadFromBytes.
// Sections:
//   fetch: upload-pack v2 (discovery -> ls-refs -> fetch/sideband demux ->
//          unpack/delta resolve -> store), plus lsRemote
//   push:  receive-pack (discovery -> collect -> pack -> ref-update -> status)

import {
  buildLsRefsReq, buildFetchReq, listRefs, decodePackHeaderJS, inflateOne, deltaApply,
  decodeRefsTlv, looseBody, parseTreeEntries, commitParentsAndTree,
  deflateZlib, hexOfBytes, joinUrl, enc, dec,
} from "./utils.mjs";

export { decodeRefsTlv };

const _utf8 = (b) => dec.decode(b instanceof Uint8Array ? b : new Uint8Array(b));

// ── fetch ──

const TYPE_NAME = { 1: "commit", 2: "tree", 3: "blob", 4: "tag", 6: "ofs_delta", 7: "ref_delta" };

function looseBytes(type, body) {
  const head = enc.encode(`${type} ${body.length}\0`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

async function sha1Hex(subtle, bytes) {
  const d = await subtle.digest("SHA-1", bytes);
  return hexOfBytes(new Uint8Array(d));
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
      const baseHex = hexOfBytes(pack.subarray(pos, pos + 20));
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

export async function verifyPackTrailer(subtle, pack) {
  if (pack.length < 20) throw new Error("pack too short");
  const body = pack.subarray(0, pack.length - 20);
  const want = pack.subarray(pack.length - 20);
  const got = new Uint8Array(await subtle.digest("SHA-1", body));
  for (let i = 0; i < 20; i++) if (got[i] !== want[i]) throw new Error("pack trailer sha1 mismatch");
}

/// Full clone/fetch into store (portable).
/// opts: {fetchImpl, subtle} (required — resolved once by loadFromBytes;
/// see portable prerequisites), plus {filter="", ref="refs/heads/main",
/// setRef=true, onProgress}.
/// Returns {ref, oid, objects, packBytes, shallow}.
export async function fetchIntoStore(wasm, store, url, want, opts = {}) {
  const fetchImpl = opts.fetchImpl;
  const subtle = opts.subtle;
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
          const { type, body } = await looseBody(loose);
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
    const z = await deflateZlib(raw_loose);
    store.put(o.hex, z);
    stored++;
  }
  // sanity: wantOid must now exist (unless filter omitted it — e.g. blob:none never omits commits)
  if (!store.get(wantOid)) throw new Error(`fetched pack lacks wanted object ${wantOid} (got ${stored} objects)`);
  if (opts.setRef !== false && wantRef) store.putRef(wantRef, wantOid);
  return { ref: wantRef, oid: wantOid, objects: stored, packBytes: pack.length, shallow, refs };
}

/// List remote refs without fetching objects (fetchImpl required, see above).
export async function lsRemote(wasm, url, opts = {}) {
  const fetchImpl = opts.fetchImpl;
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

// ── push ──

export const ZERO_OID = "0".repeat(40);
export const TYPE_NUM = { commit: 1, tree: 2, blob: 3, tag: 4 };

/// 把 haves 可达的全部对象标进 seen(只标不发;缺失则跳过——多发不少发)
async function markReachable(store, haveHexes, seen) {
  const queue = [...haveHexes].map((h) => h.toLowerCase());
  const tqueue = [];
  while (queue.length) {
    const hex = queue.pop();
    if (seen.has(hex)) continue;
    const loose = store.get(hex);
    if (!loose) continue;
    const { type, body } = await looseBody(loose);
    seen.add(hex);
    if (type === "commit") {
      const { parents, tree } = commitParentsAndTree(body);
      for (const p of parents) queue.push(p.toLowerCase());
      if (tree) tqueue.push(tree.toLowerCase());
    } else if (type === "tag") {
      const m = _utf8(body).match(/^object ([0-9a-f]{40})/m);
      if (m) queue.push(m[1].toLowerCase());
    } else if (type === "tree") {
      tqueue.push(hex);
    }
  }
  while (tqueue.length) {
    const hex = tqueue.pop();
    if (seen.has(hex)) continue;
    const loose = store.get(hex);
    if (!loose) continue;
    const { type, body } = await looseBody(loose);
    if (type !== "tree") { seen.add(hex); continue; }
    seen.add(hex);
    for (const e of parseTreeEntries(body)) {
      if (seen.has(e.oid)) continue;
      if (e.mode === "40000" || e.mode === "040000") tqueue.push(e.oid);
      else if (e.mode !== "160000") seen.add(e.oid); // blob:只标不取,不 inflate
    }
  }
}

/// JS 侧对象枚举(与 wasm push.collectObjects 同算法,见其测试):返回 [{hex, type, body}]
export async function collectObjects(store, newOid, haves = new Set()) {
  const seen = new Set();
  await markReachable(store, [...haves], seen);
  const commits = [], tags = [], trees = [], blobs = [];
  const want = (hex) => hex && !seen.has(hex.toLowerCase());
  const mark = (hex) => seen.add(hex.toLowerCase());
  newOid = newOid.toLowerCase();

  const first = await looseBody(store.get(newOid) ?? (() => { throw new Error(`local object missing: ${newOid}`); })());
  let tagCommit = null, tagTree = null;
  if (first.type === "tag") {
    mark(newOid);
    tags.push({ hex: newOid, type: "tag", body: first.body });
    const m = _utf8(first.body).match(/^object ([0-9a-f]{40})\ntype (\w+)/m);
    if (!m) throw new Error("bad tag");
    if (want(m[1])) {
      if (m[2] === "commit") tagCommit = m[1].toLowerCase();
      else if (m[2] === "tree") tagTree = m[1].toLowerCase();
      else if (m[2] === "blob") {
        mark(m[1]);
        const b = await looseBody(store.get(m[1].toLowerCase()) ?? (() => { throw new Error(`local object missing: ${m[1]}`); })());
        blobs.push({ hex: m[1].toLowerCase(), type: "blob", body: b.body });
      } else throw new Error(`nested tag todo: ${m[2]}`);
    }
  } else if (first.type !== "commit") {
    throw new Error(`expected commit or tag, got ${first.type}`);
  }

  // commit BFS
  const queue = [];
  if (first.type === "commit") queue.push(newOid);
  if (tagCommit) queue.push(tagCommit);
  const treeRoots = [];
  if (tagTree) treeRoots.push(tagTree);
  while (queue.length) {
    const hex = queue.pop();
    if (!want(hex)) continue;
    const loose = store.get(hex);
    if (!loose) throw new Error(`local object missing: ${hex}`);
    const { type, body } = await looseBody(loose);
    if (type !== "commit") throw new Error(`expected commit, got ${type}: ${hex}`);
    mark(hex);
    const { parents, tree } = commitParentsAndTree(body);
    commits.push({ hex, type: "commit", body });
    for (const p of parents) if (want(p)) queue.push(p.toLowerCase());
    if (tree && want(tree)) treeRoots.push(tree.toLowerCase());
  }
  // tree DFS + blob
  while (treeRoots.length) {
    const hex = treeRoots.pop();
    if (!want(hex)) continue;
    const loose = store.get(hex);
    if (!loose) throw new Error(`local object missing: ${hex}`);
    const { type, body } = await looseBody(loose);
    if (type !== "tree") throw new Error(`expected tree, got ${type}: ${hex}`);
    mark(hex);
    trees.push({ hex, type: "tree", body });
    for (const e of parseTreeEntries(body)) {
      if (!want(e.oid)) continue;
      if (e.mode === "40000" || e.mode === "040000") treeRoots.push(e.oid);
      else if (e.mode === "160000") continue; // gitlink 不打包
      else {
        const l = store.get(e.oid);
        if (!l) throw new Error(`local object missing: ${e.oid}`);
        const o = await looseBody(l);
        if (o.type !== "blob") throw new Error(`unexpected tree entry type ${o.type}: ${e.oid}`);
        mark(e.oid);
        blobs.push({ hex: e.oid, type: "blob", body: o.body });
      }
    }
  }
  return [...commits, ...tags, ...trees, ...blobs];
}

/// 解 wasm_parse_report_status 的 TLV:
/// u8 unpack_ok, u16 umsg_len, umsg, u16 n, per: u8 ok, u16 ref_len, ref, [ng: u16 msg_len, msg]
export function decodeStatusTlv(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let pos = 0;
  const unpackOk = u8[pos++] === 1;
  const umlen = dv.getUint16(pos, true); pos += 2;
  const unpackMsg = dec.decode(u8.subarray(pos, pos + umlen)); pos += umlen;
  const n = dv.getUint16(pos, true); pos += 2;
  const refs = [];
  for (let i = 0; i < n; i++) {
    const ok = u8[pos++] === 1;
    const rlen = dv.getUint16(pos, true); pos += 2;
    const ref = dec.decode(u8.subarray(pos, pos + rlen)); pos += rlen;
    let msg = "";
    if (!ok) {
      const mlen = dv.getUint16(pos, true); pos += 2;
      msg = dec.decode(u8.subarray(pos, pos + mlen)); pos += mlen;
    }
    refs.push({ ref, ok, msg });
  }
  return { unpackOk, unpackMsg, refs };
}
