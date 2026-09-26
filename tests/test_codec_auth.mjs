// tests/test_codec_auth.mjs — portable helper coverage (no network, no server).
// Covers: wire.toModule (bytes vs precompiled Module) + loadFromBytes(Module)
// for codegen-forbidding runtimes (workerd CompiledWasm), and
// codec.withBasicAuth (URL userinfo -> Authorization header + stripped URL).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = join(ROOT, "zig-out/bin/zig_wasm_git.wasm");

// Portable assertion: touched helpers must stay worker-safe.
for (const f of ["wire.mjs", "codec.mjs", "portable.mjs"]) {
  const src = readFileSync(join(ROOT, "src/host", f), "utf8");
  if (/from\s+["']node:/.test(src) || /require\s*\(/.test(src)) throw new Error(`${f} must stay portable (no node: imports)`);
  if (/child_process|execFile|readFileSync|writeFileSync/.test(src)) throw new Error(`${f} must not touch fs/child_process`);
}
console.log("[ok] helpers portable (no node:/fs/child_process imports)");

// Back-compat: browser.mjs stays as a deprecated re-export shim.
{
  const shim = readFileSync(join(ROOT, "src/host/browser.mjs"), "utf8");
  if (!/from\s+["']\.\/portable\.mjs["']/.test(shim)) throw new Error("browser.mjs must re-export portable.mjs");
}

const { toModule, bootWasm } = await import("../src/host/wire.mjs");
const { withBasicAuth } = await import("../src/host/codec.mjs");
const browser = await import("../src/host/portable.mjs");
if (typeof browser.withBasicAuth !== "function") throw new Error("portable.mjs must re-export withBasicAuth");

// ── 1. toModule ──
{
  const bytes = readFileSync(WASM);
  const m1 = toModule(bytes);
  if (!(m1 instanceof WebAssembly.Module)) throw new Error("toModule(bytes) should return a Module");
  if (toModule(m1) !== m1) throw new Error("toModule(Module) should return it unchanged");
  const { wasm } = bootWasm(m1);
  if (typeof wasm.wasm_reset !== "function") throw new Error("bootWasm(Module) should expose exports");
  console.log("[ok] toModule accepts bytes and precompiled Module");
}

// ── 2. loadFromBytes(Module) end-to-end (local, no network) ──
{
  const mod = toModule(readFileSync(WASM));
  const repo = browser.loadFromBytes(mod, { store: browser.memoryStore() });
  const sha = repo.commit("", "init", { "a.txt": "hi" }, "refs/heads/main");
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("commit via Module-loaded repo failed");
  const rows = repo.get("main", ["a.txt"]);
  if (new TextDecoder().decode(rows[0].content) !== "hi") throw new Error("get via Module-loaded repo failed");
  console.log("[ok] loadFromBytes precompiled Module (commit/get)");
}

// ── 3. withBasicAuth ──
{
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return { ok: true };
  };
  const wrapped = withBasicAuth(fake);

  await wrapped("https://oauth2:abc123@git.example.com/team/docs.git/info/refs?service=git-upload-pack");
  const c = calls[0];
  const expect = `Basic ${Buffer.from("oauth2:abc123").toString("base64")}`;
  if (c.auth !== expect) throw new Error(`Authorization mismatch: ${c.auth}`);
  if (c.url.includes("abc123") || c.url.includes("oauth2")) throw new Error(`credentials not stripped: ${c.url}`);
  if (!c.url.startsWith("https://git.example.com/team/docs.git/")) throw new Error(`URL mangled: ${c.url}`);

  // no userinfo -> passthrough, no header added
  await wrapped("https://git.example.com/team/docs.git/info/refs", { headers: { "x-a": "1" } });
  if (calls[1].auth !== null) throw new Error("passthrough URL should not gain Authorization");
  if (!calls[1].url.includes("git.example.com")) throw new Error("passthrough URL changed");

  // pre-set Authorization wins
  await wrapped("https://u:p@git.example.com/x", { headers: { authorization: "Bearer t" } });
  if (calls[2].auth !== "Bearer t") throw new Error("existing Authorization must be preserved");

  // non-URL input -> delegate untouched
  const sentinel = { ok: true };
  const ret = await withBasicAuth(async () => sentinel)("/relative/path");
  if (ret !== sentinel) throw new Error("non-URL input should delegate");
  console.log("[ok] withBasicAuth (header set, strip, passthrough, preserve)");
}

// ── 4. default commit time is wall-clock, not epoch 0 ──
{
  const before = Math.floor(Date.now() / 1000);
  const repo = browser.loadFromBytes(readFileSync(WASM), { store: browser.memoryStore() });
  repo.commit("", "wall clock", { "t.txt": "x" });
  const [e] = await repo.log("main", 1);
  const m = e.author.match(/ (\d+) \+0000$/);
  if (!m) throw new Error(`author line missing timestamp: ${e.author}`);
  const ts = Number(m[1]);
  const after = Math.floor(Date.now() / 1000);
  if (!(ts >= before && ts <= after)) throw new Error(`default time ${ts} not in [${before}, ${after}]`);
  if (ts < 1700000000) throw new Error(`default time looks like epoch: ${ts}`);
  console.log(`[ok] default commit time is wall-clock (${ts})`);
}

// ── 5. browser.mjs shim still works ──
{
  const shim = await import("../src/host/browser.mjs");
  if (typeof shim.loadFromBytes !== "function") throw new Error("browser.mjs shim must re-export loadFromBytes");
  const repo = shim.loadFromBytes(readFileSync(WASM), { store: shim.memoryStore() });
  const sha = repo.commit("", "shim", { "s.txt": "y" }, "refs/heads/main", { time: 1755859200 });
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("commit via browser.mjs shim failed");
  console.log("[ok] browser.mjs shim re-exports portable.mjs");
}

console.log("ALL CODEC-AUTH TESTS PASSED");
