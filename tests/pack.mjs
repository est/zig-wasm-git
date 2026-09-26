// tests/pack.mjs — pack v2 组装/解析 (JS 侧,非 delta,测试参考实现)
// 格式(已用真 git 对照验证):
//   "PACK" + u32BE(2) + u32BE(n) + per obj[varint(type,size=body.len) + zlib(body)] + sha1(trailer)
// 注意:payload 是 zlib(body only),不含 "type len\0" 头;size 也是 body.len。
// 压缩/hash 经参数注入:Node 默认用原生 zlib/crypto;Workers 侧可换
// CompressionStream('deflate')+手写 zlib 包裹/adler + subtle.digest(sha1)。
import { deflateSync, inflateSync } from "node:zlib";
import { createHash } from "node:crypto";

export const PACK_TYPE_NUM = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const PACK_TYPE_NAME = { 1: "commit", 2: "tree", 3: "blob", 4: "tag", 6: "ofs_delta", 7: "ref_delta" };
const nodeDeflate = (b) => deflateSync(b);
const nodeSha1 = (b) => createHash("sha1").update(b).digest();

/// pack 对象头 varint: [1bit cont][3bit type][4bit size低位],后续每字节 7bit LE + cont 位
export function encodeObjectHeader(typeNum, size) {
  const out = [(size >> 4) !== 0 ? (((typeNum & 7) << 4) | (size & 0x0f) | 0x80) : (((typeNum & 7) << 4) | (size & 0x0f))];
  let sz = size >>> 4;
  while (sz !== 0) {
    let b = sz & 0x7f;
    sz >>>= 7;
    if (sz !== 0) b |= 0x80;
    out.push(b);
  }
  return Buffer.from(out);
}

export function decodeObjectHeader(buf, pos = 0) {
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

/// objects: [{type: "commit"|"tree"|"blob"|"tag", body: Buffer}] -> 完整 pack Buffer(含 trailer sha1)
export function buildPack(objects, { deflate = nodeDeflate, sha1 = nodeSha1 } = {}) {
  const parts = [Buffer.from("PACK"), Buffer.from([0, 0, 0, 2])];
  const nb = Buffer.alloc(4);
  nb.writeUInt32BE(objects.length);
  parts.push(nb);
  for (const o of objects) {
    const tn = PACK_TYPE_NUM[o.type];
    if (!tn) throw new Error(`unknown object type: ${o.type}`);
    const body = Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body);
    parts.push(encodeObjectHeader(tn, body.length));
    const z = deflate(body);
    parts.push(Buffer.isBuffer(z) ? z : Buffer.from(z));
  }
  const body = Buffer.concat(parts);
  const digest = sha1(body);
  return Buffer.concat([body, Buffer.isBuffer(digest) ? digest : Buffer.from(digest)]);
}

/// 最小解析器(校验 trailer + 逐对象 inflate),用于测试/调试;delta 对象只返回元信息不展开
export function parsePack(buf, { inflate = inflateSync, sha1 = nodeSha1 } = {}) {
  if (buf.length < 32 || buf.subarray(0, 4).toString() !== "PACK") throw new Error("not a pack");
  if (buf.readUInt32BE(4) !== 2) throw new Error("unsupported pack version");
  const n = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  if (!sha1(buf.subarray(0, buf.length - 20)).equals(trailer)) throw new Error("pack trailer sha1 mismatch");
  const objs = [];
  let pos = 12;
  for (let i = 0; i < n; i++) {
    const h = decodeObjectHeader(buf, pos);
    pos = h.next;
    // payload 是 zlib 流:逐字节试探最小合法前缀(与 git probe 同法;生产路径不需要 parse)
    let body = null, used = -1;
    for (let L = 1; L <= buf.length - 20 - pos; L++) {
      try { body = inflate(buf.subarray(pos, pos + L)); used = L; break; } catch {}
    }
    if (!body) throw new Error(`object ${i}: bad zlib payload`);
    objs.push({ type: PACK_TYPE_NAME[h.type] ?? `unknown(${h.type})`, typeNum: h.type, size: h.size, body });
    pos += used;
  }
  return objs;
}
