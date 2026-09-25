const std = @import("std");
const pktline = @import("pktline.zig");

// Protocol v2 request builders (upload-pack client).
// Wire format captured from real git 2.54 (see tmp/probe traces):
//   ls-refs: pkt("command=ls-refs\n") + pkt("agent=...\n") + pkt("object-format=sha1\n")
//            + "0001" + pkt("peel\n") + pkt("symrefs\n") + "0000"
//   fetch:   pkt("command=fetch\n") + pkt("agent=...\n") + pkt("object-format=sha1\n")
//            + "0001" + pkt("ofs-delta\n") + pkt("no-progress\n")
//            + [pkt("filter <spec>\n")] + pkt("want <oid>\n") + pkt("done\n") + "0000"
// filter-before-want matches git client order; server parsers are order-independent.

pub const AGENT_LINE = "agent=zig-wasm-git/0.0.1\n";

fn appendLine(allocator: std.mem.Allocator, out: *std.ArrayList(u8), payload: []const u8) !void {
    const el = try pktline.encodeLine(allocator, payload);
    defer allocator.free(el);
    try out.appendSlice(allocator, el);
}

pub fn buildLsRefsRequest(allocator: std.mem.Allocator) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try appendLine(allocator, &out, "command=ls-refs\n");
    try appendLine(allocator, &out, AGENT_LINE);
    try appendLine(allocator, &out, "object-format=sha1\n");
    try out.appendSlice(allocator, "0001");
    try appendLine(allocator, &out, "peel\n");
    try appendLine(allocator, &out, "symrefs\n");
    try out.appendSlice(allocator, "0000");
    return out.toOwnedSlice(allocator);
}

pub const FetchOpts = struct {
    filter: ?[]const u8 = null, // e.g. "blob:none" (without "filter " prefix)
    include_ofs_delta: bool = true,
    include_no_progress: bool = true,
};

pub fn buildFetchRequest(
    allocator: std.mem.Allocator,
    wants: []const [40]u8,
    opts: FetchOpts,
) ![]u8 {
    if (wants.len == 0) return error.NoWants;
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try appendLine(allocator, &out, "command=fetch\n");
    try appendLine(allocator, &out, AGENT_LINE);
    try appendLine(allocator, &out, "object-format=sha1\n");
    try out.appendSlice(allocator, "0001");
    if (opts.include_ofs_delta) try appendLine(allocator, &out, "ofs-delta\n");
    if (opts.include_no_progress) try appendLine(allocator, &out, "no-progress\n");
    // git client order: filter before want
    if (opts.filter) |f| {
        if (f.len > 0) {
            var line: std.ArrayList(u8) = .empty;
            defer line.deinit(allocator);
            try line.appendSlice(allocator, "filter ");
            try line.appendSlice(allocator, f);
            try line.append(allocator, '\n');
            const el = try pktline.encodeLine(allocator, line.items);
            defer allocator.free(el);
            try out.appendSlice(allocator, el);
        }
    }
    for (wants) |w| {
        var line: std.ArrayList(u8) = .empty;
        defer line.deinit(allocator);
        try line.appendSlice(allocator, "want ");
        try line.appendSlice(allocator, &w);
        try line.append(allocator, '\n');
        const el = try pktline.encodeLine(allocator, line.items);
        defer allocator.free(el);
        try out.appendSlice(allocator, el);
    }
    try appendLine(allocator, &out, "done\n");
    try out.appendSlice(allocator, "0000");
    return out.toOwnedSlice(allocator);
}

test "ls-refs request shape" {
    const alloc = std.testing.allocator;
    const req = try buildLsRefsRequest(alloc);
    defer alloc.free(req);
    try std.testing.expect(std.mem.indexOf(u8, req, "command=ls-refs\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, req, "0001") != null);
    try std.testing.expect(std.mem.endsWith(u8, req, "0000"));
    // first pkt len prefix must parse
    const len = try std.fmt.parseInt(usize, req[0..4], 16);
    try std.testing.expectEqual(len, "command=ls-refs\n".len + 4);
}

test "fetch request shape (filter before want)" {
    const alloc = std.testing.allocator;
    const want = [_]u8{'a'} ** 40;
    const req = try buildFetchRequest(alloc, &[_][40]u8{want}, .{ .filter = "blob:none" });
    defer alloc.free(req);
    const fi = std.mem.indexOf(u8, req, "filter blob:none\n").?;
    const wi = std.mem.indexOf(u8, req, "want aaaa").?;
    try std.testing.expect(fi < wi);
    try std.testing.expect(std.mem.indexOf(u8, req, "done\n") != null);
    try std.testing.expect(std.mem.endsWith(u8, req, "0000"));
}

test "fetch request no filter" {
    const alloc = std.testing.allocator;
    const want = [_]u8{'b'} ** 40;
    const req = try buildFetchRequest(alloc, &[_][40]u8{want}, .{});
    defer alloc.free(req);
    try std.testing.expect(std.mem.indexOf(u8, req, "filter ") == null);
    try std.testing.expect(std.mem.indexOf(u8, req, "want bbbb") != null);
}
