const std = @import("std");

// Minimal byte encoders — avoids pulling in std.fmt's full formatter (~30KB wasm).

/// write u16 as 4 lowercase hex digits
pub fn hex4(out: *[4]u8, v: u16) void {
    const hexchars = "0123456789abcdef";
    out[0] = hexchars[(v >> 12) & 0xf];
    out[1] = hexchars[(v >> 8) & 0xf];
    out[2] = hexchars[(v >> 4) & 0xf];
    out[3] = hexchars[v & 0xf];
}

/// write decimal digits of v into out (unpadded); returns bytes written
pub fn dec(out: []u8, v: u64) usize {
    if (v == 0) {
        out[0] = '0';
        return 1;
    }
    var tmp: [20]u8 = undefined;
    var n: usize = 0;
    var x = v;
    while (x > 0) : (x /= 10) {
        tmp[n] = @intCast('0' + (x % 10));
        n += 1;
    }
    var i: usize = 0;
    while (i < n) : (i += 1) out[i] = tmp[n - 1 - i];
    return n;
}

/// "<typ> <size>\x00" into out; returns full header length
pub fn objectHeader(out: []u8, typ: []const u8, size: u64) usize {
    var pos: usize = 0;
    @memcpy(out[0..typ.len], typ);
    pos += typ.len;
    out[pos] = ' ';
    pos += 1;
    pos += dec(out[pos..], size);
    out[pos] = 0;
    return pos + 1;
}
