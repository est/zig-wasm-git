const std = @import("std");

pub const FLUSH: []const u8 = "0000";
pub const DELIM: []const u8 = "0001";
pub const RESPONSE_END: []const u8 = "0002";

pub fn encodeLine(allocator: std.mem.Allocator, payload: []const u8) ![]u8 {
    // pkt-line: 4 hex digits = len(payload)+4, then payload (+ "\n" if not present by Git convention, but we preserve payload as-is)
    const total: usize = payload.len + 4;
    if (total > 0xFFFF) return error.PktLineTooLong;
    var out = try allocator.alloc(u8, total);
    _ = try std.fmt.bufPrint(out[0..4], "{x:0>4}", .{total});
    @memcpy(out[4..], payload);
    return out;
}

pub fn encodeFlush(allocator: std.mem.Allocator) ![]u8 {
    const out = try allocator.alloc(u8, 4);
    @memcpy(out, "0000");
    return out;
}

/// Iterate pkt-lines from a buffer. Calls `onLine` for each data line, `onFlush` for flush.
pub const Parser = struct {
    data: []const u8,
    pos: usize = 0,

    pub fn next(self: *Parser) !?[]const u8 {
        if (self.pos >= self.data.len) return null;
        if (self.data.len - self.pos < 4) return error.TruncatedPktLine;
        const len_hex = self.data[self.pos .. self.pos + 4];
        if (std.mem.eql(u8, len_hex, "0000")) {
            self.pos += 4;
            return null; // flush marker as null sentinel
        }
        // 0001 delim, 0002 response-end are also sentinel-ish; surface as special payloads
        if (std.mem.eql(u8, len_hex, "0001") or std.mem.eql(u8, len_hex, "0002")) {
            const special = len_hex;
            self.pos += 4;
            return special;
        }
        const len = try std.fmt.parseInt(usize, len_hex, 16);
        if (len < 4) return error.InvalidPktLineLen;
        if (self.pos + len > self.data.len) return error.TruncatedPktLine;
        const payload = self.data[self.pos + 4 .. self.pos + len];
        self.pos += len;
        return payload;
    }

    pub fn nextExpectFlush(self: *Parser) !void {
        const v = try self.next();
        if (v != null) return error.ExpectedFlush;
    }
};

pub fn buildRefsAdvertisement(
    allocator: std.mem.Allocator,
    refs: []const struct { oid_hex: [40]u8, name: []const u8 },
    capabilities: []const []const u8,
) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    // First ref carries capabilities after NUL
    for (refs, 0..) |r, i| {
        var line_buf: std.ArrayList(u8) = .empty;
        defer line_buf.deinit(allocator);
        try line_buf.appendSlice(allocator, r.oid_hex[0..]);
        try line_buf.append(allocator, ' ');
        try line_buf.appendSlice(allocator, r.name);
        try line_buf.append(allocator, '\n');
        if (i == 0 and capabilities.len > 0) {
            try line_buf.append(allocator, 0);
            for (capabilities, 0..) |cap, ci| {
                if (ci != 0) try line_buf.append(allocator, ' ');
                try line_buf.appendSlice(allocator, cap);
            }
            try line_buf.append(allocator, '\n');
        }
        const enc = try encodeLine(allocator, line_buf.items);
        defer allocator.free(enc);
        try out.appendSlice(allocator, enc);
    }
    const flush = try encodeFlush(allocator);
    defer allocator.free(flush);
    try out.appendSlice(allocator, flush);
    return out.toOwnedSlice(allocator);
}

test "pktline encode" {
    const alloc = std.testing.allocator;
    const line = try encodeLine(alloc, "hello\n");
    defer alloc.free(line);
    try std.testing.expectEqualStrings("000ahello\n", line);
    const flush = try encodeFlush(alloc);
    defer alloc.free(flush);
    try std.testing.expectEqualStrings("0000", flush);
}

test "pktline parse" {
    var p = Parser{ .data = "000ahello\n0000" };
    const a = (try p.next()).?;
    try std.testing.expectEqualStrings("hello\n", a);
    const b = try p.next();
    try std.testing.expect(b == null);
}
