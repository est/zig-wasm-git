// tests/test_push.mjs — push e2e: RemoteGit straight to server.mjs, real git accepts.
import { spawn, execFileSync } from "node:child_process";
import { rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteGit } from "../src/host/portable.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = readFileSync(join(ROOT, "zig-out/bin/zig_wasm_git.wasm"));
const PORT = 32123;
const BASE = `http://localhost:${PORT}/pushtest.git`;
const SERVER_REPO = join(ROOT, "data/pushtest.git");
rmSync(SERVER_REPO, { recursive: true, force: true });

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

  const local = await RemoteGit.open(BASE, { wasm: WASM, ref: "main" });
  const c1 = await local.putMany({ "README.md": "hello push\n", "src/a.txt": "a\n" }, "init");
  console.log("local c1:", c1);

  // ── first push (new branch) ──
  const r1 = await local.push();
  console.log("push1:", JSON.stringify({ ...r1, new: r1.new.slice(0, 7) }));
  if (!r1.updated || r1.objects < 4) throw new Error(`push1 suspect: objects=${r1.objects}`);
  const ref1 = execFileSync("git", ["--git-dir", SERVER_REPO, "rev-parse", "refs/heads/main"]).toString().trim();
  if (ref1 !== c1) throw new Error(`server ref mismatch: ${ref1} != ${c1}`);
  const readme = execFileSync("git", ["--git-dir", SERVER_REPO, "cat-file", "-p", `${c1}:README.md`]).toString();
  if (readme !== "hello push\n") throw new Error("server blob mismatch");
  execFileSync("git", ["--git-dir", SERVER_REPO, "fsck", "--strict"]);
  console.log("server fsck clean");

  // ── noop ──
  const rNoop = await local.push();
  if (rNoop.updated) throw new Error("noop push should not update");
  console.log("noop ok");

  // ── incremental push ──
  const c2 = await local.putMany({ "README.md": "hello v2\n" }, "v2");
  const r2 = await local.push();
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
