// src/host/utils.mjs — portable helpers shared by the repo entry and sync clients.
// Zero node: imports. Only: WebAssembly, CompressionStream/DecompressionStream,
// TextEncoder/Decoder, URL/Headers/btoa.
//
// Requires (no runtime checks — callers target Node 18+/CF Workers/modern
// browsers where these are built in; missing pieces fail naturally at the
// call site): WebAssembly, CompressionStream/DecompressionStream,
// crypto.subtle (sync clients), fetch (sync clients).
//
// Sections:
//   errors: GitError + its codes (every throw from the client chain)
//   net:    netFetch — fetch + failure normalization (NETWORK / HTTP)
//   keys:   key validation (a key that cannot round-trip is rejected)
//   store:  in-memory object store (same interface as any custom backend)
//   codec:  hex/url/auth, zlib, loose/tree/commit parsing
//   wire:   wasm boot + git-protocol call wrappers (source of truth for pkt shapes)

const enc = new TextEncoder();
const dec = new TextDecoder();
export { enc, dec };

// ── errors ──

// Brand for `GitError.is`, so an error thrown by one *copy* of this module is
// still recognized by another. `instanceof` cannot do that: the npm package and
// the single-file GitHub-release bundle are separate copies of this class, and
// an app can load both (a Worker vendoring the release download alongside its
// npm install). `Symbol.for` is registry-wide, so the brand crosses the copy
// boundary where `instanceof` does not.
const BRAND = Symbol.for("zig-wasm-git.GitError");

/// The one error type this library throws, and the namespace for its codes —
/// one export, so a caller needs a single import:
///
///   import { GitError } from "zig-wasm-git";
///   if (GitError.is(e, "CAS_MISMATCH")) { ... }          // narrows to that code
///   if (GitError.is(e, "NETWORK", "HTTP")) { ... }       // narrows to the union
///   if (GitError.is(e)) { ... }                          // any GitError
///
/// The static codes below are the single source of truth for the vocabulary:
/// the client chain throws via `failed()`, and the shipped `.d.mts` mirrors the
/// list (a test asserts the two agree). Branch on `.code`, never on `.message`.
export class GitError extends Error {
  // ── codes ──
  static BAD_STORE = "BAD_STORE"; // store does not satisfy the synchronous interface
  static BAD_KEY = "BAD_KEY"; // a write key cannot round-trip
  static BAD_REF = "BAD_REF"; // ref unresolvable in the local store
  static CAS_MISMATCH = "CAS_MISMATCH"; // putMany parent != current tip
  static NON_FAST_FORWARD = "NON_FAST_FORWARD"; // push target is not a descendant of the remote tip
  static PUSH_REJECTED = "PUSH_REJECTED"; // server refused the ref update
  static UNPACK_FAILED = "UNPACK_FAILED"; // server could not unpack the pushed pack
  static NO_REMOTE_REF = "NO_REMOTE_REF"; // ref/branch does not exist on the remote
  static NO_SUCH_OBJECT = "NO_SUCH_OBJECT"; // server accepted the want but did not send the object
  static NO_V2 = "NO_V2"; // server lacks protocol v2 (pull / ls-refs require it)
  static HTTP = "HTTP"; // non-2xx response; see .status
  static NETWORK = "NETWORK"; // fetch threw (offline, DNS, TLS, CORS); see .cause
  static WASM_ALLOC = "WASM_ALLOC"; // wasm arena exhausted
  static WASM_RC = "WASM_RC"; // a wasm export returned non-zero
  static BAD_TREE_PATH = "BAD_TREE_PATH"; // wasm refused a path (defense in depth)
  static BAD_ARG = "BAD_ARG"; // argument has the wrong shape/type, or cannot work here
  static CLOSED = "CLOSED"; // method called on a closed instance

