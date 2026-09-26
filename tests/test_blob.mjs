// tests/test_blob.mjs — blob-service facade e2e (portable entry, zero CLI).
// Covers: write/read/readText/readMany/version + pull/publish/sync over
// smart HTTP against server.mjs (test-only remote; client stays portable).
import { spawn, execFileSync } from "node:child_process";
import { rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = join(ROOT, "zig-out/bin/zig_wasm_git.wasm");
const PORT = 32139;
const BASE = `http://localhost:${PORT}/blobtest.git`;
const SERVER_REPO = join(ROOT, "data/blobtest.git");
rmSync(SERVER_REPO, { recursive: true, force: true });

// Portable assertion: blob facade must stay worker-safe like the rest.
for (const f of ["store.mjs", "wire.mjs", "fetch.mjs", "portable.mjs", "codec.mjs", "push.mjs", "blob.mjs"]) {
  const src = readFileSync(join(ROOT, "src/host", f), "utf8");
  if (/from\s+["']node:/.test(src) || /require\s*\(/.test(src)) throw new Error(`${f} must stay portable (no node: imports)`);
  if (/child_process|execFile|readFileSync|writeFileSync/.test(src)) throw new Error(`${f} must not touch fs/child_process`);
}
console.log("[ok] blob chain portable (no node:/fs/child_process imports)");

const browser = await import("../src/host/portable.mjs");
const { loadFromBytes, memoryStore } = browser;
if (typeof browser.createBlobService !== "function") throw new Error("portable.mjs must re-export createBlobService");
const { createBlobService } = browser;

// ── 1. local blob lifecycle (no network) ──
{
  const repo = browser.loadFromBytes(readFileSync(WASM), { store: memoryStore() });
  const blobs = createBlobService(repo, { ref: "main" });
  if (blobs.version() !== null) throw new Error("empty keyspace version should be null");
  if (blobs.read("a.txt") !== null) throw new Error("empty keyspace read should be null");
  const v1 = blobs.write({ "a.txt": "hello", "d/b.bin": new Uint8Array([1, 2, 3]) }, "init");
  if (!/^[0-9a-f]{40}$/.test(v1)) throw new Error("write should return version sha");
  if (blobs.version() !== v1) throw new Error("version should track tip");
  if (blobs.readText("a.txt") !== "hello") throw new Error("readText mismatch");
  const many = blobs.readMany(["a.txt", "d/b.bin", "missing.txt"]);
  if (many.size !== 2 || new TextDecoder().decode(many.get("a.txt")) !== "hello") {
    throw new Error("readMany should skip missing keys");
  }
  const v2 = blobs.writeText("a.txt", "hello v2", "bump");
  if (v2 === v1 || blobs.readText("a.txt") !== "hello v2") throw new Error("overwrite should move tip");
  if (new Uint8Array(blobs.read("d/b.bin"))[2] !== 3) throw new Error("untouched key must survive write");
  console.log("[ok] local blob lifecycle (write/read/version/overwrite)");
}

// ── 2. network sync against test server ──
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

  const repoA = browser.loadFromBytes(readFileSync(WASM), { store: memoryStore() });
  const a = createBlobService(repoA, { ref: "main" });
  a.writeText("config.json", JSON.stringify({ v: 1 }), "seed");
  const pub = await a.publish(BASE);
  if (!pub.updated) throw new Error("publish failed");

  const repoB = browser.loadFromBytes(readFileSync(WASM), { store: memoryStore() });
  const b = createBlobService(repoB, { ref: "main" });
  const pulled = await b.sync(BASE, ["config.json"]);
  if (new TextDecoder().decode(pulled.get("config.json")) !== JSON.stringify({ v: 1 })) {
    throw new Error("sync should return latest blobs");
  }
  if (b.readText("config.json") !== JSON.stringify({ v: 1 })) throw new Error("pull should materialize locally");
  // partial sync: blob:none keyspace carries versions without bytes
  const repoC = browser.loadFromBytes(readFileSync(WASM), { store: memoryStore() });
  const c = createBlobService(repoC, { ref: "main", filter: "blob:none" });
  await c.pull(BASE);
  if (c.version() == null) throw new Error("partial pull should still advance version");
  if (c.read("config.json") !== null) throw new Error("blob:none must omit bytes (read -> null)");
  console.log("[ok] network sync (publish/pull/sync + blob:none partial keyspace)");

  execFileSync("git", ["--git-dir", SERVER_REPO, "fsck", "--strict"]);
  console.log("[ok] server fsck clean");
  console.log("ALL BLOB TESTS PASSED");
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(SERVER_REPO, { recursive: true, force: true });
}
