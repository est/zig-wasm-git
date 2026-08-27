import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
// Simple bare repo in ./data/<repo>.git  (objects + refs)
const DATA_DIR = join(REPO_ROOT, "data");
const WASM_PATH = join(REPO_ROOT, "zig-out/bin/zig_wasm_git.wasm");

let wasm = null;
let wasmMem = null;
let wasmInstance = null;
let emitBuf = [];

function loadWasm() {
  const bytes = readFileSync(WASM_PATH);
  const imports = {
    env: {
      host_emit_bytes: (ptr, len) => {
        const mem = new Uint8Array(wasmInstance.exports.memory.buffer);
        emitBuf.push(Buffer.from(mem.slice(ptr, ptr + len)));
      },
      host_log: (ptr, len) => {
        const mem = new Uint8Array(wasmInstance.exports.memory.buffer);
        console.log("[wasm]", Buffer.from(mem.slice(ptr, ptr + len)).toString());
      },
      host_get_object: () => -1, // smart-HTTP host doesn't use object store
      host_put_object: () => -1,
    },
  };
  const mod = new WebAssembly.Module(bytes);
  const inst = new WebAssembly.Instance(mod, imports);
  wasmInstance = inst;
  wasm = inst.exports;
  wasmMem = inst.exports.memory;
  // Make memory available as wasm.exports.memory for wasm callbacks that read via exports
  // Zig wasm32-freestanding may export memory as "memory" already
  if (!wasm.memory) wasm.memory = inst.exports.memory;
}

function wasmAlloc(bytes) {
  const ptr = wasm.wasm_alloc(bytes.length);
  if (!ptr) throw new Error("wasm_alloc failed");
  const mem = new Uint8Array(wasmMem.buffer);
  mem.set(bytes, ptr);
  return ptr;
}

function wasmGetSlice(ptr, len) {
  const mem = new Uint8Array(wasmMem.buffer);
  return Buffer.from(mem.slice(ptr, ptr + len));
}

// --- storage: bare repo on filesystem (data/<name>.git) ---
function repoPath(name) {
  return join(DATA_DIR, name.endsWith(".git") ? name : name + ".git");
}
function ensureRepo(name) {
  const rp = repoPath(name);
  if (!existsSync(join(rp, "HEAD"))) {
    mkdirSync(join(rp, "objects"), { recursive: true });
    mkdirSync(join(rp, "refs/heads"), { recursive: true });
    writeFileSync(join(rp, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(rp, "config"), `[core]\n\trepositoryformatversion = 0\n`);
  }
  return rp;
}

function listRefs(name) {
  const rp = repoPath(name);
  const refs = [];
  function walk(dir, prefix) {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir)) {
      const p = join(dir, ent);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, prefix + ent + "/");
      else {
        const oid = readFileSync(p, "utf8").trim();
        refs.push({ oid, name: prefix + ent });
      }
    }
  }
  walk(join(rp, "refs/heads"), "refs/heads/");
  walk(join(rp, "refs/tags"), "refs/tags/");
  // Also support packed-refs? skip for MVP
  return refs;
}

function getRef(name, refName) {
  const rp = repoPath(name);
  const p = join(rp, refName);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8").trim();
}

function putRef(name, refName, oidHex) {
  const rp = repoPath(name);
  const p = join(rp, refName);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, oidHex + "\n");
}

function hasObject(name, oidHex) {
  const rp = repoPath(name);
  // loose
  if (existsSync(join(rp, "objects", oidHex.slice(0, 2), oidHex.slice(2)))) return true;
  // pack: naive check via `git cat-file -e` style? For MVP, scan packs loose only.
  // If pack exists, assume host will serve via pack enumeration (Host does not yet use wasm for pack gen)
  return false;
}

function pktLine(s) {
  const len = s.length + 4;
  return len.toString(16).padStart(4, "0") + s;
}
function pktFlush() { return "0000"; }

