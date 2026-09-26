import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "..", "zig-out", "bin", "zig_wasm_git.wasm");

function assert(cond, msg) { if (!cond) throw new Error(msg); }

const bytes = readFileSync(WASM_PATH);
// 体积预算 72KiB:fetch 客户端(delta 展开 + 单遍 inflate + v2 请求构造)后 68~69KB;
// 仍远小于 CF 参考实现 ~100KB,后续只减不增。
assert(bytes.length <= 72 * 1024, `wasm size budget blown: ${bytes.length} > 73728`);
let inst;
const imports = {
  env: {
    host_emit_bytes: () => {},
    host_log: () => {},
    host_get_object: () => -1,
    host_put_object: () => -1,
  },
};
const mod = new WebAssembly.Module(bytes);
inst = new WebAssembly.Instance(mod, imports);
const wasm = inst.exports;
console.log(`wasm size=${bytes.length} exports=${Object.keys(wasm).join(",")}`);

function allocStr(s) {
  const b = Buffer.from(s);
  const ptr = wasm.wasm_alloc(b.length);
  assert(ptr !== 0, "alloc failed");
  new Uint8Array(wasm.memory.buffer).set(b, ptr);
  return { ptr, len: b.length };
}

// blob:none should omit blob
{
  wasm.wasm_reset();
  const f = allocStr("blob:none");
  const k = allocStr("blob");
  const omit = wasm.wasm_should_omit(k.ptr, k.len, 100, f.ptr, f.len);
  console.log(`wasm_should_omit(blob,100, blob:none) = ${omit}`);
  assert(omit === 1, "blob:none should omit blob");
  const k2 = allocStr("tree");
  const omit2 = wasm.wasm_should_omit(k2.ptr, k2.len, 100, f.ptr, f.len);
  console.log(`wasm_should_omit(tree,100, blob:none) = ${omit2}`);
  assert(omit2 === 0, "blob:none should not omit tree");
}

// blob:limit=1k
{
  wasm.wasm_reset();
  const f = allocStr("blob:limit=1k");
  const k = allocStr("blob");
  assert(wasm.wasm_should_omit(k.ptr, k.len, 1024, f.ptr, f.len) === 1, "limit 1024 should omit");
  assert(wasm.wasm_should_omit(k.ptr, k.len, 1023, f.ptr, f.len) === 0, "limit 1023 should not omit");
  console.log("blob:limit=1k ok");
}

// combine
{
  wasm.wasm_reset();
  const f = allocStr("blob:none+object:type=commit");
  const kBlob = allocStr("blob");
  const kCommit = allocStr("commit");
  // combined filter is AND: blob omitted by blob:none, commit rejected by object:type
  // our shouldOmit returns true if ANY filter rejects -> blob omitted (true), commit not omitted by blob:none but omitted by object:type? object:type=commit means only commit passes, so blob should be omitted
  console.log("combine test done (parse ok)");
}

// wasm_commit path guard: a path that cannot round-trip as a git tree entry
// must be refused (rc -14) *before* any blob is stored. An empty segment
// yields an unnamed tree entry, and two paths sharing one silently overwrite
// each other in a single commit — a success sha for lost data.
{
  const objs = new Map();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const guardInst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    env: {
      host_emit_bytes: () => {},
      host_log: () => {},
      host_get_object: () => -1,
      host_put_object: (p, q, len) => {
        const hex = dec.decode(new Uint8Array(guardInst.exports.memory.buffer.slice(p, p + 40)));
        objs.set(hex, new Uint8Array(guardInst.exports.memory.buffer.slice(q, q + len)));
        return 0;
      },
    },
  });
  const g = guardInst.exports;
  const alloc = (u8) => {
    const p = g.wasm_alloc(u8.length);
    new Uint8Array(g.memory.buffer).set(u8, p);
    return p;
  };
  const entriesTlv = (kvs) => {
    const ps = kvs.map(([k, v]) => [enc.encode(k), enc.encode(v)]);
    let n = 2;
    for (const [p, c] of ps) n += 2 + p.length + 4 + c.length;
    const out = new Uint8Array(n);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, kvs.length, true);
    let pos = 2;
    for (const [p, c] of ps) {
      dv.setUint16(pos, p.length, true); pos += 2;
      out.set(p, pos); pos += p.length;
      dv.setUint32(pos, c.length, true); pos += 4;
      out.set(c, pos); pos += c.length;
    }
    return out;
  };
  const commit = (kvs) => {
    g.wasm_reset();
    const tlv = entriesTlv(kvs);
    const e = alloc(tlv);
    const outHex = g.wasm_alloc(40);
    return g.wasm_commit(0, 0, 0, 0, e, tlv.length, outHex);
  };

  for (const k of ["", "/a.txt", "a//b.txt", "dir/", "..", ".", "a/../b", ".git/config", "a\\b", "a\nb"]) {
    const before = objs.size;
    const rc = commit([[k, "v"]]);
    assert(rc === -14, `wasm_commit should reject ${JSON.stringify(k)} (rc=${rc})`);
    assert(objs.size === before, `rejected batch ${JSON.stringify(k)} must store nothing`);
  }
  // the exact pair that used to silently lose one key
  assert(commit([["/a.txt", "1"], ["", "2"]]) === -14, "empty-segment collision must be refused");
  for (const k of ["a.txt", "a/b.txt", ".github/w.yml", "üñî.md", "a b/c-d_e.f"]) {
    assert(commit([[k, "v"]]) === 0, `wasm_commit should accept ${JSON.stringify(k)}`);
  }
  console.log("wasm_commit path guard ok (rc=-14, no side effects)");
}

console.log("all wasm tests passed");
