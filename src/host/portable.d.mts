// Type definitions for zig-wasm-git (RemoteGit).

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
 * host callbacks that cannot await. `RemoteGit.open` throws `TypeError` if a
 * method returns a Promise.
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
 * The only operational error this library throws. Branch on `.kind`.
 * Programmer mistakes throw `TypeError`, never `GitError`.
 */
export class GitError<C extends GitErrorCode = GitErrorCode> extends Error {
  readonly name: "GitError";
  readonly kind: GitErrorKind;
  readonly code: C;
  readonly cause?: unknown;
  readonly status?: number;
  readonly ref?: string;
  readonly key?: string;
  constructor(
    kind: GitErrorKind,
    code: C,
    message: string,
    extra?: { cause?: unknown; status?: number; key?: string; ref?: string },
  );
  static is(e: unknown): e is GitError;
  static isIO(e: unknown): e is GitError<GitIOCode>;
  static isProtocol<C2 extends GitProtocolCode>(e: unknown, ...codes: C2[]): e is GitError<C2>;
  static isProtocol(e: unknown): e is GitError<GitProtocolCode>;
}

export function keyProblem(key: string): string | null;

/** Options for {@link RemoteGit.open}. */
export interface RemoteGitOptions {
  wasm?: WasmInput;
  /** Branch to bind. A short name (`main`) or a full ref. Default `main`. */
  ref?: string;
  /** Raw `Authorization` header value. URLs with `user:pass@` also work. */
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
  /** Compare-and-swap: throw `CAS_MISMATCH` unless the tip still equals this oid. */
  parent?: string;
}

/** Options for {@link RemoteGit.getMany}. */
export interface GetOptions {
  /** `true` reads strictly from the local store: no I/O. Default `false`. */
  local?: boolean;
  /** `"text"` decodes each value as UTF-8, returning `Map<string, string>`. */
  as?: "bytes" | "text";
}

/** Options for {@link RemoteGit.get}. Same as {@link GetOptions} but single-key. */
export interface GetOneOptions extends GetOptions {}

/** Options for {@link RemoteGit.list}. */
export interface ListOptions {
  /** `true` enumerates strictly from the local store (no I/O). Default `false`. */
  local?: boolean;
}

/** Options for {@link RemoteGit.pull}. A bare filter string works too. */
export interface PullOptions {
  /** Partial-clone filter, e.g. `"blob:none"`. Empty means a full pull. */
  filter?: string;
}

/** Options for {@link RemoteGit.push}. Only test/proxy injection — no filter. */
export interface PushOptions {
  /** Custom fetch implementation (proxies, instrumentation, tests). */
  fetchImpl?: typeof fetch;
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
  cached?: boolean;
  refs: { oid: string; name: string }[];
}

/** Result of {@link RemoteGit.push}. */
export interface PushResult {
  updated: boolean;
  ref: string;
  old: string;
  new: string;
  reason?: string;
  objects?: number;
  packBytes?: number;
}

/**
 * A git remote as a versioned blob store: one branch is one keyspace
 * (`path -> bytes`), one commit is one version.
 */
export class RemoteGit {
  static open(url: string, opts?: RemoteGitOptions): Promise<RemoteGit>;
  readonly url: string;
  readonly ref: string;
  /** The object store behind this instance (share it across instances). */
  readonly store: Store;

  /** Local tip oid, or null when the keyspace is empty. Never hits the network. */
  version(): string | null;

  /** Remote tip oid without touching the store. Null when the ref is absent remotely. */
  remoteVersion(): Promise<string | null>;

  /** Read keys as bytes. Missing keys are skipped. May hit the network. */
  getMany(paths: string | string[] | Iterable<string>, opts?: GetOptions & { as?: "bytes" }): Promise<Map<string, Uint8Array>>;
  /** Read keys as text. Missing keys are skipped. May hit the network. */
  getMany(paths: string | string[] | Iterable<string>, opts: GetOptions & { as: "text" }): Promise<Map<string, string>>;

  /** Single-key read: bytes (or string with `{ as: "text" }`), null when absent. */
  get(path: string, opts?: GetOptions & { as?: "bytes" }): Promise<Uint8Array | null>;
  get(path: string, opts: GetOptions & { as: "text" }): Promise<string | null>;

  /** Small-keyspace convenience: list + getMany in one call. */
  readAll(prefix?: string, opts?: GetOptions & { as?: "bytes" }): Promise<Map<string, Uint8Array>>;
  readAll(prefix: string, opts: GetOptions & { as: "text" }): Promise<Map<string, string>>;

  /**
   * Write keys as one version (commit); returns the new sha.
   * Upsert only (see {@link RemoteGit.removeMany} for deletes).
   * Pass a parent oid (or `{ parent }`) for compare-and-swap.
   */
  putMany(
    entries: Record<string, string | Uint8Array | ArrayBuffer | ArrayBufferView> | Map<string, string | Uint8Array | ArrayBuffer | ArrayBufferView>,
    message?: string,
    parentOrOptions?: string | PutOptions,
  ): Promise<string>;

  /**
   * Delete keys as one version (commit); returns the new sha.
   * Missing keys are a no-op. Empty dirs are pruned. Same CAS contract as putMany.
   */
  removeMany(
    paths: string | string[] | Iterable<string>,
    message?: string,
    parentOrOptions?: string | PutOptions,
  ): Promise<string>;

  /** Enumerate keys as `[{path, oid}]`, optionally filtered by prefix. */
  list(prefix?: string, opts?: ListOptions): Promise<Entry[]>;

  /** Recent history, newest first. Local only. */
  log(limit?: number): Promise<Commit[]>;

  /** Refresh from the remote. No merge: push local writes first. */
  pull(opts?: PullOptions | string): Promise<PullResult>;

  /** Publish the local tip. Fast-forward only. */
  push(opts?: PushOptions): Promise<PushResult>;
}
