const std = @import("std");
const oidmod = @import("oid.zig");
const pktline = @import("pktline.zig");
const proto = @import("proto.zig");
const filter = @import("filter.zig");
const partial = @import("partial.zig");
const object = @import("object.zig");
const sha1 = @import("sha1.zig");

// ─── Host imports ───────────────────────────────────────────────────────────
// Storage callbacks (host-side). ptr/len point into wasm linear memory.
extern fn host_emit_bytes(ptr: [*]const u8, len: usize) void;
extern fn host_log(ptr: [*]const u8, len: usize) void;
// object store: return 0 on success, negative on missing/error
extern fn host_get_object(oid_hex_ptr: [*]const u8, out_ptr: [*]u8, out_cap: usize, out_len: *usize) i32;
extern fn host_put_object(oid_hex_ptr: [*]const u8, loose_ptr: [*]const u8, len: usize) i32;

// ─── Arena heap (reset per high-level call; grow big enough for a commit+tree set) ───
var heap: [4 * 1024 * 1024]u8 = undefined;
var fba = std.heap.FixedBufferAllocator.init(&heap);
var heap_inited: bool = false;

fn gpa() std.mem.Allocator {
    if (!heap_inited) {
        fba = std.heap.FixedBufferAllocator.init(&heap);
        heap_inited = true;
    }
    return fba.allocator();
}

export fn wasm_alloc(len: usize) usize {
    if (len == 0) return @intFromPtr(&heap); // stable non-null sentinel for empty slices
    const mem = gpa().alloc(u8, len) catch return 0;
    return @intFromPtr(mem.ptr);
}

export fn wasm_reset() void {
    fba = std.heap.FixedBufferAllocator.init(&heap);
    heap_inited = true;
}

fn sliceFromPtr(ptr: usize, len: usize) []const u8 {
    if (len == 0) return &.{};
    return @as([*]const u8, @ptrFromInt(ptr))[0..len];
}
fn sliceFromPtrMut(ptr: usize, len: usize) []u8 {
    if (len == 0) return &.{};
    return @as([*]u8, @ptrFromInt(ptr))[0..len];
}

// ─── Low-level protocol exports (kept for smart HTTP host) ──────────────────

export fn wasm_handle_discovery(service: u32, refs_pkt_ptr: usize, refs_pkt_len: usize) i32 {
    const alloc = gpa();
    const refs_pkt = sliceFromPtr(refs_pkt_ptr, refs_pkt_len);
    const svc: proto.Service = if (service == 0) .upload_pack else .receive_pack;
    const resp = proto.buildDiscoveryResponse(alloc, svc, refs_pkt) catch return -1;
    defer alloc.free(resp);
    host_emit_bytes(resp.ptr, resp.len);
    return 0;
}

export fn wasm_parse_filter(pkt_ptr: usize, pkt_len: usize, out_has_filter: *u32, out_filter_spec_ptr: *usize, out_filter_spec_len: *usize) i32 {
    const alloc = gpa();
    const pkt = sliceFromPtr(pkt_ptr, pkt_len);
    var fs = partial.FilterSet.fromPktLines(alloc, pkt) catch return -1;
    defer fs.deinit();
    if (fs.specs.len == 0) {
        out_has_filter.* = 0;
        out_filter_spec_ptr.* = 0;
        out_filter_spec_len.* = 0;
        return 0;
    }
    out_has_filter.* = 1;
    var joined: std.ArrayList(u8) = .empty;
    for (fs.specs, 0..) |sp, i| {
        if (i != 0) joined.appendSlice(alloc, "+") catch return -1;
        joined.appendSlice(alloc, sp.raw) catch return -1;
    }
    const slice = joined.toOwnedSlice(alloc) catch return -1;
    const slen = slice.len;
    const ptr = wasm_alloc(slen);
    if (ptr == 0) {
        alloc.free(slice);
        return -1;
    }
    @memcpy(sliceFromPtrMut(ptr, slen), slice);
    alloc.free(slice);
    out_filter_spec_ptr.* = ptr;
    out_filter_spec_len.* = slen;
    return 0;
}

