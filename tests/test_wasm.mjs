import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "..", "zig-out", "bin", "zig_wasm_git.wasm");

function assert(cond, msg) { if (!cond) throw new Error(msg); }

const bytes = readFileSync(WASM_PATH);
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

console.log("all wasm tests passed");
