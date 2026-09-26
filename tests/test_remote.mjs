// tests/test_remote.mjs — RemoteGit facade e2e (url-bound versioned blob store).
// Covers: local write/read/version/author defaults, auto on-demand blob
// fetch (no prior fetch call), missing -> null with zero RTT, write+push,
// sync across clients; server-side fsck. Client stays portable.
import { spawn, execFileSync } from "node:child_process";
import { rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = readFileSync(join(ROOT, "zig-out/bin/zig_wasm_git.wasm"));
const PORT = 32141;
const BASE = `http://localhost:${PORT}/remotetest.git`;
const SERVER_REPO = join(ROOT, "data/remotetest.git");
rmSync(SERVER_REPO, { recursive: true, force: true });

// Portable assertion: RemoteGit lives in the portable chain.
for (const f of ["utils.mjs", "sync.mjs", "portable.mjs"]) {
  const src = readFileSync(join(ROOT, "src/host", f), "utf8");
  if (/from\s+["']node:/.test(src) || /require\s*\(/.test(src)) throw new Error(`${f} must stay portable (no node: imports)`);
}
const { RemoteGit } = await import("../src/host/portable.mjs");
if (typeof RemoteGit !== "function") throw new Error("portable.mjs must export RemoteGit");

// ── 1. local lifecycle (no network) ──
{
  const git = new RemoteGit("https://example.invalid/r.git", { wasm: WASM, ref: "main" });
  if (git.version() !== null) throw new Error("empty version should be null");
  if ((await git.read("a.txt")) !== null) throw new Error("empty read should be null (no network touched)");
  const v1 = git.write({ "a.txt": "hello", "d/b.bin": new Uint8Array([1, 2, 3]) }, "init");
  if (!/^[0-9a-f]{40}$/.test(v1)) throw new Error("write should return sha");
  if (git.version() !== v1) throw new Error("version should track tip");
  if ((await git.readText("a.txt")) !== "hello") throw new Error("readText mismatch");
  const many = await git.readMany(["a.txt", "d/b.bin", "missing.txt"]);
  if (many.size !== 2) throw new Error("readMany should skip missing keys");
  const v2 = git.writeText("a.txt", "hello v2", "bump");
  if (v2 === v1 || (await git.readText("a.txt")) !== "hello v2") throw new Error("overwrite should move tip");
  console.log("[ok] local lifecycle (write/read/version/overwrite, zero network)");
}

// ── 2. author/time plumbing: ctor defaults + per-call override ──
{
  const T0 = 1755859200;
  const git = new RemoteGit("https://example.invalid/r.git", {
    wasm: WASM, author: "Default <d@x>", timezone: "+0800",
  });
  const c1 = git.write({ "f.txt": "v1" }, "one", { time: T0 });
  const e1 = (await git._repo_().log(git.ref, 1))[0];
  if (e1.author !== "Default <d@x> 1755859200 +0800") throw new Error("ctor defaults not applied: " + e1.author);
  const c2 = git.write({ "f.txt": "v2" }, "two", { author: "Override <o@x>", time: T0 });
  const e2 = (await git._repo_().log(git.ref, 1))[0];
  if (e2.sha !== c2 || e2.author !== "Override <o@x> 1755859200 +0800") {
    throw new Error("per-call options should win: " + e2.author);
  }
  if (c1 === c2) throw new Error("shas must differ");
  console.log("[ok] author/committer/timezone defaults + override");
}

// ── 3. network: auto on-demand fetch without prior fetch() ──
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

  const seed = new RemoteGit(BASE, { wasm: WASM, ref: "main" });
  seed.writeText("config.json", JSON.stringify({ v: 7 }), "seed");
  seed.write({ "big.bin": new Uint8Array(4096).fill(9) }, "seed big");
  const pub = await seed.push();
  if (!pub.updated) throw new Error("seed push failed");

  // fresh client, NO fetch() call: first read bootstraps structure + blob itself
  const git = new RemoteGit(BASE, { wasm: WASM, ref: "main" });
  const text = await git.readText("config.json");
  if (text !== JSON.stringify({ v: 7 })) throw new Error("auto-fetch read mismatch");
  if ((await git.read("nope.txt")) !== null) throw new Error("unknown path must be null");
  const again = await git.read("config.json");
  if (again == null || new TextDecoder().decode(again) !== JSON.stringify({ v: 7 })) {
    throw new Error("cached second read failed");
  }
  // branch ref must still point at the commit, not the blob
  const tip = git.version();
  const tipType = await (async () => {
    const { looseBody } = await import("../src/host/utils.mjs");
    return (await looseBody(git._store.get(tip))).type;
  })();
  if (tipType !== "commit") throw new Error(`ref clobbered by blob fetch (points at ${tipType})`);
  console.log("[ok] auto on-demand fetch (no warmup, null for unknown, ref intact)");

  // write + push from this client, sync from another
  await git.writeText("config.json", JSON.stringify({ v: 8 }), "bump");
  await git.push();
  const other = new RemoteGit(BASE, { wasm: WASM, ref: "main" });
  const synced = await other.sync(["config.json"]);
  if (new TextDecoder().decode(synced.get("config.json")) !== JSON.stringify({ v: 8 })) {
    throw new Error("sync should return latest");
  }
  console.log("[ok] write/push/sync across clients");

  execFileSync("git", ["--git-dir", SERVER_REPO, "fsck", "--strict"]);
  console.log("[ok] server fsck clean");
  console.log("ALL REMOTE TESTS PASSED");
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(SERVER_REPO, { recursive: true, force: true });
}
