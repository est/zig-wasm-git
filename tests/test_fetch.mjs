// tests/test_fetch.mjs — upload-pack v2 客户端 e2e (worker-like, 客户端零 CLI).
// 远端是 server.mjs (测试工具,可用 git);客户端只用 wasm + fetch + CompressionStream + subtle。
// 覆盖:全量 fetch -> get() 读文件;gc 压出 delta 后的 fetch(delta 展开);blob:none (promisor)。
import { spawn, execFileSync } from "node:child_process";
import { rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load, memoryStore } from "../src/host/api.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = join(ROOT, "zig-out/bin/zig_wasm_git.wasm");
const PORT = 32127;
const BASE = `http://localhost:${PORT}/fetchtest.git`;
const SERVER_REPO = join(ROOT, "data/fetchtest.git");
rmSync(SERVER_REPO, { recursive: true, force: true });

// ── 0. 可移植断言:客户端链路零 node: 导入 ──
for (const f of ["utils.mjs", "sync.mjs", "portable.mjs"]) {
  const src = readFileSync(join(ROOT, "src/host", f), "utf8");
  if (/from\s+["']node:/.test(src) || /require\s*\(/.test(src)) throw new Error(`${f} must stay portable (no node: imports)`);
  if (/child_process|execFile|readFileSync|writeFileSync/.test(src)) throw new Error(`${f} must not touch fs/child_process`);
}
console.log("[ok] client chain portable (no node:/fs/child_process imports)");

// ── wasm fetch 导出冒烟 ──
{
  const bytes = readFileSync(WASM);
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    env: { host_emit_bytes() {}, host_log() {}, host_get_object: () => -1, host_put_object: () => -1 },
  });
  const w = inst.exports;
  for (const e of ["wasm_build_lsrefs", "wasm_build_fetch", "wasm_decode_pack_header", "wasm_inflate_one", "wasm_delta_apply"]) {
    if (typeof w[e] !== "function") throw new Error(`missing export ${e}`);
  }
  console.log("[ok] wasm fetch exports present");
}

