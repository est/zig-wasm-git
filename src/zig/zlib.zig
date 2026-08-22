const std = @import("std");

const Adler32 = std.hash.Adler32;

pub fn compress(allocator: std.mem.Allocator, data: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.appendSlice(allocator, &[_]u8{ 0x78, 0x9c });
    var off: usize = 0;
    while (off < data.len) {
        const chunk_len: usize = @min(65535, data.len - off);
        const is_final: u8 = if (off + chunk_len == data.len) 1 else 0;
        try out.append(allocator, is_final);
        const len: u16 = @intCast(chunk_len);
        const nlen: u16 = ~len;
        var lb: [2]u8 = undefined;
        std.mem.writeInt(u16, &lb, len, .little);
        try out.appendSlice(allocator, &lb);
        var nlb: [2]u8 = undefined;
        std.mem.writeInt(u16, &nlb, nlen, .little);
        try out.appendSlice(allocator, &nlb);
        try out.appendSlice(allocator, data[off .. off + chunk_len]);
        off += chunk_len;
    }
    if (data.len == 0) {
        try out.append(allocator, 0x01);
        try out.appendSlice(allocator, &[_]u8{ 0x00, 0x00, 0xFF, 0xFF });
    }
    var a: Adler32 = .{};
    a.update(data);
    var adler_be: [4]u8 = undefined;
    std.mem.writeInt(u32, &adler_be, a.adler, .big);
    try out.appendSlice(allocator, &adler_be);
    return out.toOwnedSlice(allocator);
}

pub fn decompress(allocator: std.mem.Allocator, zlib_data: []const u8) ![]u8 {
    if (zlib_data.len >= 2 and zlib_data[0] == 0x78) {
        var in_reader: std.Io.Reader = .fixed(zlib_data);
        const window: []u8 = try allocator.alloc(u8, std.compress.flate.max_window_len);
        defer allocator.free(window);
        var decomp = std.compress.flate.Decompress.init(&in_reader, .zlib, window);
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(allocator);
        while (true) {
            const chunk = decomp.reader.peekGreedy(1) catch |err| switch (err) {
                error.ReadFailed => {
                    if (decomp.err) |e| return e;
                    return err;
                },
                error.EndOfStream => break,
            };
            if (chunk.len == 0) break;
            try out.appendSlice(allocator, chunk);
            decomp.reader.toss(chunk.len);
        }
        if (out.items.len > 0 or zlib_data.len == 6) {
            return out.toOwnedSlice(allocator);
        }
        out.deinit(allocator);
    }
    return decompressStored(allocator, zlib_data);
}

fn decompressStored(allocator: std.mem.Allocator, data: []const u8) ![]u8 {
    if (data.len < 2) return error.BadZlibHeader;
    if (data[0] != 0x78) return error.BadZlibHeader;
    var pos: usize = 2;
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    while (true) {
        if (pos >= data.len) return error.Truncated;
        const hdr = data[pos];
        pos += 1;
        const is_final = hdr & 0x01;
        const btype = (hdr >> 1) & 0x03;
        if (btype != 0) return error.UnsupportedBlockType;
        if (pos + 4 > data.len) return error.Truncated;
        const len = std.mem.readInt(u16, data[pos..][0..2], .little);
        const nlen = std.mem.readInt(u16, data[pos + 2 ..][0..2], .little);
        pos += 4;
        if (nlen != ~len) return error.BadStoredLen;
        if (pos + len + 4 > data.len and is_final == 0) return error.Truncated;
        if (len > 0) {
            if (pos + len > data.len) return error.Truncated;
            try out.appendSlice(allocator, data[pos .. pos + len]);
            pos += len;
        }
        if (is_final != 0) break;
    }
    if (pos + 4 != data.len) return error.BadAdlerLen;
    const stored_adler = std.mem.readInt(u32, data[pos..][0..4], .big);
    var a: Adler32 = .{};
    a.update(out.items);
    if (a.adler != stored_adler) return error.BadAdler;
    return out.toOwnedSlice(allocator);
}

test "zlib roundtrip" {
    const alloc = std.testing.allocator;
    const src = "hello world, hello git, hello zig wasm\n";
    const c = try compress(alloc, src);
    defer alloc.free(c);
    const d = try decompress(alloc, c);
    defer alloc.free(d);
    try std.testing.expectEqualStrings(src, d);
}

test "zlib empty" {
    const alloc = std.testing.allocator;
    const c = try compress(alloc, "");
    defer alloc.free(c);
    const d = try decompress(alloc, c);
    defer alloc.free(d);
    try std.testing.expectEqualStrings("", d);
}