export fn wasm_should_omit(kind_ptr: usize, kind_len: usize, size: usize, filter_ptr: usize, filter_len: usize) u32 {
    const alloc = gpa();
    const kind_s = sliceFromPtr(kind_ptr, kind_len);
    const filter_s = if (filter_len == 0) "" else sliceFromPtr(filter_ptr, filter_len);
    const kind: object.Kind = object.kindFromStr(kind_s) catch return 0;
    var specs: []filter.Spec = &.{};
    if (filter_s.len != 0) {
        specs = filter.parseCombine(alloc, filter_s) catch return 0;
        defer {
            for (specs) |sp| alloc.free(sp.raw);
            alloc.free(specs);
        }
        const omit = filter.shouldOmit(specs, switch (kind) {
            .blob => .blob,
            .tree => .tree,
            .commit => .commit,
            .tag => .tag,
        }, size);
        return if (omit) 1 else 0;
    }
    return 0;
}

export fn wasm_pktline_encode(payload_ptr: usize, payload_len: usize, out_ptr: *usize, out_len: *usize) i32 {
    const alloc = gpa();
    const payload = sliceFromPtr(payload_ptr, payload_len);
    const enc = pktline.encodeLine(alloc, payload) catch return -1;
    const p = wasm_alloc(enc.len);
    if (p == 0) return -1;
    @memcpy(sliceFromPtrMut(p, enc.len), enc);
    alloc.free(enc);
    out_ptr.* = p;
    out_len.* = enc.len;
    return 0;
}

// ─── Object-level high-level API ─────────────────────────────────────────────
//
// Goal: caller deals in (sha1 / path / bytes) only. Two calls:
//
//   read:  wasm_get(oid_hex, paths_json)   -> blobs json [{path,oid,content_b64}]
//   write: wasm_commit(parent_oid_hex, message, entries_json) -> commit oid json
//
// entries_json: [{"path":"a/b.txt","content_b64":"..."}, ...]  (b64 to stay json-safe)
//
// Storage via host_get_object/host_put_object. All alloc in the per-call arena.

const b64 = std.base64.standard.Encoder;
const b64dec = std.base64.standard.Decoder;

fn hostGetObject(oid_hex: []const u8, alloc: std.mem.Allocator) ![]u8 {
    // Host contract: rc 0 = written (len <= cap); rc 1 = need more (out_len = required); rc <0 = missing/error.
    var cap: usize = 64 * 1024; // start small; wasm heap is 4MB
    var buf = try alloc.alloc(u8, cap);
    var len: usize = 0;
    var rc = host_get_object(oid_hex.ptr, buf.ptr, cap, &len);
    if (rc == 1) {
        // required size reported in len; retry
        cap = len;
        buf = try alloc.alloc(u8, cap);
        rc = host_get_object(oid_hex.ptr, buf.ptr, cap, &len);
    }
    if (rc != 0) return error.ObjectNotFound;
    if (len > cap) return error.ObjectNotFound;
    return buf[0..len];
}

fn hostPutObject(oid_hex: []const u8, loose: []const u8) !void {
    const rc = host_put_object(oid_hex.ptr, loose.ptr, loose.len);
    if (rc != 0) return error.PutFailed;
}

// Parse commit body -> tree oid hex (first "tree <hex>" line)
fn commitTree(alloc: std.mem.Allocator, body: []const u8) ![40]u8 {
    const prefix = "tree ";
    var it = std.mem.splitScalar(u8, body, '\n');
    while (it.next()) |line| {
        if (std.mem.startsWith(u8, line, prefix)) {
            const hex = line[prefix.len..];
            if (hex.len != 40) return error.BadCommit;
            var out: [40]u8 = undefined;
            @memcpy(&out, hex);
            return out;
        }
        if (line.len == 0) break; // headers end
    }
    _ = alloc;
    return error.BadCommit;
}

// Find (oid_hex, is_dir) for `name` inside a parsed tree body; also return rest
const TreeLookup = struct { oid_hex: [40]u8, is_dir: bool };

