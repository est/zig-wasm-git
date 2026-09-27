// Type definitions for zig-wasm-git (RemoteGit).
// Hand-written to match src/host/portable.mjs — the public surface is small
// enough that this stays readable, and it avoids a TS build step in the
// release pipeline (the published artefact is plain .mjs + this file).

/** Anything `WebAssembly.instantiate` accepts directly. */
export type WasmInput =
  | string
  | WebAssembly.Module
  | ArrayBuffer
  | ArrayBufferView;

/** Loose object bytes: zlib-compressed `"<type> <len>\0<body>"`. */
export type LooseBytes = Uint8Array;

/**
 * Pluggable object storage. **Must be synchronous** — it is called from wasm
 * host callbacks that cannot await, so a Promise-returning store writes
 * commits it cannot read back. `RemoteGit.open` throws `TypeError` if this
 * contract is broken.
 */
export interface Store {
  /** Loose object bytes by hex oid, or null when absent. */
  get(hex: string): LooseBytes | null;
  /** Store loose object bytes under a hex oid. */
  put(hex: string, loose: LooseBytes): void;
  /** Commit oid for a ref name (`refs/heads/main`), or null. */
  getRef(name: string): string | null;
  /** Point a ref at a commit oid. */
  putRef(name: string, sha: string): void;
  /** Short branch names, without the `refs/heads/` prefix. */
  heads(): string[];
  /** Optional: whatever the backend wants to report about itself. */
  dump?(): unknown;
}

/** In-memory store. Append-only: objects are never evicted. */
export function memoryStore(): Store;

/** Transport failure codes (`kind === "io"`). Retry later. */
export type GitIOCode = "NETWORK" | "HTTP";

/** Server refusal codes (`kind === "protocol"`). Fix the request. */
export type GitProtocolCode =
  | "CAS_MISMATCH"
  | "NON_FAST_FORWARD"
  | "PUSH_REJECTED"
  | "UNPACK_FAILED"
  | "NO_V2"
  | "NO_REMOTE_REF"
  | "NO_SUCH_OBJECT"
  | "PROTOCOL_ERROR";

/** One of the `GitError` codes. Also spelled `GitError["code"]`. */
export type GitErrorCode = GitIOCode | GitProtocolCode;

/** Which half of the world failed: transport (`io`) or server (`protocol`). */
export type GitErrorKind = "io" | "protocol";

/**
 * The only operational error this library throws. Branch on `.kind`:
 *
 * ```ts
 * import { GitError } from "zig-wasm-git";
 *
 * try { await git.push(); }
 * catch (e) {
 *   if (GitError.isIO(e)) retryLater(e.status);
 *   else if (GitError.isProtocol(e, "NON_FAST_FORWARD")) await git.pull();
 *   else throw e; // TypeError / Error: fix the code, don't retry
 * }
 * ```
 *
 * Programmer mistakes (bad key, bad arg, bad store, use-after-close) throw
 * `TypeError`, never `GitError` — don't catch them as retryable. Internal
 * invariants throw plain `Error`. The generic parameter narrows `.code` and
 * is normally inferred; write `GitError<"HTTP">` only to annotate a variable
 * that must hold one specific code.
 */
export class GitError<C extends GitErrorCode = GitErrorCode> extends Error {
  readonly name: "GitError";
  readonly kind: GitErrorKind;
  readonly code: C;
  /** Original error, when this one wraps something (`NETWORK`, `PROTOCOL_ERROR`). */
  readonly cause?: unknown;
  /** HTTP status, when `code === "HTTP"`. */
  readonly status?: number;
  /** Ref or key the failure concerns, when relevant. */
  readonly ref?: string;
  readonly key?: string;
  constructor(
    kind: GitErrorKind,
    code: C,
    message: string,
    extra?: { cause?: unknown; status?: number; key?: string; ref?: string },
  );

  /**
   * True when `e` is a GitError from any copy of this module (the npm package
   * and the single-file release bundle are separate classes; `instanceof`
   * fails across them, this brand check does not).
   */
  static is(e: unknown): e is GitError;
  /** True for transport failures. Retry later. */
  static isIO(e: unknown): e is GitError<GitIOCode>;
  /**
   * True for server refusals, optionally restricted to codes.
   * `isProtocol(e, "NON_FAST_FORWARD")` narrows `e.code` to that literal.
   */
  static isProtocol<C2 extends GitProtocolCode>(e: unknown, ...codes: C2[]): e is GitError<C2>;
  static isProtocol(e: unknown): e is GitError<GitProtocolCode>;
}

