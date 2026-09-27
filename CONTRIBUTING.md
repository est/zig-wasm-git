# Contributing


## Layout

```
src/zig/    the protocol engine: pure Zig, no libc, compiled to wasm32-freestanding
src/host/   the JS side: RemoteGit facade, fetch/compression/crypto, pluggable store
tests/      zig unit tests + wasm/protocol e2e, incl. a test-only git http server
scripts/    build, test and dependency-vendoring helpers
```

The split is a hard constraint, not a preference: **the wasm side does
protocol work and the JS side does IO and platform ABIs.** A `node:` import
leaking into `src/host/` portable.mjs / sync.mjs / utils.mjs is caught by the
CI bundle step, which builds with `--platform=neutral` precisely so that a
static `node:` import fails the build.

## Prerequisites

Zig 0.16.x. Either install it system-wide, or vendor it into the repo:

```bash
./scripts/fetch-deps.sh   # vendors zig (+ wabt/wasmtime) into ./third_party
```

`tests/run.sh` and `scripts/e2e.sh` prefer a system `zig` and fall back to
`./third_party/zig/zig`. Nothing else is required for the test suite — no npm
dependencies. `npm run build` fetches `esbuild` via `npx` on demand.

## Build & test

```bash
./tests/run.sh              # zig unit + wasm/filter/pull/push/remote e2e (git-verified)
npm run test                # same thing
PORT=3002 ./scripts/e2e.sh  # smart HTTP e2e with a real `git` client
npm run build               # assemble dist/ (wasm + bundled JS + declarations)
```

`npm run build` (also wired to `prepack`) produces `dist/`: the esbuild bundle,
the wasm, and the `.d.mts`. **The wasm has to land next to the bundle** — that
is where `RemoteGit` looks when the `wasm` option is omitted, and `scripts/build-npm.sh`
enforces the layout.

The e2e tests are the interesting ones. `tests/server.mjs` is a git http server
that shells out to real `git`; the client chain under test never does. Tests
assert byte-exact agreement with `git cat-file` and `git fsck --strict` on
whatever the client wrote, so a subtly wrong tree or pack fails the suite rather
than passing and corrupting someone's remote.

## What CI checks

On every push and PR: zig unit tests, the wasm filter tests, push/pull/remote
e2e, an esbuild bundle with a source-vs-bundle parity smoke test, `npm pack`
installed into a scratch project and exercised, and `tsc --noEmit --strict` over
the shipped declarations. A broken package fails CI rather than reaching a user.

## Versioning & release flow

SemVer. `package.json` is the version of record for npm; `build.zig.zon` carries
the same number. To cut a release:

1. Bump `version` in `package.json` **and** `build.zig.zon` to `X.Y.Z`
2. Rename the `[Unreleased]` heading in `CHANGELOG.md` to `[X.Y.Z] — <date>`
3. `git tag vX.Y.Z && git push origin main vX.Y.Z`
4. `npm publish`

The tag is what CI releases on GitHub; npm is a separate manual step, so the
two can be done in either order. Tagging triggers the release workflow: build →
bundle JS (pinned esbuild, no repo deps) → test → publish
`zig_wasm_git.wasm` + `zig_wasm_git.portable.mjs` (+ `SHA256SUMS`) to GitHub
Releases under fixed names.

> npm publishes are **irreversible**: a version, once used, cannot be reused,
> and a name cannot be released again for 72 hours after an unpublish.

`CHANGELOG.md` is written for people using the library, not for reviewers. Lead
with what a caller has to change, not with what the diff touched.

## Design rules worth knowing before you patch

- **A missing key is a skip, a transport failure is a throw.** Never let a
  dropped connection read as "this key does not exist" — that ambiguity is the
  one bug class this library is built to avoid. New error paths go through
  `failed(GitError.X, ...)` in `src/host/utils.mjs`, never a raw `throw`.
- **Adding an error code means touching two lists.** The statics on `GitError`
  and their mirrors in `src/host/portable.d.mts` are both hand-written, because
  one is runtime and one is types. `tests/test_remote.mjs` parses the `.d.mts`
  and diffs it against the class, so forgetting one fails the suite.
- **Validate before you write.** `putMany` checks every key up front so a
  rejected batch has no side effects; `open()` probes a custom store's sync
  contract before instantiating wasm. Same reasoning: fail before the expensive
  or the irreversible step.
- **A custom `store` must be synchronous** because it is called from wasm host
  callbacks that cannot await. Making it async is a real feature request, not a
  small refactor — see the limits in the README.
- **The queue exists because wasm memory is shared.** `RemoteGit` serializes
  every public method through one tail promise, including the purely local
  `log()`, so the ordering guarantee is uniform. Keep it that way.
