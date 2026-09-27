// Type-level test for the published declarations (src/host/portable.d.mts).
// Run by CI: `tsc --noEmit --strict`. It imports the source module by relative
// path so it checks the real declarations, not a copy.
//
// This file is never executed — it is compiled and thrown away. Every
// `@ts-expect-error` is an assertion: if the type stops rejecting that line,
// tsc fails and CI catches the regression.

import { RemoteGit, memoryStore, GitError, keyProblem } from "../../src/host/portable.mjs";
import type {
  Store,
  Entry,
  Commit,
  PullResult,
  PushResult,
  RemoteGitOptions,
  PutOptions,
  GitErrorCode,
} from "../../src/host/portable.mjs";

export async function positive(): Promise<void> {
  const git = await RemoteGit.open("https://git.example.com/team/docs.git", {
    wasm: "zig-out/bin/zig_wasm_git.wasm",
    ref: "main",
    author: "bot <bot@example.com>",
    auth: "user:pass",
    store: memoryStore(),
    fetchImpl: fetch,
    subtle: crypto.subtle,
  });

  // reads: bytes by default, strings with as:"text", one key or many
  const bytes: Map<string, Uint8Array> = await git.getMany(["a.txt", "b.bin"]);
  const text: Map<string, string> = await git.getMany(["a.txt"], { as: "text" });
  const single: Map<string, Uint8Array> = await git.getMany("a.txt");
  const offline: Map<string, Uint8Array> = await git.getMany(["a.txt"], { local: true });
  const fromSet: Map<string, Uint8Array> = await git.getMany(new Set(["a.txt"]));

  // writes: object or Map, string or bytes, with per-write overrides
  const sha: string = await git.putMany({ "a.txt": "hi", "b.bin": new Uint8Array([1]) });
  const withOpts: string = await git.putMany(
    new Map([["a.txt", "hi"]]),
    "message",
    { parent: sha, author: "x <x@y>", time: 1755859200, timezone: "+0800" },
  );

  const keys: Entry[] = await git.list();
  const prefixed: Entry[] = await git.list("docs/", { local: true });
  const history: Commit[] = await git.log(5);
  const tip: string | null = await git.version();
  const remoteTip: string | null = await git.remoteVersion();
  const pulled: PullResult = await git.pull({ filter: "blob:none" });
  const pushed: PushResult = await git.push();
  const synced: Map<string, Uint8Array> = await git.sync(["a.txt"], { pull: { filter: "blob:none" } });

  const problem: string | null = keyProblem("a/b.txt");
  const code: GitErrorCode = GitError.NETWORK;
  const closed: boolean = git.closed;
  await git.close();

  void [bytes, text, single, offline, fromSet, withOpts, prefixed, history, tip, remoteTip, pulled.cached, pushed.updated, synced, problem, code, closed];
}

export async function branching(): Promise<void> {
  const git = await RemoteGit.open("https://x/r.git");
  try {
    // @ts-expect-error version() is `string | null`, and a null parent would
    // silently disable the compare-and-swap rather than check it
    await git.putMany({ "a.txt": "v2" }, "cas", { parent: await git.version() });
    const tip = await git.version();
    if (tip) await git.putMany({ "a.txt": "v2" }, "cas", { parent: tip });
  } catch (e) {
    // no codes: any GitError, code stays the full union
    if (GitError.is(e)) {
      const anyCode: GitErrorCode = e.code;
      void [anyCode, e.message, e.cause, e.status, e.ref, e.key];
    }
    // one code: narrows to that literal
    if (GitError.is(e, "CAS_MISMATCH")) {
      const narrowed: "CAS_MISMATCH" = e.code;
      // @ts-expect-error narrowed to the one code asked for, not the union
      const asHttp: "HTTP" = e.code;
      void [narrowed, asHttp];
    }
    // several codes: narrows to their union, not to one of them
    if (GitError.is(e, "NETWORK", "HTTP")) {
      const narrowed: "NETWORK" | "HTTP" = e.code;
      // @ts-expect-error neither of the codes asked for
      const wrong: "CAS_MISMATCH" = e.code;
      void [narrowed, wrong, e.status];
    }
    // the generic is annotatable when a variable must hold one specific code
    const typed: GitError<"NETWORK"> | null = GitError.is(e, "NETWORK") ? e : null;
    // @ts-expect-error the default instantiation is not a specific code
    const overNarrowed: GitError<"NETWORK"> = null as unknown as GitError;
    void [typed, overNarrowed];
    // statics are the codes themselves, usable where a literal is expected
    const fromStatic: "CAS_MISMATCH" = GitError.CAS_MISMATCH;
    void fromStatic;
    // @ts-expect-error a static is not callable — use GitError.is
    void GitError.CAS_MISMATCH();
  }
  await git.close();
}

export function stores(): void {
  const minimal: Store = {
    get: () => null,
    put: () => {},
    getRef: () => null,
    putRef: () => {},
    heads: () => [],
  };
  const opts: RemoteGitOptions = { store: minimal };
  const put: PutOptions = { parent: "0".repeat(40) };
  void [opts, put, memoryStore()];
}

export async function rejects(): Promise<void> {
  const git = await RemoteGit.open("https://x/r.git");

  // @ts-expect-error content must be a string or bytes, not a plain object
  await git.putMany({ "a.txt": {} });
  // @ts-expect-error unknown pull option
  await git.pull({ nope: 1 });
  // @ts-expect-error as:"text" belongs in the options object
  await git.getMany(["a.txt"], "text");
  // @ts-expect-error version() takes no arguments
  await git.version(1);
  // @ts-expect-error not a GitErrorCode
  GitError.is(new Error(), "NOPE");
  // @ts-expect-error keyProblem takes a string
  keyProblem(1);
  // @ts-expect-error list() takes a prefix, not a number
  await git.list(5);
  // @ts-expect-error unknown error code in the union
  const bad: GitErrorCode = "BAD_STORE_TYPO";
  // @ts-expect-error GitError takes a code and a message
  void new GitError();
  void bad;
}
