// tests/test_push.mjs — 新编排 e2e:repo.push() 直推本地 server.mjs,真 git 验收 + wasm/JS pack 照
import { spawn, execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load, memoryStore } from "../src/host/api.mjs";
import { collectObjects } from "../src/host/push.mjs";
import { deflateZlib } from "../src/host/codec.mjs";
import { buildPack } from "../src/host/pack.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = join(ROOT, "zig-out/bin/zig_wasm_git.wasm");
const PORT = 32123;
const BASE = `http://localhost:${PORT}/pushtest.git`;
const SERVER_REPO = join(ROOT, "data/pushtest.git");
rmSync(SERVER_REPO, { recursive: true, force: true });

const server = spawn("node", ["src/host/server.mjs"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (c) => { log += c; });
server.stderr.on("data", (c) => { log += c; });
try {
  const t0 = Date.now();
  while (!log.includes("listening on")) {
    if (Date.now() - t0 > 10000) throw new Error("server did not start:\n" + log.slice(-2000));
    await new Promise((r) => setTimeout(r, 100));
  }

  const store = memoryStore();
  const local = load(WASM, { store });
  const c1 = local.commit("", "init", { "README.md": "hello push\n", "src/a.txt": "a\n" });
  console.log("local c1:", c1);

  // ── differential:wasm pack 字节 == JS 参考实现(同 deflated 输入) ──
  const objects = await collectObjects(store, c1, new Set());
  console.log(`collected: ${objects.length} objects (${objects.map((o) => o.type).join(",")})`);
  const wasmPack = await local.pushPack(objects);
  const { hexOfBytes } = await import("../src/host/codec.mjs");
  const devMap = new Map();
  for (const o of objects) devMap.set(hexOfBytes(o.body), await deflateZlib(o.body));
  const refPack = buildPack(objects.map((o) => ({ type: o.type, body: o.body })), {
    deflate: (b) => devMap.get(hexOfBytes(b)),
  });
  if (!wasmPack.equals(refPack)) throw new Error(`wasm/JS pack mismatch: ${wasmPack.length} vs ${refPack.length}`);
  console.log(`differential ok: pack=${wasmPack.length}B byte-identical`);
  // wasm pack 直接喂真 git
  const { mkdirSync, readdirSync } = await import("node:fs");
  const tmpd = join(ROOT, "tmp/test_push_pack");
  rmSync(tmpd, { recursive: true, force: true });
  mkdirSync(tmpd, { recursive: true });
  execFileSync("git", ["init", "-q", join(tmpd, "repo")]);
  execFileSync("git", ["-C", join(tmpd, "repo"), "index-pack", "--stdin"], { input: wasmPack });
  const back = execFileSync("git", ["-C", join(tmpd, "repo"), "cat-file", "-p", `${c1}:README.md`]).toString();
  if (back !== "hello push\n") throw new Error("wasm pack cat-file mismatch");
  console.log("wasm pack accepted by git");
  rmSync(tmpd, { recursive: true, force: true });

  // ── 首推(新分支) ──
  const r1 = await local.push(BASE, "refs/heads/main");
  console.log("push1:", JSON.stringify({ ...r1, new: r1.new.slice(0, 7) }));
  if (!r1.updated || r1.objects < 4) throw new Error(`push1 suspect: objects=${r1.objects}`);
  const ref1 = execFileSync("git", ["--git-dir", SERVER_REPO, "rev-parse", "refs/heads/main"]).toString().trim();
  if (ref1 !== c1) throw new Error(`server ref mismatch: ${ref1} != ${c1}`);
  const readme = execFileSync("git", ["--git-dir", SERVER_REPO, "cat-file", "-p", `${c1}:README.md`]).toString();
  if (readme !== "hello push\n") throw new Error("server blob mismatch");
  execFileSync("git", ["--git-dir", SERVER_REPO, "fsck", "--strict"]);
  console.log("server fsck clean");

  // ── noop ──
  const rNoop = await local.push(BASE, "main");
  if (rNoop.updated) throw new Error("noop push should not update");
  console.log("noop ok");

  // ── 增量推 ──
  const c2 = local.commit("main", "v2", { "README.md": "hello v2\n" });
  const r2 = await local.push(BASE, "refs/heads/main");
  console.log("push2:", JSON.stringify({ ...r2, new: r2.new.slice(0, 7), old: r2.old.slice(0, 7) }));
  if (!r2.updated) throw new Error("push2 failed");
  if (r2.objects >= r1.objects) throw new Error(`incremental should send fewer: ${r2.objects} vs ${r1.objects}`);
  const log2 = execFileSync("git", ["--git-dir", SERVER_REPO, "log", "--oneline", "refs/heads/main"]).toString().trim();
  if (log2.split("\n").length !== 2) throw new Error("server should have 2 commits");
  console.log("server log:\n  " + log2.split("\n").join("\n  "));

  console.log("ALL PUSH TESTS PASSED");
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(SERVER_REPO, { recursive: true, force: true });
}
