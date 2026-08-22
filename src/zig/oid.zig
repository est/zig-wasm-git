const std = @import("std");

pub const LEN = 20;
pub const HEX_LEN = 40;
pub const Oid = [LEN]u8;

pub fn zero() Oid {
    return [_]u8{0} ** LEN;
}

pub fn eql(a: Oid, b: Oid) bool {
    return std.mem.eql(u8, &a, &b);
}

pub fn isZero(o: Oid) bool {
    for (o) |b| if (b != 0) return false;
    return true;
}

pub fn fromHex(s: []const u8) !Oid {
    if (s.len != HEX_LEN) return error.InvalidHexLength;
    var out: Oid = undefined;
    for (0..LEN) |i| {
        const hi = try hexVal(s[2 * i]);
        const lo = try hexVal(s[2 * i + 1]);
        out[i] = (hi << 4) | lo;
    }
    return out;
}

pub fn toHex(o: Oid, out: *[HEX_LEN]u8) void {
    const hex = "0123456789abcdef";
    for (o, 0..) |b, i| {
        out[2 * i] = hex[b >> 4];
        out[2 * i + 1] = hex[b & 0x0f];
    }
}

pub fn toHexAlloc(allocator: std.mem.Allocator, o: Oid) ![]u8 {
    const buf = try allocator.alloc(u8, HEX_LEN);
    toHex(o, buf[0..HEX_LEN]);
    return buf;
}

fn hexVal(c: u8) !u8 {
    return switch (c) {
        '0'...'9' => c - '0',
        'a'...'f' => c - 'a' + 10,
        'A'...'F' => c - 'A' + 10,
        else => error.InvalidHex,
    };
}

test "oid hex roundtrip" {
    const hex = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
    const oid = try fromHex(hex);
    var out: [HEX_LEN]u8 = undefined;
    toHex(oid, &out);
    try std.testing.expectEqualStrings(hex, &out);
}

test "oid zero" {
    try std.testing.expect(isZero(zero()));
}
