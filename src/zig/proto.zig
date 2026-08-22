const std = @import("std");
const pktline = @import("pktline.zig");

pub const Service = enum { upload_pack, receive_pack };

pub fn discoveryContentType(svc: Service) []const u8 {
    return switch (svc) {
        .upload_pack => "application/x-git-upload-pack-advertisement",
        .receive_pack => "application/x-git-receive-pack-advertisement",
    };
}

pub fn resultContentType(svc: Service) []const u8 {
    return switch (svc) {
        .upload_pack => "application/x-git-upload-pack-result",
        .receive_pack => "application/x-git-receive-pack-result",
    };
}

pub fn discoveryPrefix(svc: Service) []const u8 {
    return switch (svc) {
        .upload_pack => "# service=git-upload-pack\n",
        .receive_pack => "# service=git-receive-pack\n",
    };
}

pub fn buildDiscoveryResponse(
    allocator: std.mem.Allocator,
    svc: Service,
    refs_advertisement: []const u8, // already pkt-line encoded refs + flush
) ![]u8 {
    const prefix = discoveryPrefix(svc);
    // first pkt-line: len(prefix)+4 + prefix
    const first = try pktline.encodeLine(allocator, prefix);
    defer allocator.free(first);
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.appendSlice(allocator, first);
    try out.appendSlice(allocator, refs_advertisement);
    return out.toOwnedSlice(allocator);
}

pub fn parseWantLines(
    allocator: std.mem.Allocator,
    pkt_data: []const u8,
) !struct { wants: [][]u8, haves: [][]u8, filters: [][]u8 } {
    var wants: std.ArrayList([]u8) = .empty;
    errdefer {
        for (wants.items) |w| allocator.free(w);
        wants.deinit(allocator);
    }
    var haves: std.ArrayList([]u8) = .empty;
    errdefer {
        for (haves.items) |w| allocator.free(w);
        haves.deinit(allocator);
    }
    var filters: std.ArrayList([]u8) = .empty;
    errdefer {
        for (filters.items) |w| allocator.free(w);
        filters.deinit(allocator);
    }

    var parser = pktline.Parser{ .data = pkt_data };
    while (true) {
        const line_opt = try parser.next();
        const line = line_opt orelse break; // flush ends want/have section
        if (std.mem.eql(u8, line, "0001") or std.mem.eql(u8, line, "0002")) continue;
        const trimmed = std.mem.trim(u8, line, " \r\n");
        if (std.mem.startsWith(u8, trimmed, "want ")) {
            const oid_hex = std.mem.trim(u8, trimmed["want ".len..], " \r\n");
            // first want may carry capabilities after space; strip
            const sp = std.mem.indexOfScalar(u8, oid_hex, ' ');
            const hex_only = if (sp) |i| oid_hex[0..i] else oid_hex;
            try wants.append(allocator, try allocator.dupe(u8, hex_only));
        } else if (std.mem.startsWith(u8, trimmed, "have ")) {
            const hex = std.mem.trim(u8, trimmed["have ".len..], " \r\n");
            try haves.append(allocator, try allocator.dupe(u8, hex));
        } else if (std.mem.startsWith(u8, trimmed, "filter ")) {
            const spec = std.mem.trim(u8, trimmed["filter ".len..], " \r\n");
            try filters.append(allocator, try allocator.dupe(u8, spec));
        } else if (std.mem.eql(u8, trimmed, "done")) {
            break;
        }
    }
    return .{
        .wants = try wants.toOwnedSlice(allocator),
        .haves = try haves.toOwnedSlice(allocator),
        .filters = try filters.toOwnedSlice(allocator),
    };
}

test "want parse" {
    const alloc = std.testing.allocator;
    const pkt = "0032want abcdef0123456789abcdef0123456789abcdef01\n00000009done\n";
    const r = try parseWantLines(alloc, pkt);
    defer {
        for (r.wants) |w| alloc.free(w);
        alloc.free(r.wants);
        for (r.haves) |h| alloc.free(h);
        alloc.free(r.haves);
        for (r.filters) |f| alloc.free(f);
        alloc.free(r.filters);
    }
    try std.testing.expectEqual(@as(usize, 1), r.wants.len);
}