function buildRefsPkt(refs) {
  // 对齐真实 git http-backend: receive-pack 的空仓无 symref
  const uploadCaps = ["symref=HEAD:refs/heads/main", "filter", "report-status", "report-status-v2", "delete-refs", "side-band-64k", "quiet", "atomic", "ofs-delta", "object-format=sha1", "agent=zig-wasm-git/0.0.1"];
  const receiveCapsNoSymref = ["report-status", "report-status-v2", "delete-refs", "side-band-64k", "quiet", "atomic", "ofs-delta", "object-format=sha1", "agent=git/2.50.1-Darwin"];
  const receiveCapsSymref = ["symref=HEAD:refs/heads/main", "report-status", "report-status-v2", "delete-refs", "side-band-64k", "quiet", "atomic", "ofs-delta", "object-format=sha1", "agent=zig-wasm-git/0.0.1"];
  const isReceive = (globalThis.__lastDiscoveryService || "") === "git-receive-pack";
  const caps = isReceive
    ? (refs.length === 0 ? receiveCapsNoSymref : receiveCapsSymref)
    : uploadCaps;
  if (refs.length === 0) {
    return pktLine("0000000000000000000000000000000000000000 capabilities^{}\x00" + caps.join(" ") + "\n") + pktFlush();
  }
  let out = "";
  refs.forEach((r, i) => {
    let line = `${r.oid} ${r.name}\n`;
    if (i === 0) line = `${r.oid} ${r.name}\x00${caps.join(" ")}\n`;
    out += pktLine(line);
  });
  out += pktFlush();
  return out;
}

function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function wantsFilterFromBody(body) {
  // Parse pkt-lines properly
  const s = body.toString("utf8");
  let pos = 0;
  const filters = [];
  while (pos + 4 <= s.length) {
    const hex = s.slice(pos, pos + 4);
    if (hex === "0000" || hex === "0001" || hex === "0002") { pos += 4; continue; }
    const len = parseInt(hex, 16);
    if (isNaN(len) || len < 4) break;
    const payload = s.slice(pos + 4, pos + len);
    pos += len;
    const trimmed = payload.trim();
    if (trimmed.startsWith("filter ")) filters.push(trimmed.slice(7).trim());
  }
  return filters.join("+");
}

function isV2(req) {
  const proto = req.headers["git-protocol"];
  return proto && proto.includes("version=2");
}

function pktLineByte(s) { const len = Buffer.byteLength(s) + 4; return len.toString(16).padStart(4, "0") + s; }

function buildV2Caps() {
  // shallow is a fetch arg, not a capability value; keep fetch=filter, but shallow works regardless if client sends deepen
  const caps = ["version 2", "ls-refs", "fetch=filter wait-for-done", "server-option", "object-format=sha1", "agent=zig-wasm-git/0.0.1"];
  let out = "";
  for (const c of caps) out += pktLine(c + "\n");
  out += pktFlush();
  return out;
}

function parseShallow(body) {
  // pkt-line payloads: look for "deepen N" or "deepen-since <date>" or "deepen-not <ref>"
  const s = body.toString("utf8");
  let pos = 0, depth = 0, deepenSince = "", deepenNot = "";
  while (pos + 4 <= s.length) {
    const hex = s.slice(pos, pos + 4);
    if (hex === "0000" || hex === "0001" || hex === "0002") { pos += 4; continue; }
    const len = parseInt(hex, 16);
    if (isNaN(len) || len < 4) break;
    const payload = s.slice(pos + 4, pos + len);
    pos += len;
    const trimmed = payload.trim();
    if (trimmed.startsWith("deepen ")) {
      const v = parseInt(trimmed.slice(7).trim(), 10);
      if (!isNaN(v) && v > 0) depth = v;
    } else if (trimmed.startsWith("deepen-since ")) deepenSince = trimmed.slice(13).trim();
    else if (trimmed.startsWith("deepen-not ")) deepenNot = trimmed.slice(11).trim();
    else if (trimmed.startsWith("shallow ")) { /* client ack */ }
  }
  return { depth, deepenSince, deepenNot };
}

function gitHttpBackendDiscovery(repo, service, gitProtocol) {
  const env = {
    ...process.env,
    GIT_PROJECT_ROOT: DATA_DIR,
    GIT_HTTP_EXPORT_ALL: "1",
    REQUEST_METHOD: "GET",
    QUERY_STRING: `service=${service}`,
    PATH_INFO: `/${repo}.git/info/refs`,
  };
  if (gitProtocol) env.HTTP_GIT_PROTOCOL = gitProtocol;
  try {
    const out = execFileSync("git", ["http-backend"], { env, maxBuffer: 64 * 1024 * 1024 });
    // out contains HTTP headers + body separated by \r\n\r\n
    const text = out.toString("binary");
    const sep = "\r\n\r\n";
    const idx = text.indexOf(sep);
    const body = idx >= 0 ? out.subarray(idx + sep.length) : out;
    // body may still start with headers like "Expires..." if git http-backend outputs them; find 001e marker
    const bodyStr = body.toString("utf8");
    const marker = "001e# service=";
    const mIdx = bodyStr.indexOf(marker);
    if (mIdx >= 0) return Buffer.from(bodyStr.slice(mIdx), "utf8");
    return body;
  } catch (e) {
    return null;
  }
}