  /// True when `e` is a GitError, optionally restricted to one or more codes.
  /// Variadic on purpose: no codes means "any GitError", one code narrows the
  /// type to that literal, several narrow it to the union — so callers get one
  /// name instead of a separate `is` and `anyOf`.
  static is(e, ...codes) {
    if (e?.[BRAND] !== true) return false;
    return codes.length === 0 || codes.includes(e.code);
  }

  constructor(code, message, extra = {}) {
    super(message);
    this.name = "GitError";
    this.code = code;
    this[BRAND] = true;
    if (extra.cause !== undefined) this.cause = extra.cause;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.key !== undefined) this.key = extra.key;
    if (extra.ref !== undefined) this.ref = extra.ref;
  }
}

/// Throw a GitError. Exported so the client chain never writes a bare
/// `new Error` for a condition a caller may need to branch on.
export function failed(code, message, extra) {
  throw new GitError(code, message, extra);
}

// ── net ──

/// fetch + failure normalization: a thrown fetch becomes NETWORK (original
/// kept in .cause), a non-2xx becomes HTTP with .status. Never returns a
/// non-ok response, so no call site can forget the check.
export async function netFetch(fetchImpl, url, init, what) {
  let r;
  try {
    r = await fetchImpl(url, init);
  } catch (e) {
    failed(GitError.NETWORK, `${what}: ${e?.message ?? e}`, { cause: e });
  }
  if (!r?.ok) failed(GitError.HTTP, `${what} http ${r?.status ?? 0}`, { status: r?.status });
  return r;
}

// ── keys ──

/// Why `key` cannot be stored, or null when it is well-formed.
///
/// A key is a relative, slash-separated path whose every segment is non-empty
/// and is not "." / ".." / ".git". Malformed keys are rejected rather than
/// normalized: the git tree layer turns an empty segment into an *unnamed*
/// tree entry, and two keys sharing one ("" and "/a.txt") silently overwrite
/// each other inside a single putMany batch — a success sha for lost data.
/// Every key accepted by assertKeys can also be read back by getMany.
export function keyProblem(key) {
  if (typeof key !== "string") return "not a string";
  if (!key.length) return "empty";
  if (key.includes("\0")) return "contains NUL";
  if (key.includes("\\")) return "contains a backslash";
  if (/[\u0000-\u001f\u007f]/.test(key)) return "contains a control character";
  if (key.startsWith("/")) return "leading '/' — use a relative path";
  if (key.endsWith("/")) return "trailing '/' — that is a directory, not a key";
  for (const seg of key.split("/")) {
    if (!seg) return "empty path segment ('//')";
    if (seg === "." || seg === "..") return `'${seg}' segment`;
    if (seg === ".git") return "'.git' segment (reserved)";
  }
  return null;
}

/// Throw BAD_KEY listing every bad key at once, so a batch is fixable in one pass.
export function assertKeys(keys) {
  const bad = [];
  for (const k of keys) {
    const why = keyProblem(k);
    if (why) bad.push(`${JSON.stringify(k)} (${why})`);
  }
  if (bad.length) {
    failed(
      GitError.BAD_KEY,
      `invalid key(s): ${bad.join("; ")} — keys are relative paths like "docs/a.md"`,
    );
  }
}

// ── store ──

/// Portable in-memory object store (zero FS, zero node: deps).
/// get(hex) -> Uint8Array|null (loose zlib bytes); put(hex, loose) stores a copy.
///
/// The store interface is SYNCHRONOUS: every method must return a value, not a
/// Promise. It is called from inside wasm host callbacks (host_get_object /
/// host_put_object) and from ref resolution, neither of which can await, so a
/// Promise-returning store does not fail loudly — wasm would read a
/// zero-length object and the instance would write commits it cannot read back.
/// RemoteGit.open probes the store and throws BAD_STORE instead.
export function memoryStore() {
  const objs = new Map();
  const refs = new Map();
  return {
    get(hex) {
      const v = objs.get(String(hex).toLowerCase());
      return v ? v.slice() : null;
    },
    put(hex, loose) {
      objs.set(String(hex).toLowerCase(), Uint8Array.from(loose));
    },
    getRef(name) {
      return refs.get(name) ?? null;
    },
    putRef(name, sha) {
      refs.set(name, sha);
    },
    heads() {
      const out = [];
      for (const k of refs.keys()) if (k.startsWith("refs/heads/")) out.push(k.slice("refs/heads/".length));
      return out;
    },
    dump() {
      return { objects: objs.size, refs: refs.size };
    },
  };
}

