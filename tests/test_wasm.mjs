import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "..", "zig-out", "bin", "zig_wasm_git.wasm");

function assert(cond, msg) { if (!cond) throw new Error(msg); }

const bytes = readFileSync(WASM_PATH);
// 体积预算 64KiB:服务端 helper 出二进制后 ~60KB,远小于 CF 参考实现 ~100KB,
// 后续只减不增。
assert(bytes.length <= 64 * 1024, `wasm size budget blown: ${bytes.length} > 65536`);
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

// blob:none / filter omit decisions live in JS now (filter.zig is still unit
// tested via `zig test`); the client binary only ships client-side protocol,
// pack framing, inflate and delta. These server-side helpers must stay out:
// wasm_handle_discovery, wasm_parse_filter, wasm_should_omit,
// wasm_pktline_encode, wasm_find_ref.
for (const gone of ["wasm_handle_discovery", "wasm_parse_filter", "wasm_should_omit", "wasm_pktline_encode", "wasm_find_ref"]) {
  assert(wasm[gone] === undefined, `${gone} must not ship in the client binary`);
}
console.log("server-side helpers absent ok");

// Path validation lives in JS (assertKeys) — wasm trusts its caller.
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

  for (const k of ["a.txt", "a/b.txt", ".github/w.yml", "üñî.md", "a b/c-d_e.f"]) {
    assert(commit([[k, "v"]]) === 0, `wasm_commit should accept ${JSON.stringify(k)}`);
  }
  console.log("wasm_commit smoke ok");
}

console.log("all wasm tests passed");
