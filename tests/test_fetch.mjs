// tests/test_fetch.mjs — pull client e2e (worker-like, zero CLI on client).
// Covers: full pull -> getMany; delta fetch after server gc (exact bytes,
// incl. old-version blob); ref-delta pack resolution; blob:none partial;
// cached re-pull; server fsck.
import { spawn, execFileSync } from "node:child_process";
import { rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteGit, memoryStore } from "../src/host/portable.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = readFileSync(join(ROOT, "zig-out/bin/zig_wasm_git.wasm"));
const PORT = 32127;
const BASE = `http://localhost:${PORT}/fetchtest.git`;
const SERVER_REPO = join(ROOT, "data/fetchtest.git");
rmSync(SERVER_REPO, { recursive: true, force: true });

// ── 0. portability assertion: client chain stays worker-safe ──
// ── 0. portability assertion: no static/dynamic node: imports in client chain ──
// (the single allowed hole is the runtime process.getBuiltinModule probe for
// wasm path strings — a string lookup, invisible to bundlers).
for (const f of ["utils.mjs", "sync.mjs", "portable.mjs"]) {
  const src = readFileSync(join(ROOT, "src/host", f), "utf8");
  if (/from\s+["']node:/.test(src) || /require\s*\(/.test(src) || /\bimport\s*\(\s*["']node:/.test(src)) {
    throw new Error(`${f} must stay portable (no node: imports)`);
  }
  if (/child_process|execFile/.test(src)) throw new Error(`${f} must not touch child_process`);
}
console.log("[ok] client chain portable (no node: imports; only getBuiltinModule probe)");

const dec = new TextDecoder();
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

  // ── 1. seed remote (client push, zero CLI) ──
  const src = await RemoteGit.open(BASE, { wasm: WASM, ref: "main" });
  const bigA = "line A\n".repeat(400);
  const bigB = "line A\n".repeat(200) + "line B changed\n" + "line A\n".repeat(200);
  const c1 = await src.putMany({ "README.md": "hello fetch\n", "big.txt": bigA }, "init");
  const c2 = await src.putMany({ "big.txt": bigB, "src/app.js": "console.log(1)\n" }, "v2");
  console.log("local:", c1.slice(0, 7), c2.slice(0, 7));
  const pr = await src.push();
  if (!pr.updated) throw new Error("seed push failed");
  console.log("seed push ok:", pr.objects, "objects");

  // ── 2. full pull into empty store, getMany reads blobs ──
  const dst = await RemoteGit.open(BASE, { wasm: WASM, ref: "main", store: memoryStore() });
  const fr = await dst.pull();
  console.log("pull:", JSON.stringify({ ...fr, oid: fr.oid.slice(0, 7), ref: fr.ref }));
  if (fr.objects < 5) throw new Error(`pull objects suspect: ${fr.objects}`);
  const got = await dst.getMany(["README.md", "big.txt", "src/app.js"]);
  if (dec.decode(got.get("README.md")) !== "hello fetch\n") throw new Error("README mismatch after pull");
  if (dec.decode(got.get("big.txt")) !== bigB) throw new Error("big.txt mismatch after pull");
  if (dec.decode(got.get("src/app.js")) !== "console.log(1)\n") throw new Error("app.js mismatch");
  console.log("[ok] full pull + getMany blob read");

  // history readable without protocol
  const hist = await dst.log(5);
  if (hist.length !== 2 || hist[0].sha !== c2) throw new Error("log mismatch after pull");
  console.log("[ok] log() after pull:", hist.map((h) => h.sha.slice(0, 7)).join(" <- "));

  // remoteVersion
  const rv = await dst.remoteVersion();
  if (rv !== c2) throw new Error("remoteVersion mismatch");
  console.log("[ok] remoteVersion:", rv.slice(0, 7));

  // cached re-pull (no network objects)
  const fr2 = await dst.pull();
  if (!fr2.cached) throw new Error("second pull should hit local cache");
  console.log("[ok] cached re-pull");

  // ── 3. server gc squeezes deltas; fresh client must expand them ──
  execFileSync("git", ["--git-dir", SERVER_REPO, "repack", "-a", "-d", "-f", "--window=50", "--depth=50"]);
  const { readdirSync } = await import("node:fs");
  const packDir = join(SERVER_REPO, "objects/pack");
  const packs = readdirSync(packDir).filter((f) => f.endsWith(".pack"));
  if (!packs.length) throw new Error("no pack after repack");
  const vpack = execFileSync("git", ["verify-pack", "-v", join(packDir, packs[0])]).toString();
  const hasDelta = /ofs-delta|ref-delta/.test(vpack);
  console.log(hasDelta ? "[info] server pack contains deltas" : "[info] server pack has no deltas (small repo?)");

  const dst2 = await RemoteGit.open(BASE, { wasm: WASM, ref: "main", store: memoryStore() });
  const fr3 = await dst2.pull();
  const got3 = await dst2.getMany(["big.txt", "README.md"]);
  if (dec.decode(got3.get("big.txt")) !== bigB) throw new Error("big.txt mismatch after delta pull");
  if (dec.decode(got3.get("README.md")) !== "hello fetch\n") throw new Error("README mismatch after delta pull");
  // c1's big.txt (bigA) travels as ofs-delta: must restore exact bytes.
  // (by-sha read is test-only; the public API is ref-bound.)
  const oldRow = dst2._getInner(c1, ["big.txt"])[0];
  if (oldRow.error || dec.decode(oldRow.content) !== bigA) throw new Error("delta-resolved blob content mismatch (bigA)");
  console.log(`[ok] pull after gc (${fr3.objects} objects, pack ${fr3.packBytes}B, ofs-delta content exact)`);

  // ── 3b. ref-delta pack: forced ref-delta pack fully resolves + byte-matches git ──
  {
    const revList = execFileSync("git", ["--git-dir", SERVER_REPO, "rev-list", "--objects", "--all"]).toString();
    const rdPack = execFileSync("git", ["--git-dir", SERVER_REPO, "pack-objects", "--stdout", "--no-reuse-delta", "--no-delta-base-offset"],
      { input: revList, maxBuffer: 64 * 1024 * 1024 });
    const { readdirSync: rs2, mkdirSync: mk } = await import("node:fs");
    const tmpd = join(ROOT, "tmp/test_fetch_refdelta");
    rmSync(tmpd, { recursive: true, force: true });
    mk(tmpd, { recursive: true });
    execFileSync("git", ["init", "-q", join(tmpd, "repo")]);
    execFileSync("git", ["-C", join(tmpd, "repo"), "index-pack", "--stdin"], { input: rdPack });
    const packFile = join(tmpd, "repo", ".git/objects/pack", rs2(join(tmpd, "repo", ".git/objects/pack")).find((f) => f.endsWith(".pack")));
    const { unpackPack, resolveRefDeltas } = await import("../src/host/sync.mjs");
    const stub = new WebAssembly.Instance(new WebAssembly.Module(WASM), {
      env: { host_emit_bytes() {}, host_log() {}, host_get_object: () => -1, host_put_object: () => -1 },
    });
    const w2 = stub.exports;
    const { createHash } = await import("node:crypto");
    const sha1hex = (type, body) => createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest("hex");
    const { objects, pending } = unpackPack(w2, new Uint8Array(rdPack));
    console.log(`[info] ref-delta pack: ${objects.length} direct + ${pending.length} pending`);
    const known = new Map();
    for (const o of objects) known.set(sha1hex(o.type, Buffer.from(o.body)), o);
    const extra = resolveRefDeltas(w2, pending, known);
    for (const o of extra) known.set(sha1hex(o.type, Buffer.from(o.body)), o);
    if (pending.length) throw new Error(`ref-delta leftovers: ${pending.length}`);
    for (const [hex, o] of known) {
      const want = execFileSync("git", ["-C", join(tmpd, "repo"), "cat-file", o.type, hex]);
      if (!want.equals(Buffer.from(o.body))) throw new Error(`ref-delta body mismatch for ${hex.slice(0, 7)}`);
    }
    console.log(`[ok] ref-delta pack fully resolved + byte-compared (${known.size} objects)`);
    rmSync(tmpd, { recursive: true, force: true });
  }

  // ── 4. real git cross-checks remote ──
  execFileSync("git", ["--git-dir", SERVER_REPO, "fsck", "--strict"]);
  const cat = execFileSync("git", ["--git-dir", SERVER_REPO, "cat-file", "-p", `${c2}:big.txt`]).toString();
  if (cat !== bigB) throw new Error("server blob mismatch");
  console.log("[ok] server fsck + cat-file clean");

  // ── 5. blob:none partial pull: versions without bytes, auto-filled on read ──
  const dst3 = await RemoteGit.open(BASE, { wasm: WASM, ref: "main", store: memoryStore() });
  const fr4 = await dst3.pull({ filter: "blob:none" });
  console.log("partial pull:", JSON.stringify({ ...fr4, oid: fr4.oid.slice(0, 7) }));
  if (fr4.objects >= fr.objects) throw new Error("blob:none pull should transfer fewer objects");
  const pkeys = await dst3.list();
  if (!pkeys.length) throw new Error("partial pull should keep structure (list)");
  const pm = await dst3.getMany(["README.md"]);
  if (dec.decode(pm.get("README.md")) !== "hello fetch\n") throw new Error("partial blob should auto-materialize on read");
  console.log(`[ok] blob:none structure-only + on-demand fill (${fr4.objects} objects)`);
  const hist4 = await dst3.log(5);
  if (hist4.length !== 2) throw new Error("partial pull should keep commits");

  // ── 6. write from this client, push, verify via git ──
  await dst3.putMany({ "browser.txt": "hi worker\n" }, "from client");
  const bpr = await dst3.push();
  if (!bpr.updated) throw new Error("push failed");
  const check = execFileSync("git", ["--git-dir", SERVER_REPO, "cat-file", "-p", `${bpr.new}:browser.txt`]).toString();
  if (check !== "hi worker\n") throw new Error("push content mismatch");
  console.log(`[ok] putMany/push (${bpr.objects} objs)`);

  console.log("ALL FETCH TESTS PASSED");
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(SERVER_REPO, { recursive: true, force: true });
}
