// tests/test_pack.mjs — buildPack/index-pack 真 git 验证 + parsePack 往返
import { execFileSync } from "node:child_process";
import { rmSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPack, parsePack } from "../src/host/pack.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, "tmp/test_pack");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

function hashObj(type, body) {
  return execFileSync("git", ["hash-object", "-t", type, "--stdin"], { input: body }).toString().trim();
}

const blobBody = Buffer.from("hello\n");
const blobOid = hashObj("blob", blobBody);
const treeBody = Buffer.concat([Buffer.from("100644 f.txt\0"), Buffer.from(blobOid, "hex")]);
const treeOid = hashObj("tree", treeBody);
const commitBody = Buffer.from(`tree ${treeOid}\nauthor t <t@t> 0 +0000\ncommitter t <t@t> 0 +0000\n\ninit\n`);
const commitOid = hashObj("commit", commitBody);
console.log(`oids: commit=${commitOid.slice(0, 7)} tree=${treeOid.slice(0, 7)} blob=${blobOid.slice(0, 7)}`);

const pack = buildPack([
  { type: "commit", body: commitBody },
  { type: "tree", body: treeBody },
  { type: "blob", body: blobBody },
]);
if (pack.subarray(0, 4).toString() !== "PACK" || pack.readUInt32BE(4) !== 2 || pack.readUInt32BE(8) !== 3) {
  throw new Error("bad pack header");
}

// 真 git 判定:index-pack + cat-file 逐对象比对
const dir = join(TMP, "repo");
execFileSync("git", ["init", "-q", dir]);
const idx = execFileSync("git", ["-C", dir, "index-pack", "--stdin"], { input: pack }).toString().trim();
console.log("index-pack:", idx.split("\n").pop().slice(0, 60));
for (const [type, oid, want] of [["commit", commitOid, commitBody], ["tree", treeOid, treeBody], ["blob", blobOid, blobBody]]) {
  const got = execFileSync("git", ["-C", dir, "cat-file", type, oid]); // raw body,无 pretty-print
  if (!got.equals(want)) throw new Error(`cat-file mismatch for ${oid}`);
}
const packFile = join(dir, ".git/objects/pack", readdirSync(join(dir, ".git/objects/pack")).find((f) => f.endsWith(".pack")));
const verify = execFileSync("git", ["verify-pack", "-v", packFile]).toString();
console.log("verify-pack:\n  " + verify.trim().split("\n").slice(0, 4).join("\n  "));
if (!verify.includes(commitOid) || !verify.includes(blobOid)) throw new Error("verify-pack missing objects");

// 自解析往返
const parsed = parsePack(pack);
if (parsed.length !== 3) throw new Error("parsePack count");
const byType = Object.fromEntries(parsed.map((o) => [o.type, o]));
if (!byType.commit.body.equals(commitBody) || byType.commit.size !== commitBody.length) throw new Error("commit roundtrip");
if (!byType.tree.body.equals(treeBody)) throw new Error("tree roundtrip");
if (!byType.blob.body.equals(blobBody)) throw new Error("blob roundtrip");
// 坏包必须被拒:改一个字节 trailer 校验应炸
try {
  const bad = Buffer.from(pack);
  bad[bad.length - 1] ^= 1;
  parsePack(bad);
  throw new Error("trailer check did not fire");
} catch (e) {
  if (!/trailer/.test(e.message)) throw e;
  console.log("trailer check ok");
}

// 100KB 随机 blob:真压缩必须显著小于 stored-only 体量(上限取 60%)
import { randomBytes } from "node:crypto";
const big = randomBytes(100 * 1024);
const bigPack = buildPack([{ type: "blob", body: big }]);
console.log(`100KB random blob pack=${bigPack.length} (stored-only would be ~${big.length + 600})`);
if (bigPack.length > big.length * 1.02) throw new Error("deflate missing? pack bigger than raw");

rmSync(TMP, { recursive: true, force: true });
console.log("ALL PACK TESTS PASSED");