async function handleDiscovery(url, req, res, service) {
  globalThis.__lastDiscoveryService = service;
  const m = url.match(/^\/([^/]+?)(?:\.git)?\/info\/refs/);
  const repo = m ? m[1] : "demo";
  ensureRepo(repo);
  // For receive-pack, delegate to real git http-backend to guarantee pkt correctness (push was failing on hand-built caps)
  if (service === "git-receive-pack") {
    const gitProto = req.headers["git-protocol"] || "";
    const body = gitHttpBackendDiscovery(repo, service, gitProto);
    if (body) {
      const ct = "application/x-git-receive-pack-advertisement";
      res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-cache", "Expires": "Fri, 01 Jan 1980 00:00:00 GMT", "Pragma": "no-cache" });
      res.end(body);
      return;
    }
  }
  if (isV2(req)) {
    const capsPkt = buildV2Caps();
    const ct = service === "git-upload-pack"
      ? "application/x-git-upload-pack-advertisement"
      : "application/x-git-receive-pack-advertisement";
    res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-cache" });
    res.end(Buffer.from(capsPkt));
    return;
  }
  const refs = listRefs(repo);
  const refsPkt = buildRefsPkt(refs);
  emitBuf = [];
  wasm.wasm_reset();
  const refsBytes = Buffer.from(refsPkt);
  const ptr = wasmAlloc(refsBytes);
  const svc = service === "git-upload-pack" ? 0 : 1;
  wasm.wasm_handle_discovery(svc, ptr, refsBytes.length);
  let out;
  if (emitBuf.length > 0) {
    out = Buffer.concat(emitBuf);
  } else {
    out = Buffer.from(pktLine(`# service=${service}\n`) + pktFlush() + refsPkt);
  }
  const ct = service === "git-upload-pack"
    ? "application/x-git-upload-pack-advertisement"
    : "application/x-git-receive-pack-advertisement";
  res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-cache" });
  res.end(out);
}

function parseV2Command(body) { // defined below after handleDiscovery
  const s = body.toString();
  let pos = 0;
  let cmd = "";
  while (pos + 4 <= s.length) {
    const lenHex = s.slice(pos, pos + 4);
    if (lenHex === "0000" || lenHex === "0001" || lenHex === "0002") { pos += 4; continue; }
    const len = parseInt(lenHex, 16);
    if (isNaN(len) || len < 4) break;
    const payload = s.slice(pos + 4, pos + len);
    pos += len;
    const trimmed = payload.trim();
    if (trimmed.startsWith("command=")) cmd = trimmed.slice("command=".length).trim();
    else if (trimmed.startsWith("command ")) cmd = trimmed.slice("command ".length).trim();
    if (cmd) break;
  }
  return cmd || s.slice(0, 100).replace(/\0/g, "\\0");
}

async function handleUploadPackV2(url, req, res) {
  const m = url.match(/^\/([^/]+?)(?:\.git)?\/git-upload-pack/);
  const repo = m ? m[1] : "demo";
  ensureRepo(repo);
  const body = await parseBody(req);
  const bodyStr = body.toString();
  const isV2Body = bodyStr.includes("command=") || bodyStr.includes("command ");
  const filterSpec = wantsFilterFromBody(body);
  if (isV2Body) {
    const cmd = parseV2Command(body);
    console.log(`[upload-pack v2] repo=${repo} cmd=${cmd} filter=${filterSpec || "(none)"} body=${body.length}`);
    if (cmd === "ls-refs") {
      // v2 ls-refs response: no need to go through git upload-pack; we already have refs
      // Parse args: peel, symrefs, filter? For MVP just return all refs
      const refs = listRefs(repo);
      let out = "";
      for (const r of refs) out += pktLine(`${r.oid} ${r.name}\n`);
      out += pktFlush();
      // Ensure we consume optional delimiter section? Client sent peel/symrefs after delim.
      // Our simple response is fine for empty repo (no refs -> just flush)
      res.writeHead(200, { "Content-Type": "application/x-git-upload-pack-result", "Cache-Control": "no-cache" });
      res.end(Buffer.from(out));
      return;
    }
    // For ls-refs, never fall through to git upload-pack --stateless-rpc (it speaks v1)
    if (cmd === "fetch") {
      console.log(`  wasm_should_omit check for fetch filter=${filterSpec}`);
      if (filterSpec) {
        wasm.wasm_reset();
        const fptr = wasmAlloc(Buffer.from(filterSpec));
        const kptr = wasmAlloc(Buffer.from("blob"));
        const omit = wasm.wasm_should_omit(kptr, 4, 100, fptr, filterSpec.length);
        console.log(`  wasm_should_omit(blob,100, filter=${filterSpec}) = ${omit}`);
      }
      await handleV2Fetch(repo, body, res);
      return;
    }
  }
  await handleUploadPackInner(repo, body, res);
}

