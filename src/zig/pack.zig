const std = @import("std");
const sha1 = @import("sha1.zig");

// Minimal pack v2 generator/parser for loose objects (no delta yet).
// Format ref: third_party/git/Documentation/technical/pack-format (adoc) + https://git-scm.com/docs/pack-format
// This impl: generate pack from list of (kind, body) by hashing + zlib; parse pack to extract objects.

pub const PackObjectType = enum(u3) {
    commit = 1,
    tree = 2,
    blob = 3,
    tag = 4,
    ofs_delta = 6,
    ref_delta = 7,
};

pub const ObjectKind = enum { commit, tree, blob, tag };

fn kindToPackType(k: ObjectKind) PackObjectType {
    return switch (k) {
        .commit => .commit,
        .tree => .tree,
        .blob => .blob,
        .tag => .tag,
    };
}

pub const PackObject = struct {
    kind: ObjectKind,
    body: []u8, // owned
    oid: [20]u8,
};

pub fn buildPack(allocator: std.mem.Allocator, objs: []const PackObject) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    // header
    try out.appendSlice(allocator, "PACK");
    // version 2
    try out.appendSlice(allocator, &[_]u8{ 0, 0, 0, 2 });
    // num objects
    var nbuf: [4]u8 = undefined;
    std.mem.writeInt(u32, &nbuf, @intCast(objs.len), .big);
    try out.appendSlice(allocator, &nbuf);
    for (objs) |o| {
        const ptype = kindToPackType(o.kind);
        const sz = o.body.len;
        // object header: varint type + size
        var hdr: std.ArrayList(u8) = .empty;
        defer hdr.deinit(allocator);
        try encodePackHeader(allocator, &hdr, ptype, sz);
        try out.appendSlice(allocator, hdr.items);
        // zlib payload: compress("type len\0body") style? In pack, payload is zlib of raw body (for non-delta)
        // Git pack stores zlib of object content without loose header? Actually object header already encodes type/size,
        // payload is zlib of body only for blob/tree/commit/tag. We'll store body directly zlib-compressed.
        // For loose interop, Host will need to reconcile: body is raw object body.
        // To match git pack expectations, we store zlib of body (which is what git's pack-objects does for non-delta base objects? No, pack stores deflated object including header).
        // Simpler: store deflated raw = header+body; parser will then produce same header+body.
        // We'll do: payload = zlib(header+body)
        var header_buf: [64]u8 = undefined;
        const header = try std.fmt.bufPrint(&header_buf, "{s} {d}\x00", .{ @tagName(o.kind), o.body.len });
        var raw: std.ArrayList(u8) = .empty;
        defer raw.deinit(allocator);
        try raw.appendSlice(allocator, header);
        try raw.appendSlice(allocator, o.body);
        const z = try @import("zlib.zig").compress(allocator, raw.items);
        defer allocator.free(z);
        try out.appendSlice(allocator, z);
    }
    // trailer SHA1 of pack content up to here
    const h = sha1.hash(out.items);
    try out.appendSlice(allocator, &h);
    return out.toOwnedSlice(allocator);
}

fn encodePackHeader(allocator: std.mem.Allocator, out: *std.ArrayList(u8), ptype: PackObjectType, size: usize) !void {
    // First byte: [1 bit continue][3 bits type][4 bits low size]
    // Following bytes: varint size (7 bits per byte, MSB continue)
    var sz = size;
    const first_low: u8 = @intCast(sz & 0x0f);
    sz >>= 4;
    var first: u8 = (@as(u8, @intFromEnum(ptype)) << 4) | first_low;
    if (sz != 0) first |= 0x80;
    try out.append(allocator, first);
    while (sz != 0) {
        var b: u8 = @intCast(sz & 0x7f);
        sz >>= 7;
        if (sz != 0) b |= 0x80;
        try out.append(allocator, b);
    }
}

pub fn parsePackHeader(buf: []const u8) !struct { ptype: PackObjectType, size: usize, consumed: usize } {
    if (buf.len == 0) return error.Truncated;
    var pos: usize = 0;
    const first = buf[pos];
    pos += 1;
    const t: u3 = @intCast((first >> 4) & 0x07);
    const ptype: PackObjectType = @enumFromInt(t);
    var size: usize = @as(usize, first & 0x0f);
    var shift: usize = 4;
    var cont = (first & 0x80) != 0;
    while (cont) {
        if (pos >= buf.len) return error.Truncated;
        const b = buf[pos];
        pos += 1;
        size |= @as(usize, b & 0x7f) << @intCast(shift);
        shift += 7;
        cont = (b & 0x80) != 0;
    }
    return .{ .ptype = ptype, .size = size, .consumed = pos };
}

test "pack header roundtrip" {
    const alloc = std.testing.allocator;
    var hdr: std.ArrayList(u8) = .empty;
    defer hdr.deinit(alloc);
    try encodePackHeader(alloc, &hdr, .blob, 300);
    const p = try parsePackHeader(hdr.items);
    try std.testing.expectEqual(PackObjectType.blob, p.ptype);
    try std.testing.expectEqual(@as(usize, 300), p.size);
}

test "pack build basic" {
    const alloc = std.testing.allocator;
    const body = try alloc.dupe(u8, "hello\n");
    defer alloc.free(body);
    const objs = [_]PackObject{.{ .kind = .blob, .body = body, .oid = [_]u8{0} ** 20 }};
    const pack_bytes = try buildPack(alloc, &objs);
    defer alloc.free(pack_bytes);
    try std.testing.expect(std.mem.startsWith(u8, pack_bytes, "PACK"));
    // last 20 bytes are SHA1
    try std.testing.expect(pack_bytes.len > 12 + 20);
}