fn treeFind(body: []const u8, name: []const u8) !TreeLookup {
    var i: usize = 0;
    while (i < body.len) {
        const sp = std.mem.indexOfScalarPos(u8, body, i, ' ') orelse return error.InvalidTree;
        const nul = std.mem.indexOfScalarPos(u8, body, sp + 1, 0) orelse return error.InvalidTree;
        const entry_name = body[sp + 1 .. nul];
        if (nul + 1 + 20 > body.len) return error.InvalidTree;
        const oid_bytes = body[nul + 1 .. nul + 1 + 20];
        const next = nul + 1 + 20;
        if (std.mem.eql(u8, entry_name, name)) {
            var hex: [40]u8 = undefined;
            const hexchars = "0123456789abcdef";
            for (oid_bytes, 0..) |bb, j| {
                hex[2 * j] = hexchars[bb >> 4];
                hex[2 * j + 1] = hexchars[bb & 0x0f];
            }
            return .{ .oid_hex = hex, .is_dir = (next <= body.len) and std.mem.startsWith(u8, body[i..sp], "40000") };
        }
        i = next;
    }
    return error.NotFound;
}

// Walk "a/b/c.txt" from a tree oid, loading trees via host as needed.
fn resolvePath(alloc: std.mem.Allocator, tree_oid_hex: []const u8, path: []const u8) ![]u8 {
    var cur_tree_buf: [40]u8 = undefined;
    @memcpy(&cur_tree_buf, tree_oid_hex[0..40]);
    var rest = path;
    while (true) {
        const slash = std.mem.indexOfScalar(u8, rest, '/');
        if (slash == null) {
            // final component: must be a blob
            const tree_obj = try loadObject(alloc, &cur_tree_buf);
            if (tree_obj.kind != .tree) return error.NotATree;
            const hit = try treeFind(tree_obj.body, rest);
            if (hit.is_dir) return error.PathIsDir;
            // load blob, return raw content
            var blob_hex: [40]u8 = hit.oid_hex;
            const blob_obj = try loadObject(alloc, &blob_hex);
            if (blob_obj.kind != .blob) return error.NotABlob;
            return @constCast(blob_obj.body);
        }
        const seg = rest[0..slash.?];
        rest = rest[slash.? + 1 ..];
        const tree_obj = try loadObject(alloc, &cur_tree_buf);
        if (tree_obj.kind != .tree) return error.NotATree;
        const hit = try treeFind(tree_obj.body, seg);
        if (!hit.is_dir) return error.NotADir;
        @memcpy(&cur_tree_buf, &hit.oid_hex);
    }
}

fn loadObject(alloc: std.mem.Allocator, oid_hex: []const u8) !object.Object {
    const loose = try hostGetObject(oid_hex, alloc);
    return object.parseLoose(alloc, loose);
}

const GetEntry = struct { path: []const u8, blob: []u8 };