/**
 * Why `key` cannot be stored, or null when it is a well-formed key.
 *
 * A key is a relative, slash-separated path whose segments are non-empty and
 * are not `.`, `..` or `.git`. Malformed keys throw `TypeError` rather than
 * being normalized, because the git tree layer turns an empty segment into an
 * unnamed entry that can silently overwrite a sibling key.
 */
export function keyProblem(key: string): string | null;

/** Options for {@link RemoteGit.open}. */
export interface RemoteGitOptions {
  /**
   * Where to get the wasm engine.
   *
   * - omitted: `zig_wasm_git.wasm` **next to this module** (true for an npm
   *   install, where the two files ship together). Needs a filesystem, so on
   *   Node that means 22.3+ (`process.getBuiltinModule`)
   * - string starting with `http(s)://`: fetched
   * - any other string: a filesystem path (Node 22.3+ only)
   * - `WebAssembly.Module` / bytes: passed straight to `instantiate`
   *
   * workerd has no filesystem, so pass its `CompiledWasm` explicitly. A
   * filesystem path on a runtime without one throws `TypeError`.
   */
  wasm?: WasmInput;
  /** Branch to bind. A short name (`main`) or a full ref. Default `main`. */
  ref?: string;
  /** Default author for writes: `"Name <email>"`. Per-write options win. */
  author?: string;
  /** Default committer for writes. Defaults to `author`. */
  committer?: string;
  /** Default timezone for writes, e.g. `"+0800"`. Default `"+0000"`. */
  timezone?: string;
  /** `"user:pass"` becomes Basic; anything else is used verbatim. */
  auth?: string;
  /** Object storage. Default {@link memoryStore}. Must be synchronous. */
  store?: Store;
  /** Custom fetch implementation (proxies, instrumentation, tests). */
  fetchImpl?: typeof fetch;
  /** Custom `crypto.subtle` implementation. */
  subtle?: SubtleCrypto;
}

/** Per-write overrides for {@link RemoteGit.putMany}. */
export interface PutOptions {
  /**
   * Compare-and-swap: throw `CAS_MISMATCH` unless the tip still equals this
   * oid. Costs no extra roundtrip — the check is local.
   *
   * Note `version()` is `string | null`: check for null before passing it. A
   * null/undefined parent means "no check", so handing it straight through
   * would turn a CAS write into an unguarded one.
   */
  parent?: string;
  author?: string;
  committer?: string;
  /** Unix seconds. Default: now. */
  time?: number;
  timezone?: string;
}

/** Options for {@link RemoteGit.getMany}. */
export interface GetOptions {
  /**
   * `true` reads strictly from the local store: no bootstrap, no on-demand
   * fetch, no I/O. Default `false`, which lets a read fill a cold store.
   */
  local?: boolean;
}

/** Options for {@link RemoteGit.getMany} when decoding text. */
export interface GetTextOptions extends GetOptions {
  as: "text";
}

/** Options for {@link RemoteGit.list}. */
export interface ListOptions {
  /**
   * `true` enumerates strictly from the local store (no bootstrap, no I/O) and
   * returns `[]` when the tip is not cached. Default `false`.
   */
  local?: boolean;
}

/** Options for {@link RemoteGit.pull}. */
export interface PullOptions {
  /**
   * Partial-clone filter, e.g. `"blob:none"`, `"blob:limit=1k"`, `"tree:0"`,
   * `"object:type=commit"`, combined with `"+"`. Empty means a full pull.
   */
  filter?: string;
}

/** Options for {@link RemoteGit.sync}. */
export interface SyncOptions {
  /** Forwarded to the pull step. */
  pull?: PullOptions;
  /** Forwarded to the read step: `true` reads from cache only. */
  local?: boolean;
}

/** Result of {@link RemoteGit.list}. */
export interface Entry {
  path: string;
  /** Blob oid, hex. */
  oid: string;
}

/** One commit, as returned by {@link RemoteGit.log}. */
export interface Commit {
  sha: string;
  tree: string;
  parents: string[];
  /** Full author line, e.g. `"bot <bot@x> 1755859200 +0000"`. */
  author: string;
  message: string;
}

/** Result of {@link RemoteGit.pull}. */
export interface PullResult {
  ref: string | null;
  oid: string;
  oids: string[];
  objects: number;
  packBytes: number;
  shallow: string[];
  /** True when the wanted object was already stored and nothing was fetched. */
  cached?: boolean;
  refs: { oid: string; name: string }[];
}

