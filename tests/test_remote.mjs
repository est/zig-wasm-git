// tests/test_remote.mjs — RemoteGit facade e2e (url-bound versioned blob store).
// Covers: open/getMany/putMany/version/list/log/author defaults/CAS,
// auto on-demand blob fetch, remoteVersion, batched readMany, push/sync.
import { spawn, execFileSync } from "node:child_process";
import { rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = join(ROOT, "zig-out/bin/zig_wasm_git.wasm");
const PORT = 32141;
const BASE = `http://localhost:${PORT}/remotetest.git`;
const SERVER_REPO = join(ROOT, "data/remotetest.git");
rmSync(SERVER_REPO, { recursive: true, force: true });

// Portable assertion: no static/dynamic node: imports in the portable chain
// (the single allowed hole is the runtime process.getBuiltinModule probe).
for (const f of ["utils.mjs", "sync.mjs", "portable.mjs"]) {
  const src = readFileSync(join(ROOT, "src/host", f), "utf8");
  if (/from\s+["']node:/.test(src) || /require\s*\(/.test(src) || /\bimport\s*\(\s*["']node:/.test(src)) {
    throw new Error(`${f} must stay portable (no node: imports)`);
  }
}
const { RemoteGit } = await import("../src/host/portable.mjs");
if (typeof RemoteGit?.open !== "function") throw new Error("portable.mjs must export RemoteGit with static open()");

const enc = new TextEncoder();
const dec = new TextDecoder();
const text = (m, k) => { const b = m.get(k); return b == null ? null : dec.decode(b); };

// ── 1. local lifecycle (no network) ──
{
  const git = await RemoteGit.open("https://example.invalid/r.git", { wasm: WASM, ref: "main" });
  if ((await git.version()) !== null) throw new Error("empty version should be null");
  if ((await git.getMany(["a.txt"])).size !== 0) throw new Error("empty getMany should be empty (no network touched)");
  const v1 = await git.putMany({ "a.txt": "hello", "d/b.bin": new Uint8Array([1, 2, 3]) }, "init");
  if (!/^[0-9a-f]{40}$/.test(v1)) throw new Error("putMany should return sha");
  if ((await git.version()) !== v1) throw new Error("version should track tip");
  if (text(await git.getMany(["a.txt"]), "a.txt") !== "hello") throw new Error("getMany mismatch");
  const many = await git.getMany(["a.txt", "d/b.bin", "missing.txt"]);
  if (many.size !== 2) throw new Error("getMany should skip missing keys");
  const v2 = await git.putMany({ "a.txt": "hello v2" }, "bump");
  if (v2 === v1 || text(await git.getMany(["a.txt"]), "a.txt") !== "hello v2") throw new Error("overwrite should move tip");
  // untouched keys survive; binary roundtrips
  if (text(await git.getMany(["d/b.bin"]), "d/b.bin") == null) throw new Error("untouched key must survive putMany");
  const hist = await git.log(5);
  if (hist.length !== 2 || hist[0].sha !== v2) throw new Error("log should walk newest-first");
  console.log("[ok] local lifecycle (putMany/getMany/version/log, zero network)");
}

// ── 1b. wasm inputs (path string / Module / default) + auth header ──
{
  const gp = await RemoteGit.open("https://example.invalid/r.git", { wasm: WASM });
  await gp.putMany({ "p.txt": "via-path" }, "p");
  if (dec.decode((await gp.getMany(["p.txt"])).get("p.txt")) !== "via-path") {
    throw new Error("path-string wasm input failed");
  }
  const gm = await RemoteGit.open("https://example.invalid/r.git", {
    wasm: new WebAssembly.Module(readFileSync(WASM)), ref: "main",
  });
  await gm.putMany({ "m.txt": "via-module" }, "m");
  if (dec.decode((await gm.getMany(["m.txt"])).get("m.txt")) !== "via-module") {
    throw new Error("precompiled Module input failed");
  }
  const gt = await RemoteGit.open("https://example.invalid/r.git", { wasm: readFileSync(WASM) });
  await gt.putMany({ "t.txt": "via-bytes" }, "t");
  if (dec.decode((await gt.getMany(["t.txt"])).get("t.txt")) !== "via-bytes") {
    throw new Error("typed-array wasm input failed");
  }
  // default (omitted): co-located zig_wasm_git.wasm next to portable.mjs —
  // absent in this checkout, so open must fail mentioning the file.
  let threw = false;
  try {
    await RemoteGit.open("https://example.invalid/r.git", {});
  } catch (e) {
    threw = /zig_wasm_git\.wasm/.test(e.message);
  }
  if (!threw) throw new Error("omitted wasm should fail on the co-located file");
  console.log("[ok] wasm inputs (path string, Module, bytes, co-located default)");

  const { withBasicAuth } = await import("../src/host/utils.mjs");
  const seen = [];
  const stub = async (url, init) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return { ok: false, status: 401 };
  };
  // URL userinfo -> Basic + stripped (workerd drops userinfo, so we send a header)
  await withBasicAuth(stub)("https://oauth2:abc123@git.example.com/r.git/info/refs?service=git-upload-pack");
  if (seen[0].auth !== `Basic ${Buffer.from("oauth2:abc123").toString("base64")}`) throw new Error("userinfo auth mismatch");
  if (seen[0].url.includes("abc123")) throw new Error("credentials not stripped");
  // explicit auth option wins the same way
  const ga = await RemoteGit.open("https://example.invalid/r.git", { wasm: WASM, fetchImpl: stub, auth: "alice:s3cret" });
  await ga.remoteVersion().catch(() => {});
  const last = seen[seen.length - 1];
  if (last.auth !== `Basic ${Buffer.from("alice:s3cret").toString("base64")}`) throw new Error("auth option mismatch: " + last.auth);
  console.log("[ok] auth (userinfo + explicit option)");
}

// ── 2. author/time plumbing: ctor defaults + per-call override ──
{
  const T0 = 1755859200;
  const git = await RemoteGit.open("https://example.invalid/r.git", {
    wasm: WASM, author: "Default <d@x>", timezone: "+0800",
  });
  await git.putMany({ "f.txt": "v1" }, "one", { time: T0 });
  const e1 = (await git.log(1))[0];
  if (e1.author !== "Default <d@x> 1755859200 +0800") throw new Error("ctor defaults not applied: " + e1.author);
  const c2 = await git.putMany({ "f.txt": "v2" }, "two", { author: "Override <o@x>", time: T0 });
  const e2 = (await git.log(1))[0];
  if (e2.sha !== c2 || e2.author !== "Override <o@x> 1755859200 +0800") {
    throw new Error("per-call options should win: " + e2.author);
  }
  console.log("[ok] author/committer/timezone defaults + override");
}

// ── 2b. list() + CAS parent (local) ──
{
  const git = await RemoteGit.open("https://example.invalid/r.git", { wasm: WASM, ref: "main" });
  if ((await git.list()).length !== 0) throw new Error("empty list should be []");
  await git.putMany({ "a.txt": "1", "docs/b.txt": "2", "docs/c.txt": "3" }, "init");
  const paths = (await git.list()).map((e) => e.path).sort();
  if (JSON.stringify(paths) !== JSON.stringify(["a.txt", "docs/b.txt", "docs/c.txt"])) {
    throw new Error("list mismatch: " + JSON.stringify(paths));
  }
  const keys = await git.list();
  if (!keys.every((e) => /^[0-9a-f]{40}$/.test(e.oid))) throw new Error("list entries need oids");
  const sub = await git.list("docs/");
  if (sub.length !== 2 || !sub.every((e) => e.path.startsWith("docs/"))) throw new Error("prefix filter broken");
  // CAS: stale parent throws locally, exact tip succeeds
  const tip = await git.version();
  const c2 = await git.putMany({ "a.txt": "2" }, "cas-ok", { parent: tip });
  if ((await git.version()) !== c2) throw new Error("CAS putMany should move tip");
  let threw = false;
  try {
    await git.putMany({ "a.txt": "3" }, "cas-stale", { parent: tip });
  } catch (e) {
    threw = /CAS mismatch/.test(e.message);
  }
  if (!threw) throw new Error("stale parent must throw CAS mismatch");
  console.log("[ok] list (+prefix) and CAS parent");
}

// ── 3. network: auto on-demand fetch without prior pull() ──
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

  const seed = await RemoteGit.open(BASE, { wasm: WASM, ref: "main" });
  await seed.putMany({ "config.json": JSON.stringify({ v: 7 }) }, "seed");
  await seed.putMany({ "big.bin": new Uint8Array(4096).fill(9) }, "seed big");
  const pub = await seed.push();
  if (!pub.updated) throw new Error("seed push failed");

  // fresh client, NO pull() call: first read bootstraps structure + blob itself
  const git = await RemoteGit.open(BASE, { wasm: WASM, ref: "main" });
  if (text(await git.getMany(["config.json"]), "config.json") !== JSON.stringify({ v: 7 })) {
    throw new Error("auto-fetch read mismatch");
  }
  if ((await git.getMany(["nope.txt"])).size !== 0) throw new Error("unknown path must be skipped");
  const again = text(await git.getMany(["config.json"]), "config.json");
  if (again !== JSON.stringify({ v: 7 })) throw new Error("cached second read failed");
  // branch ref must still point at the commit, not the blob
  const tip = await git.version();
  const { looseBody } = await import("../src/host/utils.mjs");
  const tipType = (await looseBody(git._store.get(tip))).type;
  if (tipType !== "commit") throw new Error(`ref clobbered by blob fetch (points at ${tipType})`);
  console.log("[ok] auto on-demand fetch (no warmup, skip unknown, ref intact)");

  // remoteVersion(): no store writes, matches pushed tip
  const rv = await git.remoteVersion();
  if (rv !== tip) throw new Error("remoteVersion should equal pushed tip");
  const freshNoNet = await RemoteGit.open(BASE, { wasm: WASM, ref: "main" });
  if ((await freshNoNet.version()) !== null) throw new Error("fresh client has no local tip");
  if ((await freshNoNet.remoteVersion()) !== tip) throw new Error("remoteVersion works without local state");
  console.log("[ok] remoteVersion (store untouched, no local state needed)");

  // batched getMany: 2 missing blobs + 1 unknown, exactly 1 want-POST after structure pull
  let wantPosts = 0;
  const counting = async (u, init) => {
    if (typeof u === "string" && u.includes("/git-upload-pack") && init?.method === "POST" && init?.body) {
      if (Buffer.from(init.body).toString("latin1").includes("want ")) wantPosts++;
    }
    return fetch(u, init);
  };
  const batched = await RemoteGit.open(BASE, { wasm: WASM, ref: "main", fetchImpl: counting });
  await batched.pull({ filter: "blob:none" }); // structure only; blobs all missing
  wantPosts = 0;
  const got = await batched.getMany(["config.json", "big.bin", "nope.txt"]);
  if (got.size !== 2) throw new Error("batched getMany should return 2 known keys");
  if (dec.decode(got.get("config.json")) !== JSON.stringify({ v: 7 })) throw new Error("batched content mismatch");
  if (wantPosts !== 1) throw new Error(`expected 1 batched want-POST, saw ${wantPosts}`);
  const keys = (await batched.list()).map((e) => e.path).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["big.bin", "config.json"])) {
    throw new Error("list mismatch: " + JSON.stringify(keys));
  }
  console.log("[ok] batched getMany (1 roundtrip) + list over network");

  // put + push from this client, sync from another
  await git.putMany({ "config.json": JSON.stringify({ v: 8 }) }, "bump");
  await git.push();
  const other = await RemoteGit.open(BASE, { wasm: WASM, ref: "main" });
  const synced = await other.sync(["config.json"]);
  if (dec.decode(synced.get("config.json")) !== JSON.stringify({ v: 8 })) {
    throw new Error("sync should return latest");
  }
  // non-fast-forward push rejects
  let rejected = false;
  try {
    await batched.push();
  } catch (e) {
    rejected = /rejected|non-fast|failed/i.test(e.message);
  }
  if (!rejected) throw new Error("stale push should reject");
  console.log("[ok] put/push/sync across clients + non-fast-forward reject");

  execFileSync("git", ["--git-dir", SERVER_REPO, "fsck", "--strict"]);
  console.log("[ok] server fsck clean");
  console.log("ALL REMOTE TESTS PASSED");
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(SERVER_REPO, { recursive: true, force: true });
}