function parseV2Fetch(body) {
  const s = body.toString("utf8");
  let pos = 0;
  const wants = [];
  const haves = [];
  let filter = "";
  while (pos + 4 <= s.length) {
    const hex = s.slice(pos, pos + 4);
    if (hex === "0000") { pos += 4; continue; } // don't break early; fetch has header + delim + wants + done
    if (hex === "0001" || hex === "0002") { pos += 4; continue; }
    const len = parseInt(hex, 16);
    if (isNaN(len) || len < 4) break;
    const payload = s.slice(pos + 4, pos + len);
    pos += len;
    const trimmed = payload.trim();
    if (trimmed.startsWith("command=") || trimmed.startsWith("command ") || trimmed.startsWith("agent=") || trimmed.startsWith("object-format")) continue;
    if (trimmed.startsWith("want ")) wants.push(trimmed.slice(5).trim().split(/\s+/)[0]);
    else if (trimmed.startsWith("have ")) haves.push(trimmed.slice(5).trim());
    else if (trimmed.startsWith("filter ")) filter = trimmed.slice(7).trim();
  }
  return { wants, haves, filter };
}

async function handleV2Fetch(repo, body, res) {
  const { wants, filter } = parseV2Fetch(body);
  const sh = parseShallow(body);
  console.log(`[v2 fetch] wants=${wants.join(",")} filter=${filter || "(none)"} depth=${sh.depth}`);
  // For now, serve pack via git upload-pack in v2 http-backend mode if possible, else fallback to v1-pack
  // Try to use git http-backend for v2 fetch by constructing env
  const rp = repoPath(repo);
  // Fallback: generate pack via `git pack-objects --stdout` from wants
  // The v2 fetch wants OIDs are commits; pack them via rev-list
  let packBuf;
  try {
    const env = {
      ...process.env,
      GIT_PROJECT_ROOT: DATA_DIR,
      GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: "POST",
      CONTENT_TYPE: "application/x-git-upload-pack-request",
      QUERY_STRING: "",
      PATH_INFO: `/${repo}.git/git-upload-pack`,
      CONTENT_LENGTH: String(body.length),
      HTTP_GIT_PROTOCOL: "version=2",
    };
    packBuf = execFileSync("git", ["http-backend"], { env, input: body, maxBuffer: 64 * 1024 * 1024 });
    const text = packBuf.toString("binary");
    const sep = "\r\n\r\n";
    const idx = text.indexOf(sep);
    if (idx >= 0) packBuf = packBuf.subarray(idx + sep.length);
    if (packBuf.length < 100 || packBuf.toString().startsWith("Status:")) throw new Error("http-backend fetch fallback: " + packBuf.toString().slice(0, 500));
    res.writeHead(200, { "Content-Type": "application/x-git-upload-pack-result", "Cache-Control": "no-cache" });
    res.end(packBuf);
    return;
  } catch (e) {
    const detail = (e.stdout || e.stderr || e.message || "").toString().slice(0, 800).replace(/\n/g, "\\n");
    console.log(`[v2 fetch] http-backend fetch failed: ${detail}, fallback to pack-objects syn`);
  }
  // Fallback: generate pack; handle commit wants + single-blob promisor wants
  try {
    // Detect promisor blob fetch: wants are single blob o's (not commits)
    const blobWants = [];
    const commitWants = [];
    for (const w of wants) {
      try {
        const t = execFileSync("git", ["--git-dir", rp, "cat-file", "-t", w], { maxBuffer: 1024 }).toString().trim();
        if (t === "blob") blobWants.push(w);
        else commitWants.push(w);
      } catch {
        commitWants.push(w);
      }
    }
    let pack;
    const shallowLines = [];
    if (sh.depth > 0 && commitWants.length > 0) {
      // Shallow fetch: include only N commits per want; boundary = parents of deepest kept commit
      let objs;
      const includedPerWant = [];
      for (const wnt of commitWants) {
        const list = execFileSync("git", ["--git-dir", rp, "rev-list", "--max-count", String(sh.depth), wnt], { maxBuffer: 64 * 1024 * 1024 }).toString().trim().split("\n").filter(Boolean);
        includedPerWant.push(list);
        // record the deepest commit's parents as shallow boundaries
        if (list.length >= sh.depth) {
          const deepest = list[list.length - 1];
          try {
            const raw = execFileSync("git", ["--git-dir", rp, "rev-list", "--parents", "-n", "1", deepest], { maxBuffer: 64 * 1024 }).toString().trim().split(/\s+/).slice(1);
            for (const par of raw) shallowLines.push(par);
          } catch { /* root commit -> no boundary */ }
        } else {
          // history shorter than depth: fully unshallowed, no boundary
        }
      }
      const uniqWants = [...new Set(commitWants)];
      objs = execFileSync("git", ["--git-dir", rp, "rev-list", "--objects", "--no-walk=unsorted",
        ...includedPerWant.flat()], { maxBuffer: 64 * 1024 * 1024 }).toString();
      // trees/blobs under the kept commits need a walk, not --no-walk only for commits:
      // walk with filtered depth: rev-list --objects over the included tips limited by max-count
      objs = execFileSync("git", ["--git-dir", rp, "rev-list", "--objects", "--max-count", String(sh.depth), ...uniqWants], { maxBuffer: 64 * 1024 * 1024 }).toString();
      if (filter) {
        objs = execFileSync("git", ["--git-dir", rp, "rev-list", "--objects", "--max-count", String(sh.depth),
          ...uniqWants, `--filter=${filter}`], { maxBuffer: 64 * 1024 * 1024 }).toString();
      }
      pack = execFileSync("git", ["--git-dir", rp, "pack-objects", "--stdout"], { input: Buffer.from(objs), maxBuffer: 64 * 1024 * 1024 });
    } else if (blobWants.length > 0 && commitWants.length === 0) {
      // Single blob promisor fetch: use cat-file -p to get content, then hash-object to produce pack? Simpler: pack-objects with stdin containing blob oids
      const input = blobWants.join("\n") + "\n";
      // pack-objects needs rev-list style; for blobs, use `git pack-objects --stdout` with object list containing blob oids directly via stdin
      // Use `git cat-file --batch` trick: just feed blob oids to pack-objects via rev-list --objects --no-walk
      const out = execFileSync("git", ["--git-dir", rp, "rev-list", "--objects", "--no-walk", ...blobWants], { maxBuffer: 64 * 1024 * 1024 }).toString();
      pack = execFileSync("git", ["--git-dir", rp, "pack-objects", "--stdout"], { input: Buffer.from(out), maxBuffer: 64 * 1024 * 1024 });
    } else {
      let revListOut;
      const targetWants = commitWants.length ? commitWants : wants;
      if (filter) {
        revListOut = execFileSync("git", ["--git-dir", rp, "rev-list", "--objects", ...targetWants, `--filter=${filter}`], { maxBuffer: 64 * 1024 * 1024 }).toString();
      } else {
        revListOut = execFileSync("git", ["--git-dir", rp, "rev-list", "--objects", ...targetWants], { maxBuffer: 64 * 1024 * 1024 }).toString();
      }
      pack = execFileSync("git", ["--git-dir", rp, "pack-objects", "--stdout"], { input: Buffer.from(revListOut), maxBuffer: 64 * 1024 * 1024 });
    }
    // v2 expects sideband-64k framing: optional shallow section, "packfile" header, band-1 chunks, flush
    const MAX = 65516;
    const chunks = [];
    if (sh.depth > 0) {
      for (const s of new Set(shallowLines)) chunks.push(Buffer.from(pktLine(`shallow ${s}`), "utf8"));
      chunks.push(Buffer.from(pktFlush(), "utf8"));
    }
    if (sh.depth > 0) chunks.push(Buffer.from(pktLineByte("packfile\n"), "utf8"));
    for (let off = 0; off < pack.length; off += MAX) {
      const slice = pack.subarray(off, Math.min(off + MAX, pack.length));
      const payload = Buffer.concat([Buffer.from([1]), slice]);
      const len = payload.length + 4;
      const hdr = len.toString(16).padStart(4, "0");
      chunks.push(Buffer.from(hdr, "utf8"));
      chunks.push(payload);
    }
    chunks.push(Buffer.from("0000", "utf8"));
    const body = Buffer.concat(chunks);
    res.writeHead(200, { "Content-Type": "application/x-git-upload-pack-result", "Cache-Control": "no-cache" });
    res.end(body);
  } catch (e2) {
    console.error("[v2 fetch] pack fallback failed", e2.message?.slice(0, 500));
    res.writeHead(500);
    res.end(e2.stdout || Buffer.from("fetch failed"));
  }
}