/** Result of {@link RemoteGit.push}. */
export interface PushResult {
  updated: boolean;
  ref: string;
  old: string;
  new: string;
  /** Set when `updated` is false. */
  reason?: string;
  objects?: number;
  packBytes?: number;
}

/**
 * A git remote as a versioned blob store: one branch is one keyspace
 * (`path -> bytes`), one commit is one version.
 *
 * Always construct with {@link RemoteGit.open}; instantiation is async. Every
 * method is async and shares one queue, so they have a single ordering.
 *
 * Operational failures throw `GitError` (`kind: "io"` → retry,
 * `kind: "protocol"` → fix the request). Programmer mistakes (bad keys,
 * bad args, bad store, use-after-close) throw `TypeError`.
 */
export class RemoteGit {
  /**
   * Boot the wasm engine and return a usable instance. Throws `TypeError` if a
   * custom store breaks the synchronous contract.
   */
  static open(url: string, opts?: RemoteGitOptions): Promise<RemoteGit>;

  /**
   * Prefer {@link RemoteGit.open}. An instance built this way has no wasm, so
   * every method throws `TypeError`.
   */
  constructor(url: string, opts?: RemoteGitOptions);

  /** The remote this instance is bound to. */
  readonly url: string;
  /** Fully-qualified ref, e.g. `refs/heads/main`. */
  readonly ref: string;
  /** True once {@link RemoteGit.close} has run. */
  readonly closed: boolean;

  /** Local tip oid, or null when the keyspace is empty. Never hits the network. */
  version(): Promise<string | null>;

  /**
   * Remote tip oid without touching the store. Null when the ref does not
   * exist remotely; throws `GitError` (`io` / `NO_V2`) on failure.
   */
  remoteVersion(): Promise<string | null>;

  /**
   * Read keys as bytes. Keys absent from the keyspace are skipped (no entry in
   * the Map) — that is a real answer, not a failure. A transport or protocol
   * failure is thrown, never reported as an empty Map.
   *
   * May hit the network: a cold store bootstraps structure, and a key whose
   * blob is not cached costs one batched `want=[oids]` roundtrip. Pass
   * `{ local: true }` to stay offline.
   */
  // Byte form first: TypeScript picks the first matching overload, and
  // `as: "text"` alone does not rule out the default signature.
  getMany(paths: string | Iterable<string>, opts?: GetOptions & { as?: "bytes" }): Promise<Map<string, Uint8Array>>;
  getMany(paths: string | Iterable<string>, opts: GetTextOptions): Promise<Map<string, string>>;

  /**
   * Write keys as one version (commit) on the current tip; returns the new
   * commit sha. `entries` is an object of `{ path: content }` (a `Map` also
   * works); content is a `string` or `Uint8Array`/`ArrayBuffer`.
   *
   * Upsert only — there is no delete. Keys are validated up front and a
   * malformed one throws `TypeError` before anything is written. Pass
   * `{ parent }` for compare-and-swap.
   */
  putMany(
    entries: Record<string, string | Uint8Array | ArrayBuffer | ArrayBufferView> | Map<string, string | Uint8Array | ArrayBuffer | ArrayBufferView>,
    message?: string,
    options?: PutOptions,
  ): Promise<string>;

  /**
   * Enumerate keys as `[{path, oid}]`, optionally filtered by prefix. Returns
   * `[]` for a genuinely empty keyspace; throws on a transport failure.
   */
  list(prefix?: string, opts?: ListOptions): Promise<Entry[]>;

  /** Recent history, newest first. Local only — never hits the network. */
  log(limit?: number): Promise<Commit[]>;

  /** Refresh from the remote. No merge: push local writes first. */
  pull(opts?: PullOptions): Promise<PullResult>;

  /**
   * Publish the local tip. Fast-forward only: a non-descendant push throws
   * `GitError` (`NON_FAST_FORWARD`) and you should pull and rewrite.
   */
  push(opts?: Partial<PullOptions>): Promise<PushResult>;

  /** One-shot: pull latest, then return the requested keys. */
  sync(paths: string | Iterable<string>, opts?: SyncOptions): Promise<Map<string, Uint8Array>>;

  /**
   * Release the wasm instance and its ~5MB arena. Waits for in-flight work
   * first; idempotent; does not clear the store. Methods after this throw
   * `TypeError`.
   */
  close(): Promise<void>;
}
