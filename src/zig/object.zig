const std = @import("std");
const oid = @import("oid.zig");
const sha1 = @import("sha1.zig");
const zlib = @import("zlib.zig");

pub const Kind = enum { blob, tree, commit, tag };

pub fn kindFromStr(s: []const u8) !Kind {
    if (std.mem.eql(u8, s, "blob")) return .blob;
    if (std.mem.eql(u8, s, "tree")) return .tree;
    if (std.mem.eql(u8, s, "commit")) return .commit;
    if (std.mem.eql(u8, s, "tag")) return .tag;
    return error.InvalidObjectKind;
}

pub fn kindToStr(k: Kind) []const u8 {
    return switch (k) {
        .blob => "blob",
        .tree => "tree",
        .commit => "commit",
        .tag => "tag",
    };
}

pub const Object = struct {
    kind: Kind,
    body: []const u8, // decoded, without header
    oid_val: oid.Oid,
};

const enc = @import("enc.zig");

pub fn hashObject(allocator: std.mem.Allocator, kind: Kind, body: []const u8) !struct { oid_val: oid.Oid, loose: []u8 } {
    const typ = kindToStr(kind);
    const oid_val = sha1.hashHeader(typ, body);
    // loose = zlib("type len\0body")
    var header_buf: [64]u8 = undefined;
    const hlen = enc.objectHeader(&header_buf, typ, body.len);
    var raw: std.ArrayList(u8) = .empty;
    defer raw.deinit(allocator);
    try raw.appendSlice(allocator, header_buf[0..hlen]);
    try raw.appendSlice(allocator, body);
    const loose = try zlib.compress(allocator, raw.items);
    return .{ .oid_val = oid_val, .loose = loose };
}

pub fn parseLoose(allocator: std.mem.Allocator, zlib_data: []const u8) !Object {
    const raw = try zlib.decompress(allocator, zlib_data);
    errdefer allocator.free(raw);
    const nul = std.mem.indexOfScalar(u8, raw, 0) orelse return error.InvalidLooseHeader;
    const header = raw[0..nul];
    const body = raw[nul + 1 ..];
    const sp = std.mem.indexOfScalar(u8, header, ' ') orelse return error.InvalidLooseHeader;
    const typ = header[0..sp];
    const kind = try kindFromStr(typ);
    const len_str = header[sp + 1 ..];
    const len = try std.fmt.parseInt(usize, len_str, 10);
    if (len != body.len) return error.LooseLengthMismatch;
    const oid_val = sha1.hashHeader(typ, body);
    // keep raw alive as body slice; copy body to owned
    const body_copy = try allocator.dupe(u8, body);
    allocator.free(raw);
    return .{ .kind = kind, .body = body_copy, .oid_val = oid_val };
}

/// Minimal tree entry parser (name + mode + oid) for filtering decisions.
/// Returns list of (mode, name, oid_hex) — caller frees.
pub const TreeEntry = struct {
    mode: []const u8,
    name: []const u8,
    oid_hex: [40]u8,
};

pub fn parseTree(allocator: std.mem.Allocator, body: []const u8) ![]TreeEntry {
    var list: std.ArrayList(TreeEntry) = .empty;
    errdefer list.deinit(allocator);
    var i: usize = 0;
    while (i < body.len) {
        const sp = std.mem.indexOfScalarPos(u8, body, i, ' ') orelse return error.InvalidTree;
        const mode = body[i..sp];
        const nul = std.mem.indexOfScalarPos(u8, body, sp + 1, 0) orelse return error.InvalidTree;
        const name = body[sp + 1 .. nul];
        if (nul + 1 + 20 > body.len) return error.InvalidTree;
        const oid_bytes = body[nul + 1 .. nul + 1 + 20];
        var hex: [40]u8 = undefined;
        const hexchars = "0123456789abcdef";
        for (oid_bytes, 0..) |b, j| {
            hex[2 * j] = hexchars[b >> 4];
            hex[2 * j + 1] = hexchars[b & 0x0f];
        }
        try list.append(allocator, .{
            .mode = try allocator.dupe(u8, mode),
            .name = try allocator.dupe(u8, name),
            .oid_hex = hex,
        });
        i = nul + 1 + 20;
    }
    return list.toOwnedSlice(allocator);
}

test "hash empty blob" {
    const alloc = std.testing.allocator;
    const r = try hashObject(alloc, .blob, "");
    defer alloc.free(r.loose);
    var hex: [40]u8 = undefined;
    const hx = "0123456789abcdef";
    for (r.oid_val, 0..) |b, i| {
        hex[2 * i] = hx[b >> 4];
        hex[2 * i + 1] = hx[b & 0x0f];
    }
    try std.testing.expectEqualStrings("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", &hex);
}

test "parseTree" {
    const alloc = std.testing.allocator;
    // Build a tree with one entry: 100644 hello.txt -> empty blob
    const empty_oid_hex = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
    var oid_bytes: [20]u8 = undefined;
    for (0..20) |i| {
        const hi = try std.fmt.charToDigit(empty_oid_hex[2 * i], 16);
        const lo = try std.fmt.charToDigit(empty_oid_hex[2 * i + 1], 16);
        oid_bytes[i] = (hi << 4) | lo;
    }
    var body: std.ArrayList(u8) = .empty;
    defer body.deinit(alloc);
    try body.appendSlice(alloc, "100644 ");
    try body.appendSlice(alloc, "hello.txt");
    try body.append(alloc, 0);
    try body.appendSlice(alloc, &oid_bytes);
    const entries = try parseTree(alloc, body.items);
    defer {
        for (entries) |e| {
            alloc.free(e.mode);
            alloc.free(e.name);
        }
        alloc.free(entries);
    }
    try std.testing.expectEqual(@as(usize, 1), entries.len);
    try std.testing.expectEqualStrings("hello.txt", entries[0].name);
}
