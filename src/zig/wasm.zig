const std = @import("std");
const oidmod = @import("oid.zig");
const pktline = @import("pktline.zig");
const proto = @import("proto.zig");
const filter = @import("filter.zig");
const partial = @import("partial.zig");
const object = @import("object.zig");
const sha1 = @import("sha1.zig");

// ─── Host imports ───────────────────────────────────────────────────────────
// Storage callbacks. ptr/len point into wasm linear memory.
extern fn host_emit_bytes(ptr: [*]const u8, len: usize) void;
extern fn host_log(ptr: [*]const u8, len: usize) void;
// host_get_object(oid_hex(40B), out_ptr, out_cap, out_len*) ->
//   0 = written (len <= cap; len may be 0), 1 = too small (out_len = required), <0 = missing/error
extern fn host_get_object(oid_hex_ptr: [*]const u8, out_ptr: [*]u8, out_cap: usize, out_len: *usize) i32;
extern fn host_put_object(oid_hex_ptr: [*]const u8, loose_ptr: [*]const u8, len: usize) i32;

// ─── Arena heap: reset per high-level call ──────────────────────────────────
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

/// 8-byte aligned bump alloc (wasm pointers may be dereferenced as *usize etc.)
export fn wasm_alloc(len: usize) usize {
    if (len == 0) return @intFromPtr(&heap); // stable non-null sentinel
    const aligned = (len + 7) & ~@as(usize, 7);
    const mem = gpa().alloc(u8, aligned) catch return 0;
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

// ─── Low-level protocol exports (smart HTTP host) ───────────────────────────

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

// ─── Object-level high-level API (binary TLV framing, no JSON/base64) ────────
//
// read:  wasm_get(oid_hex, paths)            paths = "a/b.txt\nc.txt" (LF-separated)
//        out TLV:  u16 n, then per entry:
//            u8 status   (0 = ok)
//            u16 path_len, path
//            ok:    20B raw oid, u32 content_len, content
//            error: status maps to {1 NotFound, 2 PathIsDir, 3 NotATree, 4 NotABlob, 5 BadCommit, 6 BadOid}
//
// write: wasm_commit(parent_hex(40B or empty), msg, entries TLV, out_hex[40])
//        entries TLV: u16 n, then per entry: u16 path_len, path, u32 content_len, content (raw bytes)
//
// Storage via host_get_object/host_put_object. Arena reset per call by the host.

const err_not_found: u8 = 1;
const err_path_is_dir: u8 = 2;
const err_not_a_tree: u8 = 3;
const err_not_a_blob: u8 = 4;
const err_bad_commit: u8 = 5;

// Two-phase read: probe with cap=0 to learn size, then exact alloc. Zero arena waste.
fn hostGetObject(oid_hex: []const u8, alloc: std.mem.Allocator) ![]u8 {
    var len: usize = 0;
    const probe_ptr: [*]u8 = @ptrFromInt(@intFromPtr(&heap));
    const rc0 = host_get_object(oid_hex.ptr, probe_ptr, 0, &len);
    if (rc0 != 0 and rc0 != 1) return error.ObjectNotFound;
    if (rc0 == 0) return try alloc.alloc(u8, 0); // empty object
    const buf = try alloc.alloc(u8, len);
    var len2: usize = 0;
    const rc = host_get_object(oid_hex.ptr, buf.ptr, len, &len2);
    if (rc != 0) return error.ObjectNotFound;
    return buf[0..len2];
}

fn hostPutObject(oid_hex: []const u8, loose: []const u8) !void {
    const rc = host_put_object(oid_hex.ptr, loose.ptr, loose.len);
    if (rc != 0) return error.PutFailed;
}

fn loadObject(alloc: std.mem.Allocator, oid_hex: []const u8) !object.Object {
    const loose = try hostGetObject(oid_hex, alloc);
    return object.parseLoose(alloc, loose);
}

// commit body -> tree oid hex
fn commitTree(body: []const u8) ![40]u8 {
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
        if (line.len == 0) break;
    }
    return error.BadCommit;
}

