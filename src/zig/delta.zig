const std = @import("std");

// Git pack delta format (pack-format.txt):
//   base_size varint (MSB base128 LE) + result_size varint + opcodes.
//   opcode 0xxxxxxx (bit7=0): insert low7 bytes literal (0 = invalid).
//   opcode 1xxxxxxx (bit7=1): copy from base.
//     bits 0..3: offset bytes 0..3 present (LE); bits 4..6: size bytes 0..2 present (LE).
//     size 0 means 0x10000.
// Result length must equal result_size.

pub fn decodeVarint(buf: []const u8) !struct { value: usize, consumed: usize } {
    var value: usize = 0;
    var shift: u6 = 0;
    for (buf, 0..) |b, i| {
        if (shift > 28 and (b & 0x7f) != 0) return error.VarintOverflow;
        value |= @as(usize, b & 0x7f) << @intCast(shift);
        if ((b & 0x80) == 0) return .{ .value = value, .consumed = i + 1 };
        shift += 7;
        if (i >= 4) return error.VarintTooLong;
    }
    return error.Truncated;
}

pub fn encodeVarint(allocator: std.mem.Allocator, out: *std.ArrayList(u8), v: usize) !void {
    var x = v;
    while (true) {
        var b: u8 = @intCast(x & 0x7f);
        x >>= 7;
        if (x != 0) b |= 0x80;
        try out.append(allocator, b);
        if (x == 0) break;
    }
}

pub fn applyDelta(allocator: std.mem.Allocator, base: []const u8, delta: []const u8) ![]u8 {
    const b = try decodeVarint(delta);
    if (b.value != base.len) return error.BadBaseSize;
    var pos: usize = b.consumed;
    const r = try decodeVarint(delta[pos..]);
    pos += r.consumed;
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.ensureTotalCapacity(allocator, r.value);
    while (pos < delta.len) {
        const op = delta[pos];
        pos += 1;
        if ((op & 0x80) == 0) {
            const n: usize = op & 0x7f;
            if (n == 0) return error.BadDeltaOpcode;
            if (pos + n > delta.len) return error.Truncated;
            try out.appendSlice(allocator, delta[pos .. pos + n]);
            pos += n;
        } else {
            var offset: usize = 0;
            var size: usize = 0;
            if ((op & 0x01) != 0) {
                if (pos >= delta.len) return error.Truncated;
                offset |= @as(usize, delta[pos]);
                pos += 1;
            }
            if ((op & 0x02) != 0) {
                if (pos >= delta.len) return error.Truncated;
                offset |= @as(usize, delta[pos]) << 8;
                pos += 1;
            }
            if ((op & 0x04) != 0) {
                if (pos >= delta.len) return error.Truncated;
                offset |= @as(usize, delta[pos]) << 16;
                pos += 1;
            }
            if ((op & 0x08) != 0) {
                if (pos >= delta.len) return error.Truncated;
                offset |= @as(usize, delta[pos]) << 24;
                pos += 1;
            }
            if ((op & 0x10) != 0) {
                if (pos >= delta.len) return error.Truncated;
                size |= @as(usize, delta[pos]);
                pos += 1;
            }
            if ((op & 0x20) != 0) {
                if (pos >= delta.len) return error.Truncated;
                size |= @as(usize, delta[pos]) << 8;
                pos += 1;
            }
            if ((op & 0x40) != 0) {
                if (pos >= delta.len) return error.Truncated;
                size |= @as(usize, delta[pos]) << 16;
                pos += 1;
            }
            if (size == 0) size = 0x10000;
            if (offset + size > base.len) return error.CopyOutOfRange;
            try out.appendSlice(allocator, base[offset .. offset + size]);
        }
    }
    if (out.items.len != r.value) return error.BadResultSize;
    return out.toOwnedSlice(allocator);
}

test "varint roundtrip" {
    const alloc = std.testing.allocator;
    for ([_]usize{ 0, 1, 127, 128, 300, 0x10000, 100 * 1024 }) |v| {
        var out: std.ArrayList(u8) = .empty;
        defer out.deinit(alloc);
        try encodeVarint(alloc, &out, v);
        const d = try decodeVarint(out.items);
        try std.testing.expectEqual(v, d.value);
        try std.testing.expectEqual(out.items.len, d.consumed);
    }
}

test "delta copy+insert" {
    const alloc = std.testing.allocator;
    const base = "hello world, hello git\n";
    // result = "hello zig, hello git\n": copy "hello "(6) + insert "zig" + copy ", hello git\n"(12)
    var delta: std.ArrayList(u8) = .empty;
    defer delta.deinit(alloc);
    try encodeVarint(alloc, &delta, base.len);
    const want = "hello zig, hello git\n";
    try encodeVarint(alloc, &delta, want.len);
    // copy off=0 size=6: op=0x91 (off0+size0), bytes: off0, size0
    try delta.appendSlice(alloc, &[_]u8{ 0x91, 0x00, 0x06 });
    // insert "zig": op=3 + bytes
    try delta.appendSlice(alloc, &[_]u8{ 0x03, 'z', 'i', 'g' });
    // copy off=11(" world," -> skip to ", hello git\n" at off=11): size=12
    try delta.appendSlice(alloc, &[_]u8{ 0x91, 0x0b, 0x0c });
    const got = try applyDelta(alloc, base, delta.items);
    defer alloc.free(got);
    try std.testing.expectEqualStrings(want, got);
}

test "delta rejects bad base size" {
    const alloc = std.testing.allocator;
    var delta: std.ArrayList(u8) = .empty;
    defer delta.deinit(alloc);
    try encodeVarint(alloc, &delta, 999);
    try encodeVarint(alloc, &delta, 1);
    try delta.appendSlice(alloc, &[_]u8{ 0x01, 'x' });
    try std.testing.expectError(error.BadBaseSize, applyDelta(alloc, "hi", delta.items));
}

test "delta copy size 0 means 0x10000" {
    const alloc = std.testing.allocator;
    const base = try alloc.alloc(u8, 0x10000);
    defer alloc.free(base);
    @memset(base, 'a');
    var delta: std.ArrayList(u8) = .empty;
    defer delta.deinit(alloc);
    try encodeVarint(alloc, &delta, base.len);
    try encodeVarint(alloc, &delta, base.len);
    // copy entire base: op=0x80 with no offset/size bytes -> off=0 size=0x10000
    try delta.append(alloc, 0x80);
    const got = try applyDelta(alloc, base, delta.items);
    defer alloc.free(got);
    try std.testing.expectEqualSlices(u8, base, got);
}
