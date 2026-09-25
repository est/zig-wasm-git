// src/host/codec.mjs — 平台能力层 (JS 侧):压缩/解压/loose 解析
// 全部基于 Web 标准 CompressionStream/DecompressionStream:Node 与 Workers/CF 同一份代码。
// 按 spec,'deflate' 格式即 zlib 结构(头 78 9c + adler),直出即可做 pack payload / 解 loose。
// 可移植:只用 Uint8Array + TextEncoder/Decoder,无 node: 导入 (Buffer 是 Uint8Array 子类,
// Node 调用方照常工作;需要 hex/utf8 字符串处显式编解码,不依赖 Buffer.toString)。
const _dec = new TextDecoder();

export function hexOfBytes(b) {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export const joinUrl = (base, path) => base.replace(/\/+$/, "") + path;

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

/// loose("type len\0body" zlib) -> {type, body: Uint8Array}
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