fn oidBytesToHex(bytes: [20]u8) [40]u8 {
    var hex: [40]u8 = undefined;
    const hexchars = "0123456789abcdef";
    for (bytes, 0..) |b, j| {
        hex[2 * j] = hexchars[b >> 4];
        hex[2 * j + 1] = hexchars[b & 0x0f];
    }
    return hex;
}

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

const TreeLookup = struct { oid_bytes: [20]u8, is_dir: bool };

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
            var ob: [20]u8 = undefined;
            @memcpy(&ob, oid_bytes);
            return .{ .oid_bytes = ob, .is_dir = body[i] == '4' }; // mode 40000 = dir
        }
        i = next;
    }
    return error.NotFound;
}

fn resolvePath(alloc: std.mem.Allocator, tree_oid_hex: []const u8, path: []const u8) ![]u8 {
    var cur: [40]u8 = undefined;
    @memcpy(&cur, tree_oid_hex[0..40]);
    var rest = path;
    while (true) {
        const slash = std.mem.indexOfScalar(u8, rest, '/');
        if (slash == null) {
            const tree_obj = try loadObject(alloc, &cur);
            if (tree_obj.kind != .tree) return error.NotATree;
            const hit = try treeFind(tree_obj.body, rest);
            if (hit.is_dir) return error.PathIsDir;
            var blob_hex: [40]u8 = oidBytesToHex(hit.oid_bytes);
            const blob_obj = try loadObject(alloc, &blob_hex);
            if (blob_obj.kind != .blob) return error.NotABlob;
            return @constCast(blob_obj.body);
        }
        const seg = rest[0..slash.?];
        rest = rest[slash.? + 1 ..];
        const tree_obj = try loadObject(alloc, &cur);
        if (tree_obj.kind != .tree) return error.NotATree;
        const hit = try treeFind(tree_obj.body, seg);
        if (!hit.is_dir) return error.NotATree;
        cur = oidBytesToHex(hit.oid_bytes);
    }
}

const TLVWriter = struct {
    buf: std.ArrayList(u8) = .empty,
    alloc: std.mem.Allocator,

    fn putU8(self: *TLVWriter, v: u8) !void {
        try self.buf.append(self.alloc, v);
    }
    fn putU16(self: *TLVWriter, v: u16) !void {
        var b: [2]u8 = undefined;
        std.mem.writeInt(u16, &b, v, .little);
        try self.buf.appendSlice(self.alloc, &b);
    }
    fn putU32(self: *TLVWriter, v: u32) !void {
        var b: [4]u8 = undefined;
        std.mem.writeInt(u32, &b, v, .little);
        try self.buf.appendSlice(self.alloc, &b);
    }
    fn putBytes(self: *TLVWriter, v: []const u8) !void {
        try self.buf.appendSlice(self.alloc, v);
    }
    fn putOid(self: *TLVWriter, v: [20]u8) !void {
        try self.buf.appendSlice(self.alloc, &v);
    }
};

fn mapErr(e: anyerror) u8 {
    return switch (e) {
        error.NotFound, error.ObjectNotFound => err_not_found,
        error.PathIsDir => err_path_is_dir,
        error.NotATree, error.NotADir => err_not_a_tree,
        error.NotABlob => err_not_a_blob,
        error.BadCommit => err_bad_commit,
        else => err_not_found,
    };
}