const STORE_METHODS = ["get", "put", "getRef", "putRef", "heads"];

/// Verify a custom store satisfies the synchronous interface above, so the
/// failure is a clear BAD_STORE at open() instead of silently-empty reads
/// later. Read paths are probed with sentinel keys (no writes, so nothing is
/// mutated); a probe that throws is not our business and is ignored — we only
/// care that it did not hand back a thenable.
export function assertSyncStore(store) {
  if (!store || typeof store !== "object") {
    failed(GitError.BAD_STORE, `store must be an object with {${STORE_METHODS.join(", ")}}`);
  }
  const missing = STORE_METHODS.filter((k) => typeof store[k] !== "function");
  if (missing.length) {
    failed(
      GitError.BAD_STORE,
      `store is missing ${missing.join(", ")} — it must implement {${STORE_METHODS.join(", ")}}`,
    );
  }
  const probes = [
    ["get", () => store.get("0".repeat(40))],
    ["getRef", () => store.getRef("refs/heads/zig-wasm-git-probe")],
    ["heads", () => store.heads()],
  ];
  for (const [name, call] of probes) {
    let v;
    try {
      v = call();
    } catch {
      continue;
    }
    if (v && typeof v.then === "function") {
      failed(
        GitError.BAD_STORE,
        `store.${name}() returned a Promise — the store interface is synchronous ` +
          `(it is called from wasm host callbacks that cannot await). Buffer the ` +
          `value yourself, or use memoryStore().`,
      );
    }
  }
  return store;
}

// ── codec ──

export function hexOfBytes(b) {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export const joinUrl = (base, path) => base.replace(/\/+$/, "") + path;

/// Wrap a fetch impl so URLs carrying `user:pass@host` credentials are sent
/// as an `Authorization: Basic` header with the credentials stripped from
/// the URL. Some runtimes (notably Cloudflare workerd) drop URL userinfo
/// instead of applying it, so the same URL that works with curl gets a 401
/// from in-worker discovery; stripping also keeps tokens out of downstream
/// logs/proxies. URLs without userinfo pass through untouched, and anything
/// that isn't an absolute URL (e.g. a relative path) delegates as-is.
/// String URLs in, string URLs out (pre-set Authorization wins).
export function withBasicAuth(fetchImpl) {
  return async (url, init) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return fetchImpl(url, init);
    }
    if (!u.username && !u.password) return fetchImpl(url, init);
    const creds = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
    const bytes = enc.encode(creds);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const headers = new Headers(init?.headers);
    if (!headers.has("authorization")) headers.set("authorization", `Basic ${btoa(bin)}`);
    u.username = "";
    u.password = "";
    return fetchImpl(u.toString(), { ...init, headers });
  };
}