async function handleUploadPack(url, req, res) {
  const m = url.match(/^\/([^/]+?)(?:\.git)?\/git-upload-pack/);
  const repo = m ? m[1] : "demo";
  ensureRepo(repo);
  const body = await parseBody(req);
  await handleUploadPackInner(repo, body, res);
}

async function handleUploadPackInner(repo, body, res) {
  const filterSpec = wantsFilterFromBody(body);
  console.log(`[upload-pack] repo=${repo} body=${body.length} filter=${filterSpec || "(none)"} ` + body.toString().slice(0, 300).replace(/\0/g, "\\0"));
  if (filterSpec) {
    wasm.wasm_reset();
    const fptr = wasmAlloc(Buffer.from(filterSpec));
    const kptr = wasmAlloc(Buffer.from("blob"));
    const omit = wasm.wasm_should_omit(kptr, 4, 100, fptr, filterSpec.length);
    console.log(`  wasm_should_omit(blob,100, filter=${filterSpec}) = ${omit}`);
  }
  try {
    const rp = repoPath(repo);
    const out = execFileSync("git", ["upload-pack", "--stateless-rpc", rp], { input: body, maxBuffer: 64 * 1024 * 1024 });
    res.writeHead(200, { "Content-Type": "application/x-git-upload-pack-result" });
    res.end(out);
  } catch (e) {
    console.error("[upload-pack] git failed", e.message.slice(0, 500));
    const msg = e.stdout || e.stderr || Buffer.from("");
    res.writeHead(500);
    res.end(msg);
  }
}