// wasm_get(oid_hex_ptr, oid_hex_len, paths_ptr, paths_len, out_ptr: *usize, out_len: *usize) -> rc
export fn wasm_get(oid_hex_ptr: usize, oid_hex_len: usize, paths_ptr: usize, paths_len: usize, out_ptr: *usize, out_len: *usize) i32 {
    const alloc = gpa();
    const oid_hex = sliceFromPtr(oid_hex_ptr, oid_hex_len);
    const paths = sliceFromPtr(paths_ptr, paths_len);

    const commit_obj = loadObject(alloc, oid_hex) catch return -10;
    if (commit_obj.kind != .commit) return -11;
    const tree_hex = commitTree(commit_obj.body) catch return -12;

    var w = TLVWriter{ .alloc = alloc };

    // count paths first
    var n: usize = 0;
    var it = std.mem.splitScalar(u8, paths, '\n');
    while (it.next()) |p| {
        if (p.len > 0) n += 1;
    }
    w.putU16(@intCast(n)) catch return -1;

    it = std.mem.splitScalar(u8, paths, '\n');
    while (it.next()) |path| {
        if (path.len == 0) continue;
        if (resolvePath(alloc, &tree_hex, path)) |blob| {
            const blob_oid = sha1.hashHeader("blob", blob);
            w.putU8(0) catch return -1;
            w.putU16(@intCast(path.len)) catch return -1;
            w.putBytes(path) catch return -1;
            w.putOid(blob_oid) catch return -1;
            w.putU32(@intCast(blob.len)) catch return -1;
            w.putBytes(blob) catch return -1;
        } else |e| {
            w.putU8(mapErr(e)) catch return -1;
            w.putU16(@intCast(path.len)) catch return -1;
            w.putBytes(path) catch return -1;
        }
    }

    const out = w.buf.toOwnedSlice(alloc) catch return -1;
    const p = wasm_alloc(out.len);
    if (p == 0) return -1;
    @memcpy(sliceFromPtrMut(p, out.len), out);
    out_ptr.* = p;
    out_len.* = out.len;
    return 0;
}

// ─── commit ──────────────────────────────────────────────────────────────────

const TreeEnt = struct { name: []const u8, mode: []const u8, oid_bytes: [20]u8 };

// git tree order: dirs compare as name + '/'. No allocation.
fn lessThan(_: void, a: TreeEnt, b: TreeEnt) bool {
    const a_dir = a.mode[0] == '4';
    const b_dir = b.mode[0] == '4';
    var ai: usize = 0;
    var bi: usize = 0;
    while (ai < a.name.len and bi < b.name.len) : ({
        ai += 1;
        bi += 1;
    }) {
        const ac = a.name[ai];
        const bc = b.name[bi];
        if (ac != bc) return ac < bc;
    }
    const a_tail: u8 = if (ai < a.name.len) a.name[ai] else if (a_dir) '/' else 0;
    const b_tail: u8 = if (bi < b.name.len) b.name[bi] else if (b_dir) '/' else 0;
    return a_tail < b_tail;
}

fn writeTree(alloc: std.mem.Allocator, entries: []const TreeEnt) ![40]u8 {
    var body: std.ArrayList(u8) = .empty;
    for (entries) |e| {
        try body.appendSlice(alloc, e.mode);
        try body.append(alloc, ' ');
        try body.appendSlice(alloc, e.name);
        try body.append(alloc, 0);
        try body.appendSlice(alloc, &e.oid_bytes);
    }
    const r = try object.hashObject(alloc, .tree, body.items);
    const hex = oidBytesToHex(r.oid_val);
    try hostPutObject(&hex, r.loose);
    return hex;
}

const LoadedTree = std.ArrayList(TreeEnt);

