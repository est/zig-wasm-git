const std = @import("std");

// Minimal filter-spec parser for partial clone (git rev-list --filter=...).
// Supports only a subset needed for WASM engine intent:
//   blob:none | blob:limit=<n>[kmg] | tree:0 | object:type=blob|tree|commit|tag
//   combines via multiple --filter flags (Host joins with '+').
// In WASM, filter is evaluated server-side when building pack. Here we
// provide parser + predicate for Host to plug into object enumeration.

pub const Kind = enum {
    blob_none,
    blob_limit,
    tree_depth_0,
    object_type,
};

pub const ObjectType = enum { blob, tree, commit, tag };

pub const Spec = struct {
    kind: Kind,
    limit_bytes: usize = 0, // for blob:limit
    object_type: ObjectType = .blob, // for object:type=
    raw: []const u8, // original text for round-trip
};

pub fn parseOne(raw: []const u8) !Spec {
    if (std.mem.eql(u8, raw, "blob:none")) {
        return .{ .kind = .blob_none, .raw = raw };
    }
    if (std.mem.startsWith(u8, raw, "blob:limit=")) {
        const num_part = raw["blob:limit=".len..];
        const n = try parseSize(num_part);
        return .{ .kind = .blob_limit, .limit_bytes = n, .raw = raw };
    }
    if (std.mem.eql(u8, raw, "tree:0")) {
        return .{ .kind = .tree_depth_0, .raw = raw };
    }
    if (std.mem.startsWith(u8, raw, "object:type=")) {
        const t = raw["object:type=".len..];
        const ot: ObjectType = if (std.mem.eql(u8, t, "blob")) .blob else if (std.mem.eql(u8, t, "tree")) .tree else if (std.mem.eql(u8, t, "commit")) .commit else if (std.mem.eql(u8, t, "tag")) .tag else return error.InvalidFilter;
        return .{ .kind = .object_type, .object_type = ot, .raw = raw };
    }
    return error.InvalidFilter;
}

fn parseSize(s: []const u8) !usize {
    if (s.len == 0) return error.InvalidSize;
    var num: usize = 0;
    var i: usize = 0;
    while (i < s.len and s[i] >= '0' and s[i] <= '9') : (i += 1) {
        num = num * 10 + (s[i] - '0');
    }
    if (i == s.len) return num;
    if (i + 1 != s.len) return error.InvalidSize;
    const suffix = s[i];
    const mult: usize = switch (suffix) {
        'k', 'K' => 1024,
        'm', 'M' => 1024 * 1024,
        'g', 'G' => 1024 * 1024 * 1024,
        else => return error.InvalidSize,
    };
    return num * mult;
}

/// Returns true if object of given (type, size) should be OMITTED per filter.
pub fn shouldOmit(specs: []const Spec, obj_type: ObjectType, size: usize) bool {
    // Git combines multiple --filter as AND: object included only if accepted by every filter.
    // So omitted if ANY filter rejects it.
    for (specs) |sp| {
        const reject: bool = switch (sp.kind) {
            .blob_none => obj_type == .blob,
            .blob_limit => obj_type == .blob and size >= sp.limit_bytes,
            .tree_depth_0 => obj_type == .tree or obj_type == .blob, // tree:0 = omits all blobs and trees
            .object_type => obj_type != sp.object_type,
        };
        if (reject) return true;
    }
    return false;
}

pub fn parseCombine(allocator: std.mem.Allocator, combined: []const u8) ![]Spec {
    // "combine:..." or single "filter-spec"; Host may pass "blob:none" etc or "filter blob:none"
    var raw = combined;
    if (std.mem.startsWith(u8, raw, "filter ")) raw = raw["filter ".len..];
    if (std.mem.startsWith(u8, raw, "combine:")) raw = raw["combine:".len..];
    // split by '+'
    var list: std.ArrayList(Spec) = .empty;
    errdefer list.deinit(allocator);
    var it = std.mem.splitScalar(u8, raw, '+');
    while (it.next()) |part| {
        if (part.len == 0) continue;
        // URL-decode minimal (%20 etc) — git uses %-encoding for combine
        const decoded = try urlDecode(allocator, part);
        defer allocator.free(decoded);
        const sp = try parseOne(decoded);
        try list.append(allocator, .{
            .kind = sp.kind,
            .limit_bytes = sp.limit_bytes,
            .object_type = sp.object_type,
            .raw = try allocator.dupe(u8, decoded),
        });
    }
    return list.toOwnedSlice(allocator);
}

fn urlDecode(allocator: std.mem.Allocator, s: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    var i: usize = 0;
    while (i < s.len) {
        if (s[i] == '%' and i + 2 < s.len) {
            const hi = try hexVal(s[i + 1]);
            const lo = try hexVal(s[i + 2]);
            try out.append(allocator, (hi << 4) | lo);
            i += 3;
        } else {
            try out.append(allocator, s[i]);
            i += 1;
        }
    }
    return out.toOwnedSlice(allocator);
}

fn hexVal(c: u8) !u8 {
    return switch (c) {
        '0'...'9' => c - '0',
        'a'...'f' => c - 'a' + 10,
        'A'...'F' => c - 'A' + 10,
        else => error.InvalidHex,
    };
}

test "filter blob:none" {
    const sp = try parseOne("blob:none");
    try std.testing.expectEqual(Kind.blob_none, sp.kind);
    try std.testing.expect(shouldOmit(&.{sp}, .blob, 10));
    try std.testing.expect(!shouldOmit(&.{sp}, .tree, 10));
    try std.testing.expect(!shouldOmit(&.{sp}, .commit, 10));
}

test "filter blob:limit" {
    const sp = try parseOne("blob:limit=1k");
    try std.testing.expectEqual(@as(usize, 1024), sp.limit_bytes);
    try std.testing.expect(shouldOmit(&.{sp}, .blob, 1024));
    try std.testing.expect(!shouldOmit(&.{sp}, .blob, 1023));
    try std.testing.expect(!shouldOmit(&.{sp}, .tree, 9999));
}

test "filter combine" {
    const alloc = std.testing.allocator;
    const specs = try parseCombine(alloc, "combine:blob:none+object:type=commit");
    defer {
        for (specs) |s| alloc.free(s.raw);
        alloc.free(specs);
    }
    try std.testing.expectEqual(@as(usize, 2), specs.len);
}
