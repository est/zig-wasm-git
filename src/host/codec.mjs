// src/host/codec.mjs — 平台能力层 (JS 侧):压缩/解压/loose 解析
// 全部基于 Web 标准 CompressionStream/DecompressionStream:Node 与 Workers/CF 同一份代码。
// 按 spec,'deflate' 格式即 zlib 结构(头 78 9c + adler),直出即可做 pack payload / 解 loose。
function needCS() {
  if (typeof CompressionStream === "undefined" || typeof DecompressionStream === "undefined") {
    throw new Error("CompressionStream/DecompressionStream unavailable on this platform");
  }
}

async function streamAll(stream, input) {
  const w = stream.writable.getWriter();
  await w.write(input);
  await w.close();
  const chunks = [];
  for await (const c of stream.readable) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
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

/// loose("type len\0body" zlib) -> {type, body}
export async function looseBody(loose) {
  const raw = await inflateZlib(loose);
  const nul = raw.indexOf(0);
  if (nul < 0) throw new Error("bad loose object");
  const [type, len] = raw.subarray(0, nul).toString().split(" ");
  const body = raw.subarray(nul + 1);
  if (body.length !== Number(len)) throw new Error("loose length mismatch");
  return { type, body: Buffer.from(body) };
}

/// tree body -> [{mode, name, oid(hex)}]
export function parseTreeEntries(body) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    const nul = body.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > body.length) throw new Error("bad tree body");
    out.push({
      mode: body.subarray(i, sp).toString(),
      name: body.subarray(sp + 1, nul).toString(),
      oid: body.subarray(nul + 1, nul + 21).toString("hex"),
    });
    i = nul + 21;
  }
  return out;
}

export function commitParentsAndTree(body) {
  const parents = [];
  let tree = null;
  for (const line of body.toString().split("\n")) {
    if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
    else if (line.startsWith("tree ") && tree === null) tree = line.slice(5, 45);
    else if (line === "") break;
  }
  return { parents, tree };
}
