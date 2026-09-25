// src/host/store.mjs — portable in-memory object store (zero FS, zero node: deps).
// Same interface as the Node fileStore; works in Node/Browser/Workers.
// get(hex) -> Uint8Array|null (loose zlib bytes); put(hex, loose) stores a copy.

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
