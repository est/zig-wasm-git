// e2e for object-level API: get / commit (new repo + incremental + nested paths)
import { rmSync, existsSync } from "node:fs";
import { load } from "../src/host/api.mjs";
import { fileURLToPath } from "node:url";
import { dirname as _dirname, join as _join } from "node:path";
const ROOT = _join(_dirname(fileURLToPath(import.meta.url)), "..");

const WASM = _join(ROOT, "zig-out/bin/zig_wasm_git.wasm");
const DIR = _join(ROOT, "tmp/api_repo/demo.git");

if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });

const repo = load(WASM, { dir: DIR });

// ── 1. new repo (parent = "") ──
const c1 = repo.commit("", "init: hello world", {
  "README.md": "hello zig wasm git\n",
  "src/main.zig": "pub fn main() void {}\n",
  "docs/deep/nested/a.txt": "deep file\n",
});
console.log("commit1:", c1);
if (!/^[0-9a-f]{40}$/.test(c1)) throw new Error("bad commit sha");

// ── 2. read back via branch name ──
const blobs1 = repo.get("main", ["README.md", "src/main.zig", "docs/deep/nested/a.txt", "missing.txt"]);
console.log("get1:", blobs1.map((b) => `${b.path} -> ${b.error ?? `${b.oid.slice(0, 7)} ${JSON.stringify(b.content.toString())}`}`).join("\n      "));
if (blobs1[0].content.toString() !== "hello zig wasm git\n") throw new Error("README mismatch");
if (blobs1[2].content.toString() !== "deep file\n") throw new Error("nested mismatch");
if (!blobs1[3].error) throw new Error("missing.txt should error");

// ── 3. incremental commit (parent = "main"): modify + add + untouched path ──
const c2 = repo.commit("main", "edit + add", {
  "README.md": "hello v2\n",
  "src/new.zig": "// new file\n",
});
console.log("commit2:", c2);

const blobs2 = repo.get("main", ["README.md", "src/new.zig", "src/main.zig", "docs/deep/nested/a.txt"]);
console.log("get2:", blobs2.map((b) => `${b.path} -> ${b.error ?? `${b.oid.slice(0, 7)} ${JSON.stringify(b.content.toString())}`}`).join("\n      "));
if (blobs2[0].content.toString() !== "hello v2\n") throw new Error("README v2 mismatch");
if (blobs2[1].content.toString() !== "// new file\n") throw new Error("new.zig mismatch");
if (blobs2[2].content.toString() !== "pub fn main() void {}\n") throw new Error("old file must persist");
if (blobs2[3].content.toString() !== "deep file\n") throw new Error("deep file must persist");

// ── 4. HEAD + sha1 read equivalence ──
const bySha = repo.get(c1, ["README.md"]);
if (bySha[0].content.toString() !== "hello zig wasm git\n") throw new Error("read-by-sha mismatch (got v2?)");
const byHead = repo.get("HEAD", ["README.md"]);
if (byHead[0].content.toString() !== "hello v2\n") throw new Error("HEAD should point at newest");
console.log("read-by-sha(c1):", JSON.stringify(bySha[0].content.toString()), " HEAD:", JSON.stringify(byHead[0].content.toString()));

// ── 5. binary content roundtrip ──
const bin = Buffer.from([0, 1, 2, 255, 254, 0, 128, 127]);
const c3 = repo.commit("main", "binary", { "bin.dat": bin });
const back = repo.get("main", ["bin.dat"])[0].content;
if (!bin.equals(back)) throw new Error("binary roundtrip mismatch");
console.log("binary roundtrip ok:", bin.length, "bytes");

// ── 6. git-level interop: real git can read our repo ──
import { execFileSync } from "node:child_process";
const log = execFileSync("git", ["--git-dir", DIR, "log", "--oneline"]).toString().trim();
console.log("git log:\n  " + log.split("\n").join("\n  "));
const lsTree = execFileSync("git", ["--git-dir", DIR, "ls-tree", "-r", "main", "--name-only"]).toString().trim();
console.log("git ls-tree:\n  " + lsTree.split("\n").join("\n  "));
const catFile = execFileSync("git", ["--git-dir", DIR, "cat-file", "-p", "main:README.md"]).toString();
if (catFile !== "hello v2\n") throw new Error("git cat-file mismatch");
console.log("git cat-file main:README.md ->", JSON.stringify(catFile));
// fsck for object integrity
const fsck = execFileSync("git", ["--git-dir", DIR, "fsck", "--strict"]).toString().trim();
console.log("git fsck:", fsck === "" ? "clean" : fsck);

console.log("\nALL API E2E PASSED");
