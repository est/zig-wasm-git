const std = @import("std");
const Sha1 = std.crypto.hash.Sha1;

pub const LEN = Sha1.digest_length;

pub fn hash(data: []const u8) [LEN]u8 {
    var out: [LEN]u8 = undefined;
    Sha1.hash(data, &out, .{});
    return out;
}

pub fn hashHeader(typ: []const u8, body: []const u8) [LEN]u8 {
    var h = Sha1.init(.{});
    var header_buf: [64]u8 = undefined;
    const header = std.fmt.bufPrint(&header_buf, "{s} {d}\x00", .{ typ, body.len }) catch unreachable;
    h.update(header);
    h.update(body);
    var out: [LEN]u8 = undefined;
    h.final(&out);
    return out;
}

/// streaming hasher for loose/pack objects
pub const Hasher = struct {
    inner: Sha1,

    pub fn init() Hasher {
        return .{ .inner = Sha1.init(.{}) };
    }
    pub fn update(self: *Hasher, data: []const u8) void {
        self.inner.update(data);
    }
    pub fn final(self: *Hasher) [LEN]u8 {
        var out: [LEN]u8 = undefined;
        self.inner.final(&out);
        return out;
    }
    pub fn peek(self: Hasher) [LEN]u8 {
        var c = self;
        return c.final();
    }
};

test "sha1 empty matches git empty tree object sort" {
    // empty blob is well-known: "blob 0\0" -> e69de29...
    const oid = hashHeader("blob", "");
    var hex: [40]u8 = undefined;
    const hexchars = "0123456789abcdef";
    for (oid, 0..) |b, i| {
        hex[2 * i] = hexchars[b >> 4];
        hex[2 * i + 1] = hexchars[b & 0x0f];
    }
    try std.testing.expectEqualStrings("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", &hex);
}
