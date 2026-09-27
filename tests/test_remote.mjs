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
const { RemoteGit, memoryStore } = await import("../src/host/portable.mjs");
if (typeof RemoteGit?.open !== "function") throw new Error("portable.mjs must export RemoteGit with static open()");

const enc = new TextEncoder();
const dec = new TextDecoder();
const text = (m, k) => { const b = m.get(k); return b == null ? null : dec.decode(b); };

// ── 1. local lifecycle (no network) ──
{
  const git = await RemoteGit.open("https://example.invalid/r.git", { wasm: WASM, ref: "main" });
  if ((await git.version()) !== null) throw new Error("empty version should be null");
  // { local: true } = cache-only: no bootstrap, no I/O, so an unreachable
  // host is irrelevant here. (Default getMany would legitimately throw NETWORK.)
  if ((await git.getMany(["a.txt"], { local: true })).size !== 0) {
    throw new Error("empty getMany should be empty (no network touched)");
  }
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
  // every public method shares one ordering: a log queued behind a write sees it
  await Promise.all([git.putMany({ "c.txt": "3" }, "m3"), git.log(1)]);
  if ((await git.log(1))[0].sha !== (await git.version())) throw new Error("log should serialize with writes");
  if ((await git.log(0)).length !== 0) throw new Error("log(0) should be empty");
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
  // A runtime with no filesystem cannot load a path or the co-located default.
  // That must be BAD_ARG, not NETWORK: "your connection is down" invites a
  // retry that can never succeed (Node < 22.3 has no process.getBuiltinModule).
  const noFs = process.getBuiltinModule;
  delete process.getBuiltinModule;
  for (const [label, opts] of [["path", { wasm: WASM }], ["default", {}]]) {
    let code = null, msg = "";
    try {
      await RemoteGit.open("https://example.invalid/r.git", opts);
    } catch (e) { code = e.code; msg = e.message; }
    if (code !== "BAD_ARG") throw new Error(`no-fs ${label} should be BAD_ARG, got ${code}: ${msg}`);
    if (/network/i.test(msg)) throw new Error(`no-fs ${label} message implies a network fault: ${msg}`);
  }
  process.getBuiltinModule = noFs;
  console.log("[ok] wasm inputs (path string, Module, bytes, co-located default, no-fs BAD_ARG)");

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
  // local-only variant: this block is offline throughout, so cache-only reads.
  const LC = { local: true };
  if ((await git.list("", LC)).length !== 0) throw new Error("empty list should be []");
  await git.putMany({ "a.txt": "1", "docs/b.txt": "2", "docs/c.txt": "3" }, "init");
  const paths = (await git.list("", LC)).map((e) => e.path).sort();
  if (JSON.stringify(paths) !== JSON.stringify(["a.txt", "docs/b.txt", "docs/c.txt"])) {
    throw new Error("list mismatch: " + JSON.stringify(paths));
  }
  const keys = await git.list("", LC);
  if (!keys.every((e) => /^[0-9a-f]{40}$/.test(e.oid))) throw new Error("list entries need oids");
  const sub = await git.list("docs/", LC);
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

// ── 2c. fail loudly instead of silently (store contract / network / keys) ──
{
  // 1. store interface is synchronous — a Promise-returning store must be
  //    rejected at open(), not silently write commits it cannot read back.
  const inner = memoryStore();
  const asyncStore = {
    async get(h) { return inner.get(h); },
    async put(h, b) { return inner.put(h, b); },
    async getRef(n) { return inner.getRef(n); },
    async putRef(n, s) { return inner.putRef(n, s); },
    async heads() { return inner.heads(); },
  };
  let se;
  try {
    await RemoteGit.open("https://example.invalid/r.git", { wasm: WASM, store: asyncStore });
  } catch (e) {
    se = e;
  }
  if (se?.code !== "BAD_STORE") throw new Error("async store must be rejected, got: " + se?.code);
  let me;
  try {
    await RemoteGit.open("https://example.invalid/r.git", { wasm: WASM, store: { get() {} } });
  } catch (e) {
    me = e;
  }
  if (me?.code !== "BAD_STORE" || !/putRef/.test(me.message)) {
    throw new Error("incomplete store must name the missing methods");
  }

  // 2. an unreachable remote must throw, never report "no such key" as empty
  const dead = await RemoteGit.open("https://nonexistent.invalid/r.git", { wasm: WASM });
  for (const [name, fn] of [["getMany", () => dead.getMany(["a"])], ["list", () => dead.list()]]) {
    let ne;
    try {
      await fn();
    } catch (e) {
      ne = e;
    }
    if (ne?.code !== "NETWORK") throw new Error(`${name} on a dead remote must throw NETWORK, got ${ne?.code ?? "(no throw)"}`);
    if (ne.cause == null) throw new Error(`${name} should keep the original error in .cause`);
  }
  // ...while cache-only reads stay offline-safe and empty
  const cached = await RemoteGit.open("https://nonexistent.invalid/r.git", { wasm: WASM });
  await cached.putMany({ "k.txt": "v" }, "m");
  if (text(await cached.getMany(["k.txt"], { local: true }), "k.txt") !== "v") {
    throw new Error("getMany({local:true}) must read offline");
  }
  if ((await cached.list("", { local: true })).length !== 1) {
    throw new Error("list({local:true}) must work offline");
  }
  // an HTTP status is preserved on the error
  const denied = await RemoteGit.open("https://example.invalid/r.git", {
    wasm: WASM, fetchImpl: async () => ({ ok: false, status: 403 }),
  });
  let he;
  try {
    await denied.remoteVersion();
  } catch (e) {
    he = e;
  }
  if (he?.code !== "HTTP" || he.status !== 403) throw new Error("HTTP errors should carry .status");

  // 3. keys that cannot round-trip are rejected (and the batch writes nothing)
  const kv = await RemoteGit.open("https://example.invalid/r.git", { wasm: WASM });
  for (const k of ["", "/a.txt", "a//b.txt", "dir/", "..", ".", "a/../b", ".git/config", "a\\b"]) {
    let ke;
    try {
      await kv.putMany({ [k]: "v" }, "m");
    } catch (e) {
      ke = e;
    }
    if (ke?.code !== "BAD_KEY") throw new Error(`key ${JSON.stringify(k)} should be BAD_KEY, got ${ke?.code ?? "(accepted)"}`);
  }
  // every offender reported at once, and no partial commit
  let both;
  try {
    await kv.putMany({ "/a": "1", "": "2", "ok.txt": "3" }, "m");
  } catch (e) {
    both = e;
  }
  if (both?.code !== "BAD_KEY" || !both.message.includes('"/a"') || !both.message.includes('""')) {
    throw new Error("all bad keys should be reported together: " + both?.message);
  }
  if ((await kv.list("", { local: true })).length !== 0) {
    throw new Error("a rejected batch must not write anything");
  }
  // valid keys still round-trip
  await kv.putMany({ "a/b.txt": "1", ".github/w.yml": "2", "üñî.md": "3" }, "m");
  if ((await kv.getMany(["a/b.txt", ".github/w.yml", "üñî.md"], { local: true })).size !== 3) {
    throw new Error("valid keys must still round-trip");
  }
  console.log("[ok] fail loudly: BAD_STORE / NETWORK+HTTP / BAD_KEY");
}

// ── 2d. lifecycle: close(), unopened instances, argument shapes ──
{
  // close() releases the wasm instance and guards later calls
  const g = await RemoteGit.open("https://example.invalid/r.git", { wasm: WASM });
  await g.putMany({ "a.txt": "x".repeat(100_000) }, "m");
  if (g.closed) throw new Error("closed must start false");
  if (!(g._wasm.memory.buffer.byteLength > 4 * 1024 * 1024)) throw new Error("expected a multi-MB wasm arena");
  await g.close();
  if (!g.closed || g._wasm !== null) throw new Error("close() should release the wasm instance");
  for (const [name, fn] of [
    ["putMany", () => g.putMany({ "b": "1" }, "m")],
    ["getMany", () => g.getMany(["a.txt"], { local: true })],
    ["log", () => g.log()],
  ]) {
    let ce;
    try {
      await fn();
    } catch (e) {
      ce = e;
    }
    if (ce?.code !== "CLOSED") throw new Error(`${name} after close should throw CLOSED, got ${ce?.code ?? "(no throw)"}`);
  }
  await g.close(); // idempotent
  // the store survives; a fresh instance can reuse it
  const g2 = await RemoteGit.open("https://example.invalid/r.git", { wasm: WASM, store: g._store });
  if (text(await g2.getMany(["a.txt"], { local: true }), "a.txt")?.length !== 100_000) {
    throw new Error("reopening on the same store should still read");
  }
  await g2.close();
  // close() waits for in-flight work instead of pulling memory out from under it
  const g3 = await RemoteGit.open("https://example.invalid/r.git", { wasm: WASM });
  await Promise.all([g3.putMany({ "slow.txt": "y".repeat(50_000) }, "m"), g3.close()]);
  if (!g3.closed) throw new Error("close() should drain queued work");

  // an unopened instance explains itself instead of throwing a raw TypeError
  const unopened = new RemoteGit("https://example.invalid/r.git", { wasm: WASM });
  for (const [name, fn] of [
    ["putMany", () => unopened.putMany({ "a": "b" }, "m")],
    ["getMany", () => unopened.getMany(["a"])],
    ["list", () => unopened.list()],
    ["log", () => unopened.log()],
    ["version", () => unopened.version()],
  ]) {
    let ue;
    try {
      await fn();
    } catch (e) {
      ue = e;
    }
    if (ue?.code !== "CLOSED" || !/RemoteGit\.open/.test(ue.message)) {
      throw new Error(`${name} on an unopened instance should point at RemoteGit.open (${ue?.code}: ${ue?.message})`);
    }
  }

  // putMany takes an object (or a Map); content is a string or bytes
  const sh = await RemoteGit.open("https://example.invalid/r.git", { wasm: WASM });
  await sh.putMany({ "o.txt": "1", "a.txt": "2" }, "m");
  await sh.putMany(new Map([["m.txt", "3"]]), "m");
  const shapes = (await sh.list("", { local: true })).map((e) => e.path).sort();
  if (JSON.stringify(shapes) !== JSON.stringify(["a.txt", "m.txt", "o.txt"])) {
    throw new Error("entry shapes: " + JSON.stringify(shapes));
  }
  await sh.putMany({ "s.txt": "str", "u.txt": new Uint8Array([1, 2]) }, "m");
  if (text(await sh.getMany(["s.txt"], { local: true }), "s.txt") !== "str") throw new Error("string content");
  if ((await sh.getMany(["u.txt"], { local: true })).get("u.txt")?.length !== 2) throw new Error("Uint8Array content");
  // getMany takes a single key too, and can decode text
  if (!(await sh.getMany("o.txt", { local: true })).has("o.txt")) throw new Error("getMany should take one key");
  const asText = await sh.getMany(["s.txt"], { local: true, as: "text" });
  if (asText.get("s.txt") !== "str") throw new Error("as:'text'");
  if (!(await sh.getMany(["s.txt"], { local: true })).get("s.txt") instanceof Uint8Array) {
    throw new Error("default getMany should stay bytes");
  }
  // a non-string, non-bytes value is refused instead of stored as "[object Object]"
  for (const bad of [{ "z.txt": {} }, { "z.txt": 42 }, "nope", 42, [["a", "b"]]]) {
    let be;
    try {
      await sh.putMany(bad, "m");
    } catch (e) {
      be = e;
    }
    if (be?.code !== "BAD_ARG") throw new Error(`putMany(${JSON.stringify(bad)}) should be BAD_ARG, got ${be?.code ?? "(accepted)"}`);
  }
  await sh.close();
  console.log("[ok] lifecycle: close(), unopened guard, argument shapes");
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
  // it must be a branchable NON_FAST_FORWARD, not just matching message text
  let nff;
  try {
    await batched.push();
  } catch (e) {
    nff = e;
  }
  if (nff?.code !== "NON_FAST_FORWARD") throw new Error("stale push should carry NON_FAST_FORWARD, got: " + nff?.code);
  console.log("[ok] put/push/sync across clients + non-fast-forward reject");

  execFileSync("git", ["--git-dir", SERVER_REPO, "fsck", "--strict"]);
  console.log("[ok] server fsck clean");
  console.log("ALL REMOTE TESTS PASSED");
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(SERVER_REPO, { recursive: true, force: true });
}