const server = spawn("node", ["tests/server.mjs"], {
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

  // ── 1. 造远端内容 (客户端 push,零 CLI) ──
  const src = load(WASM, { store: memoryStore() });
  const bigA = "line A\n".repeat(400);
  const bigB = "line A\n".repeat(200) + "line B changed\n" + "line A\n".repeat(200);
  const c1 = src.commit("", "init", { "README.md": "hello fetch\n", "big.txt": bigA });
  const c2 = src.commit("main", "v2", { "big.txt": bigB, "src/app.js": "console.log(1)\n" });
  console.log("local:", c1.slice(0, 7), c2.slice(0, 7));
  const pr = await src.push(BASE, "refs/heads/main");
  if (!pr.updated) throw new Error("seed push failed");
  console.log("seed push ok:", pr.objects, "objects");

  // ── 2. 全量 fetch 到空 store, get() 读文件 ──
  const dst = load(WASM, { store: memoryStore() });
  const fr = await dst.fetch(BASE, "main");
  console.log("fetch:", JSON.stringify({ ...fr, oid: fr.oid.slice(0, 7), refs: fr.refs.map((r) => r.name) }));
  if (fr.objects < 5) throw new Error(`fetch objects suspect: ${fr.objects}`);
  const got = dst.get("main", ["README.md", "big.txt", "src/app.js"]);
  const byPath = Object.fromEntries(got.map((g) => [g.path, g]));
  if (byPath["README.md"].content?.toString() !== "hello fetch\n") throw new Error("README mismatch after fetch");
  if (byPath["big.txt"].content?.toString() !== bigB) throw new Error("big.txt mismatch after fetch");
  if (byPath["src/app.js"].content?.toString() !== "console.log(1)\n") throw new Error("app.js mismatch");
  console.log("[ok] full fetch + get() blob read");

  // history readable without protocol
  const hist = dst.log("main", 5);
  if (hist.length !== 2 || hist[0].sha !== c2) throw new Error("log mismatch after fetch");
  console.log("[ok] log() after fetch:", hist.map((h) => h.sha.slice(0, 7)).join(" <- "));

  // lsRemote
  const refs = await dst.lsRemote(BASE);
  if (!refs.some((r) => r.name === "refs/heads/main" && r.oid === c2)) throw new Error("lsRemote mismatch");
  console.log("[ok] lsRemote:", refs.map((r) => `${r.oid.slice(0, 7)} ${r.name}`).join(", "));

  // cached refetch (no network objects)
  const fr2 = await dst.fetch(BASE, "main");
  if (!fr2.cached) throw new Error("second fetch should hit local cache");
  console.log("[ok] cached refetch");

  // ── 3. 服务端 gc 压 delta, 新客户端 fetch 必须展开 ──
  execFileSync("git", ["--git-dir", SERVER_REPO, "repack", "-a", "-d", "-f", "--window=50", "--depth=50"]);
  // find pack + grep for ofs-delta/ref-delta
  const { readdirSync } = await import("node:fs");
  const packDir = join(SERVER_REPO, "objects/pack");
  const packs = readdirSync(packDir).filter((f) => f.endsWith(".pack"));
  if (!packs.length) throw new Error("no pack after repack");
  const vpack = execFileSync("git", ["verify-pack", "-v", join(packDir, packs[0])]).toString();
  const hasDelta = /ofs-delta|ref-delta/.test(vpack);
  console.log(hasDelta ? "[info] server pack contains deltas" : "[info] server pack has no deltas (small repo?)");
  console.log("  " + vpack.trim().split("\n").slice(0, 5).join("\n  "));

  const dst2 = load(WASM, { store: memoryStore() });
  const fr3 = await dst2.fetch(BASE, "main");
  const got3 = dst2.get("main", ["big.txt", "README.md"]);
  const b3 = Object.fromEntries(got3.map((g) => [g.path, g]));
  if (b3["big.txt"].content?.toString() !== bigB) throw new Error("big.txt mismatch after delta fetch");
  if (b3["README.md"].content?.toString() !== "hello fetch\n") throw new Error("README mismatch after delta fetch");
  // c1 的 big.txt (bigA) 在传输包里是 ofs-delta:内容必须精确还原,不止长度
  const oldB = dst2.get(c1, ["big.txt"])[0];
  if (oldB.content?.toString() !== bigA) throw new Error("delta-resolved blob content mismatch (bigA)");
  console.log(`[ok] fetch after gc (${fr3.objects} objects, pack ${fr3.packBytes}B, ofs-delta content exact)`);

  // ── 3b. ref-delta 真包:git 强制 ref-delta 打包,走 unpackPack + resolveRefDeltas ──
  {
    const revList = execFileSync("git", ["--git-dir", SERVER_REPO, "rev-list", "--objects", "--all"]).toString();
    const rdPack = execFileSync("git", ["--git-dir", SERVER_REPO, "pack-objects", "--stdout", "--no-reuse-delta", "--no-delta-base-offset"],
      { input: revList, maxBuffer: 64 * 1024 * 1024 });
    const { readdirSync: rs2 } = await import("node:fs");
    const tmpd = join(ROOT, "tmp/test_fetch_refdelta");
    rmSync(tmpd, { recursive: true, force: true });
    const { mkdirSync: mk } = await import("node:fs");
    mk(tmpd, { recursive: true });
    execFileSync("git", ["init", "-q", join(tmpd, "repo")]);
    execFileSync("git", ["-C", join(tmpd, "repo"), "index-pack", "--stdin"], { input: rdPack });
    const packFile = join(tmpd, "repo", ".git/objects/pack", rs2(join(tmpd, "repo", ".git/objects/pack")).find((f) => f.endsWith(".pack")));
    const vv = execFileSync("git", ["verify-pack", "-v", packFile]).toString();
    console.log("  " + vv.trim().split("\n").slice(0, 6).join("\n  "));
    const { bootWasm } = await import("../src/host/utils.mjs");
    const { unpackPack, resolveRefDeltas } = await import("../src/host/sync.mjs");
    const { wasm: w2 } = bootWasm(readFileSync(WASM));
    const { createHash } = await import("node:crypto");
    const sha1hex = (type, body) => createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest("hex");
    const { objects, pending } = unpackPack(w2, new Uint8Array(rdPack));
    console.log(`[info] ref-delta pack: ${objects.length} direct + ${pending.length} pending`);
    const known = new Map();
    for (const o of objects) known.set(sha1hex(o.type, Buffer.from(o.body)), o);
    const extra = resolveRefDeltas(w2, pending, known);
    for (const o of extra) known.set(sha1hex(o.type, Buffer.from(o.body)), o);
    if (pending.length) throw new Error(`ref-delta leftovers: ${pending.length}`);
    // 全量比对真 git
    for (const [hex, o] of known) {
      const want = execFileSync("git", ["-C", join(tmpd, "repo"), "cat-file", o.type, hex]);
      if (!want.equals(Buffer.from(o.body))) throw new Error(`ref-delta body mismatch for ${hex.slice(0, 7)}`);
    }
    console.log(`[ok] ref-delta pack fully resolved + byte-compared (${known.size} objects)`);
    rmSync(tmpd, { recursive: true, force: true });
  }

  // ── 4. 真 git 交叉验证远端 ──
  execFileSync("git", ["--git-dir", SERVER_REPO, "fsck", "--strict"]);
  const cat = execFileSync("git", ["--git-dir", SERVER_REPO, "cat-file", "-p", `${c2}:big.txt`]).toString();
  if (cat !== bigB) throw new Error("server blob mismatch");
  console.log("[ok] server fsck + cat-file clean");

  // ── 5. blob:none partial fetch ──
  const dst3 = load(WASM, { store: memoryStore() });
  const fr4 = await dst3.fetch(BASE, "main", { filter: "blob:none" });
  console.log("partial fetch:", JSON.stringify({ ...fr4, oid: fr4.oid.slice(0, 7) }));
  const got4 = dst3.get("main", ["README.md"]);
  if (!got4[0].error) throw new Error("blob:none fetch should omit blobs (expected NotFound)");
  console.log(`[ok] blob:none omits blobs (got error=${got4[0].error}, ${fr4.objects} objects)`);
  // commit/tree present
  const hist4 = dst3.log("main", 5);
  if (hist4.length !== 2) throw new Error("partial fetch should keep commits");

  // ── 6. portable 入口冒烟 (可移植 loadFromBytes:同 wasm 字节,同协议,无 node: 依赖) ──
  {
    const { loadFromBytes, memoryStore: memStore } = await import("../src/host/portable.mjs");
    const bro = loadFromBytes(readFileSync(WASM), { store: memStore() });
    const bfr = await bro.fetch(BASE, "main");
    const bgot = bro.get("main", ["README.md", "src/app.js"]);
    if (bgot[0].content == null || new TextDecoder().decode(bgot[0].content) !== "hello fetch\n") {
      throw new Error("portable entry get() mismatch");
    }
    if (new TextDecoder().decode(bgot[1].content) !== "console.log(1)\n") throw new Error("browser entry app.js mismatch");
    const bc = bro.commit("main", "from browser", { "browser.txt": "hi worker\n" }, "refs/heads/browser-entry");
    if (!/^[0-9a-f]{40}$/.test(bc)) throw new Error("portable commit failed");
    const bpr = await bro.push(BASE, "refs/heads/browser-entry");
    if (!bpr.updated) throw new Error("portable push failed");
    const check = execFileSync("git", ["--git-dir", SERVER_REPO, "cat-file", "-p", `${bpr.new}:browser.txt`]).toString();
    if (check !== "hi worker\n") throw new Error("portable push content mismatch");
    console.log(`[ok] portable entry fetch/get/commit/push (${bfr.objects} objs, push ${bpr.objects} objs)`);
  }

  console.log("ALL FETCH TESTS PASSED");
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(SERVER_REPO, { recursive: true, force: true });
}
