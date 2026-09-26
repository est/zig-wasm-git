// src/host/browser.mjs — deprecated alias of portable.mjs (kept for backwards compat).
//
// The old name suggested browser-only, but this entry runs in browsers,
// Cloudflare Workers, and Node alike. New code should import from
// "./portable.mjs" instead:
//
//   import { loadFromBytes, memoryStore } from "./portable.mjs";

export * from "./portable.mjs";
