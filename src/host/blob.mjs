// src/host/blob.mjs — blob-service facade over the git-backed repo.
//
// Standpoint: the remote git repo is a versioned blob store, not a
// developer workspace. Callers think in keys and bytes:
//
//   read(path) -> bytes | null        // missing key is null, not an error
//   write({path: bytes}, message) -> version (commit sha, ref tip moves)
//   pull(url) / publish(url)          // network sync; no workdir, no merge
//
// Git internals (refs/sha1/trees/packs) stay underneath: `repo` from
// portable.mjs (all runtimes) or api.mjs (Node) is the only dependency.
// Zero `node:` imports — same file runs in browsers / CF Workers.
//
// Keyspace model: one branch == one keyspace (default refs/heads/main).
// Each write is a full-snapshot commit of the given keys on top of the
// current tip (last-writer-wins; push rejects on non-fast-forward).

const enc = new TextEncoder();
const dec = new TextDecoder();

const toU8 = (v) => (v instanceof Uint8Array ? v : enc.encode(String(v ?? "")));

export function createBlobService(repo, opts = {}) {
  const shortRef = opts.ref ?? "main";
  const fullRef = shortRef.startsWith("refs/") ? shortRef : `refs/heads/${shortRef}`;
  const filter = opts.filter ?? "";

  function version() {
    try {
      return repo.resolveRef(fullRef);
    } catch {
      return null;
    }
  }

  function pickOne(rows, path) {
    const row = rows.find((r) => r.path === path);
    if (!row || row.error) return null;
    return row.content instanceof Uint8Array ? row.content : new Uint8Array(row.content ?? []);
  }

  function read(path) {
    const tip = version();
    if (!tip) return null;
    return pickOne(repo.get(fullRef, [path]), path);
  }

  function readText(path) {
    const b = read(path);
    return b == null ? null : dec.decode(b);
  }

  function readMany(paths) {
    const tip = version();
    const out = new Map();
    if (!tip || !paths.length) return out;
    for (const row of repo.get(fullRef, paths)) {
      if (!row.error) out.set(row.path, row.content);
    }
    return out;
  }

  function write(files, message = "update", options = {}) {
    const entries = {};
    for (const [path, content] of Object.entries(files ?? {})) {
      entries[path] = content instanceof Uint8Array ? content : toU8(content);
    }
    const parent = version() ?? "";
    return repo.commit(parent, message, entries, fullRef, options);
  }

  function writeText(path, text, message = "update", options = {}) {
    return write({ [path]: enc.encode(String(text)) }, message, options);
  }

  // Network: pull == fetch remote tip into local store (plus ref update).
  function pull(url, pullOpts = {}) {
    return repo.fetch(url, fullRef, { filter, ...pullOpts });
  }

  // Network: publish == push local tip (fast-forward only; rejects otherwise).
  function publish(url, publishOpts = {}) {
    return repo.push(url, fullRef, publishOpts);
  }

  // One-shot blob sync: pull latest, then return the requested keys.
  // No merge: local unpushed writes must be published first, else the
  // fetch moves the ref tip underneath them (they stay reachable by sha).
  async function sync(url, paths, syncOpts = {}) {
    await pull(url, syncOpts.pull ?? {});
    return readMany(paths ?? []);
  }

  return { ref: fullRef, filter, version, read, readText, readMany, write, writeText, pull, publish, sync };
}