// wasm_get(oid_hex_ptr, oid_hex_len, paths_json_ptr, paths_json_len, out_json_ptr: *usize, out_json_len: *usize) -> rc
// paths_json: ["a/b.txt", ...]
// out: [{"path":"...","oid":"...","content_b64":"..."}, ...]  allocated in wasm memory (caller copies then may reset)
export fn wasm_get(oid_hex_ptr: usize, oid_hex_len: usize, paths_json_ptr: usize, paths_json_len: usize, out_json_ptr: *usize, out_json_len: *usize) i32 {
    const alloc = gpa();
    const oid_hex = sliceFromPtr(oid_hex_ptr, oid_hex_len);
    const paths_json = sliceFromPtr(paths_json_ptr, paths_json_len);

    const parsed = std.json.parseFromSlice(std.json.Value, alloc, paths_json, .{}) catch return -2;
    defer parsed.deinit();
    const arr = switch (parsed.value) {
        .array => |a| a,
        else => return -3,
    };

    // resolve oid_hex -> commit -> tree
    const commit_obj = loadObject(alloc, oid_hex) catch return -10;
    if (commit_obj.kind != .commit) return -11;
    const tree_hex = commitTree(alloc, commit_obj.body) catch return -12;

    var out: std.ArrayList(u8) = .empty;
    out.appendSlice(alloc, "[") catch return -1;
    for (arr.items, 0..) |item, idx| {
        const path = switch (item) {
            .string => |s| s,
            else => return -4,
        };
        const blob = resolvePath(alloc, &tree_hex, path) catch |e| {
            // append error entry; keep going so caller sees which paths failed
            if (idx != 0) out.append(alloc, ',') catch return -1;
            out.appendSlice(alloc, "{\"path\":\"") catch return -1;
            out.appendSlice(alloc, path) catch return -1;
            out.appendSlice(alloc, "\",\"error\":\"") catch return -1;
            out.appendSlice(alloc, @errorName(e)) catch return -1;
            out.appendSlice(alloc, "\"}") catch return -1;
            continue;
        };
        const blob_oid = sha1.hashHeader("blob", blob);
        var hexbuf: [40]u8 = undefined;
        oidmod.toHex(blob_oid, &hexbuf);
        const b64len = b64.calcSize(blob.len);
        const b64buf = alloc.alloc(u8, b64len) catch return -1;
        _ = b64.encode(b64buf, blob);
        if (idx != 0) out.append(alloc, ',') catch return -1;
        out.appendSlice(alloc, "{\"path\":\"") catch return -1;
        out.appendSlice(alloc, path) catch return -1;
        out.appendSlice(alloc, "\",\"oid\":\"") catch return -1;
        out.appendSlice(alloc, &hexbuf) catch return -1;
        out.appendSlice(alloc, "\",\"content_b64\":\"") catch return -1;
        out.appendSlice(alloc, b64buf) catch return -1;
        out.appendSlice(alloc, "\"}") catch return -1;
    }
    out.appendSlice(alloc, "]") catch return -1;

    const json = out.toOwnedSlice(alloc) catch return -1;
    const p = wasm_alloc(json.len);
    if (p == 0) return -1;
    @memcpy(sliceFromPtrMut(p, json.len), json);
    out_json_ptr.* = p;
    out_json_len.* = json.len;
    return 0;
}

// Build a tree object body from entries {name, mode, oid_bytes}; write via host.
// entries must be sorted by name (git requires). Caller sorts.
fn writeTree(alloc: std.mem.Allocator, entries: []const TreeEnt) ![40]u8 {
    var body: std.ArrayList(u8) = .empty;
    for (entries) |e| {
        body.appendSlice(alloc, e.mode) catch return error.OutOfMemory;
        body.append(alloc, ' ') catch return error.OutOfMemory;
        body.appendSlice(alloc, e.name) catch return error.OutOfMemory;
        body.append(alloc, 0) catch return error.OutOfMemory;
        body.appendSlice(alloc, &e.oid_bytes) catch return error.OutOfMemory;
    }
    const r = object.hashObject(alloc, .tree, body.items) catch return error.OutOfMemory;
    var hex: [40]u8 = undefined;
    oidmod.toHex(r.oid_val, &hex);
    hostPutObject(&hex, r.loose) catch return error.PutFailed;
    return hex;
}

const TreeEnt = struct { name: []const u8, mode: []const u8, oid_bytes: [20]u8 };

fn hexToOidBytes(hex: []const u8) ![20]u8 {
    if (hex.len != 40) return error.BadOid;
    var out: [20]u8 = undefined;
    for (0..20) |i| {
        const hi = try std.fmt.charToDigit(hex[2 * i], 16);
        const lo = try std.fmt.charToDigit(hex[2 * i + 1], 16);
        out[i] = (@as(u8, hi) << 4) | lo;
    }
    return out;
}

// entries of an existing tree as mutable list (name -> (mode, oid))
const LoadedTree = std.ArrayList(TreeEnt);

fn loadTreeEntries(alloc: std.mem.Allocator, tree_oid_hex: []const u8) !LoadedTree {
    var list: LoadedTree = .empty;
    // empty tree oid: return empty
    const empty_hex = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    if (std.mem.eql(u8, tree_oid_hex, empty_hex)) return list;
    const obj = try loadObject(alloc, tree_oid_hex);
    if (obj.kind != .tree) return error.NotATree;
    var i: usize = 0;
    const body = obj.body;
    while (i < body.len) {
        const sp = std.mem.indexOfScalarPos(u8, body, i, ' ') orelse return error.InvalidTree;
        const nul = std.mem.indexOfScalarPos(u8, body, sp + 1, 0) orelse return error.InvalidTree;
        const mode = try alloc.dupe(u8, body[i..sp]);
        const name = try alloc.dupe(u8, body[sp + 1 .. nul]);
        if (nul + 1 + 20 > body.len) return error.InvalidTree;
        var oid_bytes: [20]u8 = undefined;
        @memcpy(&oid_bytes, body[nul + 1 .. nul + 1 + 20]);
        try list.append(alloc, .{ .name = name, .mode = mode, .oid_bytes = oid_bytes });
        i = nul + 1 + 20;
    }
    return list;
}