async function handleReceivePack(url, req, res) {
  const m = url.match(/^\/([^/]+?)(?:\.git)?\/git-receive-pack/);
  const repo = m ? m[1] : "demo";
  ensureRepo(repo);
  const body = await parseBody(req);
  console.log(`[receive-pack] repo=${repo} body=${body.length}`);
  try {
    const rp = repoPath(repo);
    const out = execFileSync("git", ["receive-pack", "--stateless-rpc", rp], { input: body, maxBuffer: 64 * 1024 * 1024 });
    res.writeHead(200, { "Content-Type": "application/x-git-receive-pack-result" });
    res.end(out);
  } catch (e) {
    console.error("[receive-pack] failed", e.message.slice(0, 500));
    res.writeHead(500);
    res.end(e.stdout || Buffer.from(""));
  }
}

loadWasm();
console.log(`[wasm] loaded size=${readFileSync(WASM_PATH).length} exports=${Object.keys(wasm).join(",")}`);

const PORT = parseInt(process.env.PORT || "3000", 10);
const server = createServer(async (req, res) => {
  const url = req.url || "/";
  console.log(`${req.method} ${url} proto=${req.headers["git-protocol"] || ""}`);
  if (req.method === "GET" && url.includes("/info/refs")) {
    const svc = url.includes("git-receive-pack") ? "git-receive-pack" : "git-upload-pack";
    await handleDiscovery(url, req, res, svc);
  } else if (req.method === "POST" && url.includes("git-upload-pack")) {
    // v2: POST is to /<repo>.git/git-upload-pack with body containing commands
    // Detect v2 fetch/ls-refs by looking at body first 4 chars / content
    await handleUploadPackV2(url, req, res);
  } else if (req.method === "POST" && url.includes("git-receive-pack")) {
    await handleReceivePack(url, req, res);
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});
server.listen(PORT, () => console.log(`listening on http://localhost:${PORT}  data=${DATA_DIR}`));
