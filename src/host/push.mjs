// src/host/push.mjs — receive-pack 客户端编排 (JS 侧:IO + 枚举 + 压缩;线协议在 wasm)
// 流程: GET info/refs?service=git-receive-pack -> wasm_find_ref -> JS collect ->
// CS deflate -> wasm pack 会话 -> wasm ref-update -> POST -> wasm status 解析
// 可移植:无 node: 导入 (Uint8Array + TextDecoder;Buffer 调用方照常兼容)。
import { looseBody, parseTreeEntries, commitParentsAndTree, deflateZlib } from "./codec.mjs";

const _dec = new TextDecoder();
const _utf8 = (b) => _dec.decode(b instanceof Uint8Array ? b : new Uint8Array(b));

export const ZERO_OID = "0".repeat(40);
export const TYPE_NUM = { commit: 1, tree: 2, blob: 3, tag: 4 };

const joinUrl = (base, path) => base.replace(/\/+$/, "") + path;

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

/// 解 wasm_list_refs 的 TLV:u16 n, per: 40B hex, u16 name_len, name
export function decodeRefsTlv(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let pos = 0;
  const n = dv.getUint16(pos, true); pos += 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const oid = _dec.decode(u8.subarray(pos, pos + 40)); pos += 40;
    const nlen = dv.getUint16(pos, true); pos += 2;
    const name = _dec.decode(u8.subarray(pos, pos + nlen)); pos += nlen;
    out.push({ oid, name });
  }
  return out;
}

/// 解 wasm_parse_report_status 的 TLV:
/// u8 unpack_ok, u16 umsg_len, umsg, u16 n, per: u8 ok, u16 ref_len, ref, [ng: u16 msg_len, msg]
export function decodeStatusTlv(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let pos = 0;
  const unpackOk = u8[pos++] === 1;
  const umlen = dv.getUint16(pos, true); pos += 2;
  const unpackMsg = _dec.decode(u8.subarray(pos, pos + umlen)); pos += umlen;
  const n = dv.getUint16(pos, true); pos += 2;
  const refs = [];
  for (let i = 0; i < n; i++) {
    const ok = u8[pos++] === 1;
    const rlen = dv.getUint16(pos, true); pos += 2;
    const ref = _dec.decode(u8.subarray(pos, pos + rlen)); pos += rlen;
    let msg = "";
    if (!ok) {
      const mlen = dv.getUint16(pos, true); pos += 2;
      msg = _dec.decode(u8.subarray(pos, pos + mlen)); pos += mlen;
    }
    refs.push({ ref, ok, msg });
  }
  return { unpackOk, unpackMsg, refs };
}

export { deflateZlib, joinUrl };