fn loadTreeEntries(alloc: std.mem.Allocator, tree_oid_hex: []const u8) !LoadedTree {
    var list: LoadedTree = .empty;
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

const Change = struct { path: []const u8, oid_bytes: [20]u8 };

fn applyToTree(alloc: std.mem.Allocator, tree_oid_hex: []const u8, changes: []const Change) ![40]u8 {
    var entries = try loadTreeEntries(alloc, tree_oid_hex);
    for (changes) |ch| {
        const slash = std.mem.indexOfScalar(u8, ch.path, '/');
        if (slash == null) {
            const name = ch.path;
            var idx: usize = 0;
            while (idx < entries.items.len) : (idx += 1) {
                if (std.mem.eql(u8, entries.items[idx].name, name)) {
                    _ = entries.orderedRemove(idx);
                    break;
                }
            }
            try entries.append(alloc, .{ .name = name, .mode = "100644", .oid_bytes = ch.oid_bytes });
        } else {
            const seg = ch.path[0..slash.?];
            const rest_path = ch.path[slash.? + 1 ..];
            var sub_hex: [40]u8 = undefined;
            var found = false;
            for (entries.items) |e| {
                if (std.mem.eql(u8, e.name, seg) and e.mode[0] == '4') {
                    sub_hex = oidBytesToHex(e.oid_bytes);
                    found = true;
                    break;
                }
            }
            if (!found) {
                const empty_hex = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
                @memcpy(&sub_hex, empty_hex);
                try entries.append(alloc, .{ .name = seg, .mode = "40000", .oid_bytes = try hexToOidBytes(empty_hex) });
            }
            const subs = [_]Change{.{ .path = rest_path, .oid_bytes = ch.oid_bytes }};
            const new_sub = try applyToTree(alloc, &sub_hex, &subs);
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

// wasm_commit(parent_hex_ptr, parent_hex_len(0|40), msg_ptr, msg_len,
//             entries_ptr, entries_len, out_hex_ptr: [*]u8) -> rc
// entries TLV: u16 n, then per entry: u16 path_len, path, u32 content_len, content
export fn wasm_commit(parent_hex_ptr: usize, parent_hex_len: usize, msg_ptr: usize, msg_len: usize, entries_ptr: usize, entries_len: usize, out_hex_ptr: [*]u8) i32 {
    const alloc = gpa();
    const parent_hex = sliceFromPtr(parent_hex_ptr, parent_hex_len);
    const msg = sliceFromPtr(msg_ptr, msg_len);
    const tlv = sliceFromPtr(entries_ptr, entries_len);

    // parse entries TLV
    if (tlv.len < 2) return -2;
    const n = std.mem.readInt(u16, tlv[0..2], .little);
    var pos: usize = 2;
    var changes: std.ArrayList(Change) = .empty;
    var i: usize = 0;
    while (i < n) : (i += 1) {
        if (pos + 2 > tlv.len) return -3;
        const plen = std.mem.readInt(u16, tlv[pos..][0..2], .little);
        pos += 2;
        if (pos + plen + 4 > tlv.len) return -3;
        const path = tlv[pos .. pos + plen];
        pos += plen;
        const clen = std.mem.readInt(u32, tlv[pos..][0..4], .little);
        pos += 4;
        if (pos + clen > tlv.len) return -3;
        const content = tlv[pos .. pos + clen];
        pos += clen;
        // store blob
        const r = object.hashObject(alloc, .blob, content) catch return -1;
        var bhex: [40]u8 = undefined;
        oidmod.toHex(r.oid_val, &bhex);
        hostPutObject(&bhex, r.loose) catch return -8;
        changes.append(alloc, .{ .path = path, .oid_bytes = r.oid_val }) catch return -1;
    }

    const has_parent = parent_hex_len == 40;
    var base_tree_hex: [40]u8 = undefined;
    if (has_parent) {
        const pobj = loadObject(alloc, parent_hex) catch return -10;
        if (pobj.kind != .commit) return -11;
        base_tree_hex = commitTree(pobj.body) catch return -12;
    } else {
        @memcpy(&base_tree_hex, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    }

    const new_tree_hex = applyToTree(alloc, &base_tree_hex, changes.items) catch return -13;

    var cbody: std.ArrayList(u8) = .empty;
    cbody.appendSlice(alloc, "tree ") catch return -1;
    cbody.appendSlice(alloc, &new_tree_hex) catch return -1;
    cbody.append(alloc, '\n') catch return -1;
    if (has_parent) {
        cbody.appendSlice(alloc, "parent ") catch return -1;
        cbody.appendSlice(alloc, parent_hex) catch return -1;
        cbody.append(alloc, '\n') catch return -1;
    }
    cbody.appendSlice(alloc, "author zig-wasm-git <zig-wasm-git@localhost> 0 +0000\n") catch return -1;
    cbody.appendSlice(alloc, "committer zig-wasm-git <zig-wasm-git@localhost> 0 +0000\n") catch return -1;
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