/// Concatenate chunks (single alloc). Shared by streamAll/takeEmit.
export function concatU8(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function streamAll(stream, input) {
  const w = stream.writable.getWriter();
  await w.write(input);
  await w.close();
  const chunks = [];
  for await (const c of stream.readable) {
    chunks.push(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
  }
  return concatU8(chunks);
}

/// pack 对象 payload:zlib(body)。直出,无需手工包头/adler。
export async function deflateZlib(body) {
  return streamAll(new CompressionStream("deflate"), body);
}

export async function inflateZlib(zlibBytes) {
  return streamAll(new DecompressionStream("deflate"), zlibBytes);
}

/// loose("type len\0body" zlib) -> {type, body: Uint8Array (copy)}
export async function looseBody(loose) {
  const raw = await inflateZlib(loose instanceof Uint8Array ? loose : new Uint8Array(loose));
  const nul = raw.indexOf(0);
  if (nul < 0) throw new Error("bad loose object");
  const [type, len] = dec.decode(raw.subarray(0, nul)).split(" ");
  const body = raw.subarray(nul + 1);
  if (body.length !== Number(len)) throw new Error("loose length mismatch");
  return { type, body: body.slice() };
}

/// tree body -> [{mode, name, oid(hex)}]
export function parseTreeEntries(body) {
  const u8 = body instanceof Uint8Array ? body : new Uint8Array(body);
  const out = [];
  let i = 0;
  while (i < u8.length) {
    const sp = u8.indexOf(0x20, i);
    const nul = u8.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > u8.length) throw new Error("bad tree body");
    out.push({
      mode: dec.decode(u8.subarray(i, sp)),
      name: dec.decode(u8.subarray(sp + 1, nul)),
      oid: hexOfBytes(u8.subarray(nul + 1, nul + 21)),
    });
    i = nul + 21;
  }
  return out;
}

export function commitParentsAndTree(body) {
  const parents = [];
  let tree = null;
  const text = typeof body === "string" ? body : dec.decode(body instanceof Uint8Array ? body : new Uint8Array(body));
  for (const line of text.split("\n")) {
    if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
    else if (line.startsWith("tree ") && tree === null) tree = line.slice(5, 45);
    else if (line === "") break;
  }
  return { parents, tree };
}

/// Parse a commit body into a log row {sha, tree, parents, author, message}.
/// Shared by portable (async) and Node (sync) log(); keep them in sync.
export function parseCommit(sha, text) {
  const lines = text.split("\n");
  const hdrEnd = lines.indexOf("");
  const headers = lines.slice(0, hdrEnd);
  const message = lines.slice(hdrEnd + 1).join("\n").trim();
  const tree = (headers.find((l) => l.startsWith("tree ")) ?? "").slice(5);
  const parents = headers.filter((l) => l.startsWith("parent ")).map((l) => l.slice(7));
  const authorLine = headers.find((l) => l.startsWith("author ")) ?? "";
  return { sha, tree, parents, author: authorLine.slice(7), message };
}

// ── wire ──

function dv(wasm) {
  return new DataView(wasm.memory.buffer);
}

function allocBytes(wasm, b) {
  if (b.length === 0) return { ptr: 0, len: 0 };
  const ptr = wasm.wasm_alloc(b.length);
  if (!ptr) failed(GitError.WASM_ALLOC, "wasm_alloc failed (heap full; call reset between ops)");
  new Uint8Array(wasm.memory.buffer).set(b, ptr);
  return { ptr, len: b.length };
}

function allocStr(wasm, s) {
  return allocBytes(wasm, enc.encode(s));
}

function readOut(wasm, ptrAddr, lenAddr) {
  const d = dv(wasm);
  const p = d.getUint32(ptrAddr, true);
  const n = d.getUint32(lenAddr, true);
  return new Uint8Array(wasm.memory.buffer.slice(p, p + n));
}

/// Build the v2 ls-refs request body (wasm is source of truth for pkt shape).
export function buildLsRefsReq(wasm) {
  wasm.wasm_reset();
  const p = wasm.wasm_alloc(4);
  const l = wasm.wasm_alloc(4);
  if (wasm.wasm_build_lsrefs(p, l) !== 0) throw new Error("wasm_build_lsrefs failed");
  return readOut(wasm, p, l);
}

/// wants: string|string[] of 40-hex; filter: bare spec ("blob:none") or "".
export function buildFetchReq(wasm, wants, filter = "") {
  wasm.wasm_reset();
  const list = (Array.isArray(wants) ? wants : [wants]).join("\n");
  const w = allocStr(wasm, list);
  const f = allocStr(wasm, filter || "");
  const p = wasm.wasm_alloc(4);
  const l = wasm.wasm_alloc(4);
  const rc = wasm.wasm_build_fetch(w.ptr, w.len, f.ptr, f.len, p, l);
  if (rc !== 0) throw new Error(`wasm_build_fetch rc=${rc}`);
  return readOut(wasm, p, l);
}

/// Parse refs advertisement / v2 ls-refs response via wasm_list_refs.
/// Returns [{oid, name}]. Works for v1 discovery bodies and v2 ls-refs bodies.
export function listRefs(wasm, advertBytes) {
  wasm.wasm_reset();
  const a = allocBytes(wasm, advertBytes);
  const p = wasm.wasm_alloc(4);
  const l = wasm.wasm_alloc(4);
  if (wasm.wasm_list_refs(a.ptr, a.len, p, l) !== 0) throw new Error("wasm_list_refs failed");
  const tlv = readOut(wasm, p, l);
  return decodeRefsTlv(tlv);
}

export function decodeRefsTlv(buf) {
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  const n = d.getUint16(pos, true);
  pos += 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const oid = dec.decode(buf.subarray(pos, pos + 40));
    pos += 40;
    const nlen = d.getUint16(pos, true);
    pos += 2;
    const name = dec.decode(buf.subarray(pos, pos + nlen));
    pos += nlen;
    out.push({ oid, name });
  }
  return out;
}