fn lessThan(_: void, a: TreeEnt, b: TreeEnt) bool {
    // git tree sort: dirs sort as if they had a trailing '/'
    const a_dir = std.mem.eql(u8, a.mode, "40000");
    const b_dir = std.mem.eql(u8, b.mode, "40000");
    const a_name = if (a_dir) std.fmt.allocPrint(std.heap.page_allocator, "{s}/", .{a.name}) catch a.name else a.name;
    const b_name = if (b_dir) std.fmt.allocPrint(std.heap.page_allocator, "{s}/", .{b.name}) catch b.name else b.name;
    defer if (a_dir) std.heap.page_allocator.free(a_name);
    defer if (b_dir) std.heap.page_allocator.free(b_name);
    return std.mem.lessThan(u8, a_name, b_name);
}

// Recursively apply changes to the tree rooted at tree_oid_hex.
// changes: map path -> new blob oid bytes (null => delete, unsupported in MVP)
// Returns new root tree oid hex.
fn applyToTree(alloc: std.mem.Allocator, tree_oid_hex: []const u8, changes: anytype) ![40]u8 {
    // changes: []Change { path, oid_bytes: ?[20]u8, is_dir_marker }
    // group changes by first path segment
    var entries = try loadTreeEntries(alloc, tree_oid_hex);
    // apply blob changes at this level + recurse dirs
    var i: usize = 0;
    while (i < changes.len) : (i += 1) {
        const ch = changes[i];
        const slash = std.mem.indexOfScalar(u8, ch.path, '/');
        if (slash == null) {
            // direct entry
            const name = ch.path;
            // remove existing same name
            var idx: usize = 0;
            while (idx < entries.items.len) : (idx += 1) {
                if (std.mem.eql(u8, entries.items[idx].name, name)) {
                    _ = entries.orderedRemove(idx);
                    break;
                }
            }
            if (ch.oid_bytes) |ob| {
                try entries.append(alloc, .{ .name = name, .mode = "100644", .oid_bytes = ob });
            }
        } else {
            const seg = ch.path[0..slash.?];
            const rest_path = ch.path[slash.? + 1 ..];
            // find or create subdir entry
            var sub_hex: [40]u8 = undefined;
            var found = false;
            for (entries.items) |e| {
                if (std.mem.eql(u8, e.name, seg) and std.mem.eql(u8, e.mode, "40000")) {
                    found = true;
                    var hex: [40]u8 = undefined;
                    const hexchars = "0123456789abcdef";
                    for (e.oid_bytes, 0..) |bb, j| {
                        hex[2 * j] = hexchars[bb >> 4];
                        hex[2 * j + 1] = hexchars[bb & 0x0f];
                    }
                    @memcpy(&sub_hex, &hex);
                    break;
                }
            }
            if (!found) {
                @memcpy(&sub_hex, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
                try entries.append(alloc, .{ .name = seg, .mode = "40000", .oid_bytes = try hexToOidBytes("4b825dc642cb6eb9a060e54bf8d69288fbee4904") });
            }
            // build sub-change with rest_path
            const SubChange = struct { path: []const u8, oid_bytes: ?[20]u8 };
            var subs: std.ArrayList(SubChange) = .empty;
            try subs.append(alloc, .{ .path = rest_path, .oid_bytes = ch.oid_bytes });
            const new_sub = try applyToTree(alloc, &sub_hex, subs.items);
            // update entry oid
            const nb = try hexToOidBytes(&new_sub);
            for (entries.items) |*e| {
                if (std.mem.eql(u8, e.name, seg)) {
                    e.oid_bytes = nb;
                    break;
                }
            }
        }
    }
    std.mem.sort(TreeEnt, entries.items, {}, lessThan);
    return writeTree(alloc, entries.items);
}

const Change = struct { path: []const u8, oid_bytes: ?[20]u8 };

// wasm_commit(parent_hex_ptr,len, msg_ptr,len, entries_json_ptr,len, out_hex_ptr: [*]u8) -> rc
// entries_json: [{"path":"...","content_b64":"..."}, ...]; empty parent = new repo
// writes blobs+trees+commit via host_put_object; returns commit hex (40 bytes written to out_hex_ptr)
export fn wasm_commit(parent_hex_ptr: usize, parent_hex_len: usize, msg_ptr: usize, msg_len: usize, entries_json_ptr: usize, entries_json_len: usize, out_hex_ptr: [*]u8) i32 {
    const alloc = gpa();
    const parent_hex = sliceFromPtr(parent_hex_ptr, parent_hex_len);
    const msg = sliceFromPtr(msg_ptr, msg_len);
    const entries_json = sliceFromPtr(entries_json_ptr, entries_json_len);

    const parsed = std.json.parseFromSlice(std.json.Value, alloc, entries_json, .{}) catch return -2;
    defer parsed.deinit();
    const arr = switch (parsed.value) {
        .array => |a| a,
        else => return -3,
    };

    // 1) store blobs, collect changes
    var changes: std.ArrayList(Change) = .empty;
    for (arr.items) |item| {
        const obj = switch (item) {
            .object => |o| o,
            else => return -4,
        };
        const path = switch (obj.get("path") orelse return -5) {
            .string => |s| s,
            else => return -5,
        };
        const content_b64 = switch (obj.get("content_b64") orelse return -6) {
            .string => |s| s,
            else => return -6,
        };
        // decode b64
        const dec_len = b64dec.calcSizeForSlice(content_b64) catch return -7;
        const content = alloc.alloc(u8, dec_len) catch return -1;
        b64dec.decode(content, content_b64) catch return -7;
        // store blob
        const r = object.hashObject(alloc, .blob, content) catch return -1;
        var bhex: [40]u8 = undefined;
        oidmod.toHex(r.oid_val, &bhex);
        hostPutObject(&bhex, r.loose) catch return -8;
        changes.append(alloc, .{ .path = path, .oid_bytes = r.oid_val }) catch return -1;
    }

    // 2) base tree: parent's tree or empty
    var base_tree_hex: [40]u8 = undefined;
    const has_parent = parent_hex_len == 40;
    if (has_parent) {
        const pobj = loadObject(alloc, parent_hex) catch return -10;
        if (pobj.kind != .commit) return -11;
        base_tree_hex = commitTree(alloc, pobj.body) catch return -12;
    } else {
        @memcpy(&base_tree_hex, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    }

    // 3) apply changes -> new tree
    const new_tree_hex = applyToTree(alloc, &base_tree_hex, changes.items) catch return -13;

    // 4) build commit
    var cbody: std.ArrayList(u8) = .empty;
    cbody.appendSlice(alloc, "tree ") catch return -1;
    cbody.appendSlice(alloc, &new_tree_hex) catch return -1;
    cbody.append(alloc, '\n') catch return -1;
    if (has_parent) {
        cbody.appendSlice(alloc, "parent ") catch return -1;
        cbody.appendSlice(alloc, parent_hex) catch return -1;
        cbody.append(alloc, '\n') catch return -1;
    }
    // author/committer with fixed identity + unix time (host clock not available; use 0)
    const who = "zig-wasm-git <zig-wasm-git@localhost>";
    const ident = "author " ++ who ++ " 0 +0000\ncommitter " ++ who ++ " 0 +0000\n";
    cbody.appendSlice(alloc, ident) catch return -1;
    cbody.append(alloc, '\n') catch return -1;
    cbody.appendSlice(alloc, msg) catch return -1;
    cbody.append(alloc, '\n') catch return -1;

    const cr = object.hashObject(alloc, .commit, cbody.items) catch return -1;
    var chex: [40]u8 = undefined;
    oidmod.toHex(cr.oid_val, &chex);
    hostPutObject(&chex, cr.loose) catch return -8;

    @memcpy(out_hex_ptr[0..40], &chex);
    return 0;
}

