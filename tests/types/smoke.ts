// Type-level test for the published declarations (src/host/portable.d.mts).

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
  GitIOCode,
  GitProtocolCode,
} from "../../src/host/portable.mjs";

export async function positive(): Promise<void> {
  const git = await RemoteGit.open("https://git.example.com/team/docs.git", {
    wasm: "zig-out/bin/zig_wasm_git.wasm",
    ref: "main",
    auth: "Bearer token",
    store: memoryStore(),
    fetchImpl: fetch,
    subtle: crypto.subtle,
  });

  const bytes: Map<string, Uint8Array> = await git.getMany(["a.txt", "b.bin"]);
  const offline: Map<string, Uint8Array> = await git.getMany(["a.txt"], { local: true });
  const fromSet: Map<string, Uint8Array> = await git.getMany([...new Set(["a.txt"])]);

  const sha: string = await git.putMany({ "a.txt": "hi", "b.bin": new Uint8Array([1]) });
  const withOpts: string = await git.putMany(
    new Map([["a.txt", "hi"]]),
    "message",
    { parent: sha },
  );
  const withParent: string = await git.putMany({ "a.txt": "hi" }, "message", sha);

  const keys: Entry[] = await git.list();
  const prefixed: Entry[] = await git.list("docs/", { local: true });
  const history: Commit[] = await git.log(5);
  const tip: string | null = git.version();
  const remoteTip: string | null = await git.remoteVersion();
  const pulled: PullResult = await git.pull({ filter: "blob:none" });
  const pulled2: PullResult = await git.pull("blob:none");
  const pushed: PushResult = await git.push();

  const problem: string | null = keyProblem("a/b.txt");
  const ioCode: GitIOCode = "NETWORK";
  const protoCode: GitProtocolCode = "NON_FAST_FORWARD";
  const code: GitErrorCode = ioCode;

  void [bytes, offline, fromSet, withOpts, withParent, prefixed, history, tip, remoteTip, pulled.cached, pulled2, pushed.updated, problem, code, protoCode];
}

export async function branching(): Promise<void> {
  const git = await RemoteGit.open("https://x/r.git");
  try {
    const tip = git.version();
    if (tip) await git.putMany({ "a.txt": "v2" }, "cas", { parent: tip });
  } catch (e) {
    if (GitError.is(e)) {
      const anyCode: GitErrorCode = e.code;
      void [anyCode, e.kind, e.message, e.cause, e.status, e.ref, e.key];
    }
    if (GitError.isIO(e)) {
      const narrowed: GitIOCode = e.code;
      // @ts-expect-error io codes are NETWORK|HTTP, not a protocol refusal
      const wrong: "CAS_MISMATCH" = e.code;
      void [narrowed, wrong, e.status];
    }
    if (GitError.isProtocol(e, "CAS_MISMATCH")) {
      const narrowed: "CAS_MISMATCH" = e.code;
      // @ts-expect-error narrowed to the one code asked for, not the union
      const asHttp: "HTTP" = e.code;
      void [narrowed, asHttp];
    }
    const typed: GitError<"NETWORK"> | null = GitError.isIO(e) && e.code === "NETWORK" ? e : null;
    // @ts-expect-error the default instantiation is not a specific code
    const overNarrowed: GitError<"NETWORK"> = null as unknown as GitError;
    void [typed, overNarrowed];
  }
}

export function stores(): void {
  const minimal: Store = {
    get: () => null,
    put: () => {},
    getRef: () => null,
    putRef: () => {},
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
  // @ts-expect-error second arg must be a message string
  await git.getMany(["a.txt"], "text");
  // @ts-expect-error version() takes no arguments
  git.version(1);
  // @ts-expect-error first arg must be unknown, codes must be protocol codes
  GitError.isProtocol(new Error(), "NOPE");
  // @ts-expect-error keyProblem takes a string
  keyProblem(1);
  // @ts-expect-error list() takes a prefix, not a number
  await git.list(5);
  // @ts-expect-error unknown error code in the union
  const bad: GitErrorCode = "BAD_STORE_TYPO";
  // @ts-expect-error GitError takes kind, code and message
  void new GitError();
  void bad;
}