/// Decode one pack object header at pos (mirrors wasm_decode_pack_header).
/// Returns {type, size, next}. Pure JS (no wasm roundtrip); equivalence with
/// wasm is asserted in tests.
export function decodePackHeaderJS(buf, pos = 0) {
  if (pos >= buf.length) throw new Error("pack header truncated");
  let b = buf[pos++];
  const type = (b >> 4) & 7;
  let size = b & 0x0f;
  let shift = 4;
  while (b & 0x80) {
    if (pos >= buf.length) throw new Error("pack header truncated");
    b = buf[pos++];
    size += (b & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { type, size, next: pos };
}

/// Inflate one zlib stream starting at pos via wasm (single pass, exact
/// consumed — no trial-inflate). Returns {body, consumed}.
/// TODO(大包):每次把 pack 尾部整体拷进 wasm 内存,O(n^2) memcpy。
/// 本库定位小包 blob-store,暂不做窗口化;大仓场景再优化。
export function inflateOne(wasm, buf, pos = 0) {
  wasm.wasm_reset();
  const total = buf.length - pos;
  const inp = wasm.wasm_alloc(total);
  new Uint8Array(wasm.memory.buffer).set(buf.subarray(pos), inp);
  const p = wasm.wasm_alloc(4);
  const l = wasm.wasm_alloc(4);
  const c = wasm.wasm_alloc(4);
  const rc = wasm.wasm_inflate_one(inp, total, p, l, c);
  if (rc !== 0) throw new Error(`wasm_inflate_one rc=${rc} at pack offset ${pos}`);
  const d = dv(wasm);
  const body = new Uint8Array(wasm.memory.buffer.slice(d.getUint32(p, true), d.getUint32(p, true) + d.getUint32(l, true)));
  return { body, consumed: d.getUint32(c, true) };
}

/// Apply a git delta (base + delta -> result) via wasm.
export function deltaApply(wasm, base, deltaBytes) {
  wasm.wasm_reset();
  const b = allocBytes(wasm, base);
  const d = allocBytes(wasm, deltaBytes);
  const p = wasm.wasm_alloc(4);
  const l = wasm.wasm_alloc(4);
  const rc = wasm.wasm_delta_apply(b.ptr, b.len, d.ptr, d.len, p, l);
  if (rc !== 0) throw new Error(`wasm_delta_apply rc=${rc}`);
  return readOut(wasm, p, l);
}
