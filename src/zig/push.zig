const std = @import("std");
const pktline = @import("pktline.zig");
const object = @import("object.zig");
const oidmod = @import("oid.zig");

// ─── receive-pack 客户端线协议 (wasm 侧;IO/压缩由 host JS 提供) ──────────────
// 约定:hex 均为小写 40B;emit 由调用方 (wasm.zig) 经 host_emit_bytes 分段输出。

pub const ZERO_OID_HEX: [40]u8 = [_]u8{'0'} ** 40;

// ── pkt-line encode (payload -> "lenhex"+payload) ────────────────────────────
pub fn encodeLine(allocator: std.mem.Allocator, payload: []const u8) ![]u8 {
    return pktline.encodeLine(allocator, payload);
}

pub const AdvLine = union(enum) {
    data: []const u8,
    flush: void,
    delim: void,
};

/// 切分 smart body;返回 payload 切片(借用输入)序列
pub fn splitLines(allocator: std.mem.Allocator, buf: []const u8) ![]AdvLine {
    var out: std.ArrayList(AdvLine) = .empty;
    errdefer out.deinit(allocator);
    var pos: usize = 0;
    while (pos + 4 <= buf.len) {
        const hex = buf[pos .. pos + 4];
        if (std.mem.eql(u8, hex, "0000")) {
            try out.append(allocator, .flush);
            pos += 4;
            continue;
        }
        if (std.mem.eql(u8, hex, "0001")) {
            try out.append(allocator, .delim);
            pos += 4;
            continue;
        }
        const len = std.fmt.parseInt(usize, hex, 16) catch return error.BadPktLen;
        if (len < 4 or pos + len > buf.len) return error.BadPktLen;
        try out.append(allocator, .{ .data = buf[pos + 4 .. pos + len] });
        pos += len;
    }
    return out.toOwnedSlice(allocator);
}

// ── discovery:找 ref 对应 oid ────────────────────────────────────────────────
// 返回:命中 oid(借用输入行内) / null(空仓或无此 ref)
pub fn findRef(advert: []const u8, refname: []const u8) ?[40]u8 {
    var pos: usize = 0;
    while (pos + 4 <= advert.len) {
        const hex = advert[pos .. pos + 4];
        if (std.mem.eql(u8, hex, "0000") or std.mem.eql(u8, hex, "0001")) {
            pos += 4;
            continue;
        }
        const len = std.fmt.parseInt(usize, hex, 16) catch return null;
        if (len < 4 or pos + len > advert.len) return null;
        var line = advert[pos + 4 .. pos + len];
        pos += len;
        if (std.mem.startsWith(u8, line, "# service=")) continue;
        if (std.mem.indexOfScalar(u8, line, 0)) |nul| line = line[0..nul]; // 掐掉 \0caps
        if (line.len < 42) continue;
        const oid_hex = line[0..40];
        if (line[40] != ' ') continue;
        var name = line[41..];
        if (name.len > 0 and name[name.len - 1] == '\n') name = name[0 .. name.len - 1];
        if (std.mem.eql(u8, name, refname)) {
            var out: [40]u8 = undefined;
            @memcpy(&out, oid_hex);
            // 校验 hex 合法
            for (out) |c| {
                if (!std.ascii.isHex(c)) return null;
            }
            // 空仓占位 capabilities^{} 行:调用方按 ref 名匹配,不会命中真实 ref;零 oid 由上层处理
            return out;
        }
    }
    return null;
}

// ── ref-update 命令块 ────────────────────────────────────────────────────────
// updates: [{old40, new40, ref}]; 首行追加 \0caps;末尾 flush 由调用方拼或一次 emit
pub const RefUpdate = struct { old: [40]u8, new: [40]u8, ref: []const u8 };

// ── discovery:列出全部 refs ──────────────────────────────────────────────────
// 跳过 "# service" 行与空仓占位 "capabilities^{}" 行。返回 owned 切片。
pub const AdvertRef = struct {
    oid: [40]u8,
    name: []u8, // owned
};

pub fn listRefs(allocator: std.mem.Allocator, advert: []const u8) ![]AdvertRef {
    var out: std.ArrayList(AdvertRef) = .empty;
    errdefer {
        for (out.items) |r| allocator.free(r.name);
        out.deinit(allocator);
    }
    var pos: usize = 0;
    while (pos + 4 <= advert.len) {
        const hex = advert[pos .. pos + 4];
        if (std.mem.eql(u8, hex, "0000") or std.mem.eql(u8, hex, "0001")) {
            pos += 4;
            continue;
        }
        const len = std.fmt.parseInt(usize, hex, 16) catch return error.BadPktLen;
        if (len < 4 or pos + len > advert.len) return error.BadPktLen;
        var line = advert[pos + 4 .. pos + len];
        pos += len;
        if (std.mem.startsWith(u8, line, "# service=")) continue;
        if (std.mem.indexOfScalar(u8, line, 0)) |nul| line = line[0..nul];
        if (line.len < 42) continue;
        const oid_hex = line[0..40];
        if (line[40] != ' ') continue;
        var name = line[41..];
        if (name.len > 0 and name[name.len - 1] == '\n') name = name[0 .. name.len - 1];
        if (name.len == 0 or std.mem.eql(u8, name, "capabilities^{}")) continue;
        var oid: [40]u8 = undefined;
        @memcpy(&oid, oid_hex);
        var ok = true;
        for (oid) |c| {
            if (!std.ascii.isHex(c)) {
                ok = false;
                break;
            }
        }
        if (!ok) continue;
        try out.append(allocator, .{ .oid = oid, .name = try allocator.dupe(u8, name) });
    }
    return out.toOwnedSlice(allocator);
}

pub fn buildRefUpdate(
    allocator: std.mem.Allocator,
    updates: []const RefUpdate,
    caps: []const u8, // e.g. "report-status" (不主动要 side-band,响应保持纯 pkt-line)
) ![]u8 {
    if (updates.len == 0) return error.NoUpdates;
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    for (updates, 0..) |u, i| {
        var line: std.ArrayList(u8) = .empty;
        defer line.deinit(allocator);
        try line.appendSlice(allocator, &u.old);
        try line.append(allocator, ' ');
        try line.appendSlice(allocator, &u.new);
        try line.append(allocator, ' ');
        try line.appendSlice(allocator, u.ref);
        if (i == 0) {
            try line.append(allocator, 0);
            try line.appendSlice(allocator, caps);
        }
        try line.append(allocator, '\n');
        const el = try pktline.encodeLine(allocator, line.items);
        defer allocator.free(el);
        try out.appendSlice(allocator, el);
    }
    try out.appendSlice(allocator, "0000");
    return out.toOwnedSlice(allocator);
}

// ── report-status 解析 ───────────────────────────────────────────────────────
pub const RefStatus = struct {
    ref: []u8, // owned
    ok: bool,
    msg: []u8, // owned (ok 时为空)
};

pub const ReportStatus = struct {
    allocator: std.mem.Allocator,
    unpack_ok: bool,
    unpack_msg: []u8, // owned ("unpack ok" 或错误原文)
    refs: []RefStatus, // owned

    pub fn deinit(self: *ReportStatus) void {
        self.allocator.free(self.unpack_msg);
        for (self.refs) |r| {
            self.allocator.free(r.ref);
            self.allocator.free(r.msg);
        }
        self.allocator.free(self.refs);
    }
};

pub fn parseReportStatus(allocator: std.mem.Allocator, buf: []const u8) !ReportStatus {
    const lines = try splitLines(allocator, buf);
    defer allocator.free(lines);
    var payloads: std.ArrayList([]const u8) = .empty;
    defer payloads.deinit(allocator);
    for (lines) |l| switch (l) {
        .data => |d| try payloads.append(allocator, d),
        else => {},
    };
    if (payloads.items.len == 0) return error.EmptyStatus;
    const first = std.mem.trim(u8, payloads.items[0], "\r\n");
    var st = ReportStatus{
        .allocator = allocator,
        .unpack_ok = std.mem.eql(u8, first, "unpack ok"),
        .unpack_msg = try allocator.dupe(u8, first),
        .refs = &.{},
    };
    errdefer st.deinit();
    var refs: std.ArrayList(RefStatus) = .empty;
    errdefer {
        for (refs.items) |r| {
            allocator.free(r.ref);
            allocator.free(r.msg);
        }
        refs.deinit(allocator);
    }
    for (payloads.items[1..]) |raw| {
        const t = std.mem.trim(u8, raw, "\r\n");
        if (std.mem.startsWith(u8, t, "ok ")) {
            try refs.append(allocator, .{
                .ref = try allocator.dupe(u8, std.mem.trim(u8, t[3..], " ")),
                .ok = true,
                .msg = try allocator.dupe(u8, ""),
            });
        } else if (std.mem.startsWith(u8, t, "ng ")) {
            const rest = t[3..];
            const sp = std.mem.indexOfScalar(u8, rest, ' ');
            const rn = if (sp) |i| rest[0..i] else rest;
            const msg = if (sp) |i| std.mem.trim(u8, rest[i + 1 ..], " ") else "";
            try refs.append(allocator, .{
                .ref = try allocator.dupe(u8, rn),
                .ok = false,
                .msg = try allocator.dupe(u8, msg),
            });
        } else return error.BadStatusLine;
    }
    st.refs = try refs.toOwnedSlice(allocator);
    return st;
}

// ── pack 对象头 varint (与 pack.zig 同格式,供流式 pack 组装) ──────────────────
pub fn encodePackHeader(allocator: std.mem.Allocator, type_num: u3, size: usize) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    const has_cont = (size >> 4) != 0;
    var first: u8 = (@as(u8, type_num) << 4) | @as(u8, @intCast(size & 0x0f));
    if (has_cont) first |= 0x80;
    try out.append(allocator, first);
    var sz = size >> 4;
    while (sz != 0) {
        var b: u8 = @intCast(sz & 0x7f);
        sz >>= 7;
        if (sz != 0) b |= 0x80;
        try out.append(allocator, b);
    }
    return out.toOwnedSlice(allocator);
}

// ── 对象枚举:从 store 收集 newOid 可达、haves 不可达的全部对象 ────────────────
// Store 抽象:sync get(hex40) -> loose("type len\0body" zlib) 或 null。wasm 侧经
// host_get_object 接线;native 测试用内存 double。顺序: commit, tag, tree, blob。
pub const Store = struct {
    ctx: *anyopaque,
    getFn: *const fn (ctx: *anyopaque, alloc: std.mem.Allocator, hex: [40]u8) anyerror!?[]u8,
    pub fn get(self: Store, alloc: std.mem.Allocator, hex: [40]u8) anyerror!?[]u8 {
        return self.getFn(self.ctx, alloc, hex);
    }
};

pub const Collected = struct { hex: [40]u8, kind: object.Kind, raw_size: usize };

const zlib = @import("zlib.zig");

fn parseLooseParts(alloc: std.mem.Allocator, loose: []const u8) !struct { kind: object.Kind, body: []u8 } {
    const raw = try zlib.decompress(alloc, loose);
    defer alloc.free(raw);
    const nul = std.mem.indexOfScalar(u8, raw, 0) orelse return error.InvalidLooseHeader;
    const header = raw[0..nul];
    const sp = std.mem.indexOfScalar(u8, header, ' ') orelse return error.InvalidLooseHeader;
    const kind = try object.kindFromStr(header[0..sp]);
    const len = try std.fmt.parseInt(usize, header[sp + 1 ..], 10);
    if (len != raw.len - nul - 1) return error.LooseLengthMismatch;
    return .{ .kind = kind, .body = try alloc.dupe(u8, raw[nul + 1 ..]) };
}

fn hexLower(hex: [40]u8) [40]u8 {
    var out = hex;
    for (&out) |*c| c.* = std.ascii.toLower(c.*);
    return out;
}

fn hasSeenList(list: [][20]u8, b: [20]u8) bool {
    for (list) |e| if (std.mem.eql(u8, &e, &b)) return true;
    return false;
}

/// phase0:把 haves 可达闭包标进 seen(容忍缺失)。roots 为 hex40 列表。
fn markReachable(
    alloc: std.mem.Allocator,
    store: Store,
    haves: []const [40]u8,
    seen: *std.ArrayList([20]u8),
) !void {
    var queue: std.ArrayList([20]u8) = .empty;
    defer queue.deinit(alloc);
    var tqueue: std.ArrayList([20]u8) = .empty;
    defer tqueue.deinit(alloc);
    for (haves) |h| {
        var lh = hexLower(h);
        const b = oidmod.fromHex(&lh) catch continue;
        if (!hasSeenList(seen.items, b)) try queue.append(alloc, b);
    }
    while (queue.items.len > 0) {
        const b = queue.pop().?;
        if (hasSeenList(seen.items, b)) continue;
        var hex: [40]u8 = undefined;
        oidmod.toHex(b, &hex);
        const loose = (try store.get(alloc, hex)) orelse continue;
        defer alloc.free(loose);
        const parts = parseLooseParts(alloc, loose) catch continue;
        defer alloc.free(parts.body);
        try seen.append(alloc, b);
        switch (parts.kind) {
            .commit => {
                var it = std.mem.splitScalar(u8, parts.body, '\n');
                while (it.next()) |line| {
                    if (std.mem.startsWith(u8, line, "parent ") and line.len >= 47) {
                        var h: [40]u8 = undefined;
                        @memcpy(&h, line[7..47]);
                        var lhp = hexLower(h);
                        const pb = oidmod.fromHex(&lhp) catch continue;
                        if (!hasSeenList(seen.items, pb)) try queue.append(alloc, pb);
                    } else if (std.mem.startsWith(u8, line, "tree ") and line.len >= 45) {
                        var h: [40]u8 = undefined;
                        @memcpy(&h, line[5..45]);
                        var lht = hexLower(h);
                        const tb = oidmod.fromHex(&lht) catch continue;
                        if (!hasSeenList(seen.items, tb)) try tqueue.append(alloc, tb);
                    } else if (line.len == 0) break;
                }
            },
            .tag => {
                var it = std.mem.splitScalar(u8, parts.body, '\n');
                while (it.next()) |line| {
                    if (std.mem.startsWith(u8, line, "object ") and line.len >= 47) {
                        var h: [40]u8 = undefined;
                        @memcpy(&h, line[7..47]);
                        var lho = hexLower(h);
                        const tb = oidmod.fromHex(&lho) catch continue;
                        if (!hasSeenList(seen.items, tb)) try queue.append(alloc, tb);
                    } else if (line.len == 0) break;
                }
            },
            .tree => {
                if (!hasSeenList(seen.items, b)) try tqueue.append(alloc, b);
            },
            .blob => {},
        }
    }
    while (tqueue.items.len > 0) {
        const b = tqueue.pop().?;
        if (hasSeenList(seen.items, b)) continue;
        var hex: [40]u8 = undefined;
        oidmod.toHex(b, &hex);
        const loose = (try store.get(alloc, hex)) orelse continue;
        defer alloc.free(loose);
        const parts = parseLooseParts(alloc, loose) catch continue;
        defer alloc.free(parts.body);
        if (parts.kind != .tree) {
            try seen.append(alloc, b);
            continue;
        }
        try seen.append(alloc, b);
        const ents = object.parseTree(alloc, parts.body) catch continue;
        defer {
            for (ents) |e| {
                alloc.free(e.mode);
                alloc.free(e.name);
            }
            alloc.free(ents);
        }
        for (ents) |e| {
            const eb = oidmod.fromHex(&e.oid_hex) catch continue;
            if (hasSeenList(seen.items, eb)) continue;
            if (std.mem.eql(u8, e.mode, "40000") or std.mem.eql(u8, e.mode, "040000")) {
                try tqueue.append(alloc, eb);
            } else if (!std.mem.eql(u8, e.mode, "160000")) {
                try seen.append(alloc, eb); // blob:只标不取
            }
        }
    }
}

/// haves: 已知服务端拥有的 hex 列表(小写或大小写均可)。返回 owned 切片,调用方释放。
pub fn collectObjects(
    alloc: std.mem.Allocator,
    store: Store,
    new_hex: [40]u8,
    haves: []const [40]u8,
) ![]Collected {
    var seen: std.ArrayList([20]u8) = .empty;
    defer seen.deinit(alloc);
    var out: std.ArrayList(Collected) = .empty;
    errdefer out.deinit(alloc);

    const hasSeen = struct {
        fn f(list: [][20]u8, b: [20]u8) bool {
            for (list) |e| if (std.mem.eql(u8, &e, &b)) return true;
            return false;
        }
    }.f;
    const mark = struct {
        fn f(a: std.mem.Allocator, list: *std.ArrayList([20]u8), b: [20]u8) !void {
            try list.append(a, b);
        }
    }.f;

    // phase0:把 haves 的完全闭包标进 seen(容忍缺失:标不到就多发,不报错)
    try markReachable(alloc, store, haves, &seen);

    // phase1: commit BFS
    var cqueue: std.ArrayList([20]u8) = .empty;
    defer cqueue.deinit(alloc);
    var tree_roots: std.ArrayList([20]u8) = .empty;
    defer tree_roots.deinit(alloc);
    var lh_new = hexLower(new_hex);
    const new_bytes = oidmod.fromHex(&lh_new) catch return error.BadOid;
    // new 本身可能是 tag:先取一次看类型
    {
        const loose = (try store.get(alloc, hexLower(new_hex))) orelse return error.ObjectNotFound;
        defer alloc.free(loose);
        const parts = try parseLooseParts(alloc, loose);
        defer alloc.free(parts.body);
        if (parts.kind == .tag) {
            if (!hasSeen(seen.items, new_bytes)) {
                try mark(alloc, &seen, new_bytes);
                try out.append(alloc, .{ .hex = hexLower(new_hex), .kind = .tag, .raw_size = parts.body.len });
            }
            // tag 目标: "object <hex>\ntype <t>"
            var obj_hex: ?[40]u8 = null;
            var obj_type: ?object.Kind = null;
            var it = std.mem.splitScalar(u8, parts.body, '\n');
            while (it.next()) |line| {
                if (std.mem.startsWith(u8, line, "object ") and line.len >= 47) {
                    var h: [40]u8 = undefined;
                    @memcpy(&h, line[7..47]);
                    obj_hex = hexLower(h);
                } else if (std.mem.startsWith(u8, line, "type ")) {
                    obj_type = object.kindFromStr(std.mem.trim(u8, line[5..], " \r")) catch null;
                } else if (line.len == 0) break;
            }
            const th = obj_hex orelse return error.BadTag;
            const tt = obj_type orelse return error.BadTag;
            const tb = oidmod.fromHex(&th) catch return error.BadOid;
            if (!hasSeen(seen.items, tb)) {
                switch (tt) {
                    .commit => try cqueue.append(alloc, tb),
                    .tree => try tree_roots.append(alloc, tb),
                    .blob => {
                        try mark(alloc, &seen, tb);
                        const ll = (try store.get(alloc, th)) orelse return error.ObjectNotFound;
                        defer alloc.free(ll);
                        const bp = try parseLooseParts(alloc, ll);
                        defer alloc.free(bp.body);
                        try out.append(alloc, .{ .hex = th, .kind = .blob, .raw_size = bp.body.len });
                    },
                    .tag => return error.NestedTagTodo,
                }
            }
        } else if (parts.kind == .commit) {
            try cqueue.append(alloc, new_bytes);
        } else return error.NewOidNotCommitOrTag;
    }

    while (cqueue.items.len > 0) {
        const b = cqueue.pop().?;
        if (hasSeen(seen.items, b)) continue;
        var hex: [40]u8 = undefined;
        oidmod.toHex(b, &hex);
        const loose = (try store.get(alloc, hex)) orelse return error.ObjectNotFound;
        defer alloc.free(loose);
        const parts = try parseLooseParts(alloc, loose);
        defer alloc.free(parts.body);
        if (parts.kind != .commit) return error.NotACommit;
        try mark(alloc, &seen, b);
        try out.append(alloc, .{ .hex = hex, .kind = .commit, .raw_size = parts.body.len });
        // parents + tree
        var it = std.mem.splitScalar(u8, parts.body, '\n');
        while (it.next()) |line| {
            if (std.mem.startsWith(u8, line, "parent ") and line.len >= 47) {
                var h: [40]u8 = undefined;
                @memcpy(&h, line[7..47]);
                var lhp = hexLower(h);
                const pb = oidmod.fromHex(&lhp) catch continue;
                if (!hasSeen(seen.items, pb)) try cqueue.append(alloc, pb);
            } else if (std.mem.startsWith(u8, line, "tree ") and line.len >= 45) {
                var h: [40]u8 = undefined;
                @memcpy(&h, line[5..45]);
                var lht = hexLower(h);
                const tb = oidmod.fromHex(&lht) catch continue;
                if (!hasSeen(seen.items, tb)) try tree_roots.append(alloc, tb);
            } else if (line.len == 0) break;
        }
    }

    // phase2: tree DFS;phase3: blob 收集
    var blobs: std.ArrayList(Collected) = .empty;
    defer blobs.deinit(alloc);
    var tqueue = tree_roots;
    while (tqueue.items.len > 0) {
        const b = tqueue.pop().?;
        if (hasSeen(seen.items, b)) continue;
        var hex: [40]u8 = undefined;
        oidmod.toHex(b, &hex);
        const loose = (try store.get(alloc, hex)) orelse return error.ObjectNotFound;
        defer alloc.free(loose);
        const parts = try parseLooseParts(alloc, loose);
        defer alloc.free(parts.body);
        if (parts.kind != .tree) return error.NotATree;
        try mark(alloc, &seen, b);
        try out.append(alloc, .{ .hex = hex, .kind = .tree, .raw_size = parts.body.len });
        const entries = try object.parseTree(alloc, parts.body);
        defer {
            for (entries) |e| {
                alloc.free(e.mode);
                alloc.free(e.name);
            }
            alloc.free(entries);
        }
        for (entries) |e| {
            const eb = oidmod.fromHex(&e.oid_hex) catch continue;
            if (hasSeen(seen.items, eb)) continue;
            if (std.mem.eql(u8, e.mode, "40000") or std.mem.eql(u8, e.mode, "040000")) {
                try tqueue.append(alloc, eb);
            } else if (std.mem.eql(u8, e.mode, "160000")) {
                continue; // gitlink:不打包
            } else {
                const ll = (try store.get(alloc, e.oid_hex)) orelse return error.ObjectNotFound;
                defer alloc.free(ll);
                const bp = try parseLooseParts(alloc, ll);
                defer alloc.free(bp.body);
                if (bp.kind != .blob) return error.NotABlob;
                try mark(alloc, &seen, eb);
                try blobs.append(alloc, .{ .hex = e.oid_hex, .kind = .blob, .raw_size = bp.body.len });
            }
        }
    }
    try out.appendSlice(alloc, blobs.items);
    return out.toOwnedSlice(alloc);
}

test "findRef basic + empty repo" {
    // "# service" + 首行带 caps + flush
    const adv = "0033# service=git-receive-pack\n000000ab000000000000000000000000000000000000 main\x00report-status\n0000";
    _ = adv;
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(std.testing.allocator);
    const a = std.testing.allocator;
    {
        const l1 = try pktline.encodeLine(a, "# service=git-receive-pack\n");
        defer a.free(l1);
        try buf.appendSlice(a, l1);
    }
    {
        const refline = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main\x00report-status side-band-64k\n";
        const l2 = try pktline.encodeLine(a, refline);
        defer a.free(l2);
        try buf.appendSlice(a, l2);
    }
    try buf.appendSlice(a, "0000");
    const hit = findRef(buf.items, "refs/heads/main");
    try std.testing.expect(hit != null);
    try std.testing.expectEqualStrings("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", &hit.?);
    try std.testing.expect(findRef(buf.items, "refs/heads/nope") == null);
}

test "listRefs multi + empty" {
    const a = std.testing.allocator;
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(a);
    {
        const l1 = try pktline.encodeLine(a, "# service=git-receive-pack\n");
        defer a.free(l1);
        try buf.appendSlice(a, l1);
    }
    {
        const l2 = try pktline.encodeLine(a, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main\x00report-status\n");
        defer a.free(l2);
        try buf.appendSlice(a, l2);
    }
    {
        const l3 = try pktline.encodeLine(a, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/tags/v1\n");
        defer a.free(l3);
        try buf.appendSlice(a, l3);
    }
    try buf.appendSlice(a, "0000");
    const refs = try listRefs(a, buf.items);
    defer {
        for (refs) |r| a.free(r.name);
        a.free(refs);
    }
    try std.testing.expectEqual(@as(usize, 2), refs.len);
    try std.testing.expectEqualStrings("refs/heads/main", refs[0].name);
    try std.testing.expectEqualStrings("refs/tags/v1", refs[1].name);

    // 空仓:只有占位行 -> 0
    buf.clearRetainingCapacity();
    {
        const l1 = try pktline.encodeLine(a, "# service=git-receive-pack\n");
        defer a.free(l1);
        try buf.appendSlice(a, l1);
    }
    {
        const cap = ZERO_OID_HEX ++ " capabilities^{}\x00report-status\n";
        const l2 = try pktline.encodeLine(a, cap);
        defer a.free(l2);
        try buf.appendSlice(a, l2);
    }
    try buf.appendSlice(a, "0000");
    const refs2 = try listRefs(a, buf.items);
    defer {
        for (refs2) |r| a.free(r.name);
        a.free(refs2);
    }
    try std.testing.expectEqual(@as(usize, 0), refs2.len);
}

test "findRef empty repo placeholder" {    const a = std.testing.allocator;
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(a);
    {
        const l1 = try pktline.encodeLine(a, "# service=git-receive-pack\n");
        defer a.free(l1);
        try buf.appendSlice(a, l1);
    }
    {
        const cap = ZERO_OID_HEX ++ " capabilities^{}\x00report-status\n";
        const l2 = try pktline.encodeLine(a, cap);
        defer a.free(l2);
        try buf.appendSlice(a, l2);
    }
    try buf.appendSlice(a, "0000");
    try std.testing.expect(findRef(buf.items, "refs/heads/main") == null);
}

test "buildRefUpdate + parseReportStatus roundtrip" {
    const a = std.testing.allocator;
    const old = [_]u8{'0'} ** 40;
    const new = [_]u8{'a'} ** 40;
    const ups = [_]RefUpdate{
        .{ .old = old, .new = new, .ref = "refs/heads/main" },
    };
    const req = try buildRefUpdate(a, &ups, "report-status");
    defer a.free(req);
    // 首行: pkt len hex + "00..00 aa..aa refs/heads/main\0report-status\n"
    try std.testing.expect(std.mem.endsWith(u8, req, "0000"));
    try std.testing.expect(std.mem.indexOf(u8, req, "refs/heads/main\x00report-status\n") != null);

    var sbuf: std.ArrayList(u8) = .empty;
    defer sbuf.deinit(a);
    {
        const l = try pktline.encodeLine(a, "unpack ok\n");
        defer a.free(l);
        try sbuf.appendSlice(a, l);
    }
    {
        const l = try pktline.encodeLine(a, "ok refs/heads/main\n");
        defer a.free(l);
        try sbuf.appendSlice(a, l);
    }
    {
        const l = try pktline.encodeLine(a, "ng refs/heads/x conflict\n");
        defer a.free(l);
        try sbuf.appendSlice(a, l);
    }
    try sbuf.appendSlice(a, "0000");
    var st = try parseReportStatus(a, sbuf.items);
    defer st.deinit();
    try std.testing.expect(st.unpack_ok);
    try std.testing.expectEqual(@as(usize, 2), st.refs.len);
    try std.testing.expect(st.refs[0].ok);
    try std.testing.expect(!st.refs[1].ok);
    try std.testing.expectEqualStrings("conflict", st.refs[1].msg);
}

test "collectObjects basic + incremental" {
    const a = std.testing.allocator;
    var map = std.StringHashMap([]u8).init(a);
    defer {
        var it = map.iterator();
        while (it.next()) |e| {
            a.free(e.key_ptr.*);
            a.free(e.value_ptr.*);
        }
        map.deinit();
    }
    const Ctx = struct {
        var test_map: ?*std.StringHashMap([]u8) = null;
        fn get(ctx: *anyopaque, alloc: std.mem.Allocator, hex: [40]u8) anyerror!?[]u8 {
            _ = ctx;
            const v = test_map.?.get(&hex) orelse return null;
            return try alloc.dupe(u8, v);
        }
    };
    Ctx.test_map = &map;
    const store = Store{ .ctx = undefined, .getFn = Ctx.get };

    const put = struct {
        fn f(m: *std.StringHashMap([]u8), al: std.mem.Allocator, kind: object.Kind, body: []const u8) ![40]u8 {
            const r = try object.hashObject(al, kind, body);
            defer al.free(r.loose);
            var hex: [40]u8 = undefined;
            oidmod.toHex(r.oid_val, &hex);
            try m.put(try al.dupe(u8, &hex), try al.dupe(u8, r.loose));
            return hex;
        }
    }.f;

    const blob1 = try put(&map, a, .blob, "hi\n");
    const blobA = try put(&map, a, .blob, "a\n");
    var sub_raw: std.ArrayList(u8) = .empty;
    defer sub_raw.deinit(a);
    try sub_raw.appendSlice(a, "100644 a.txt");
    try sub_raw.append(a, 0);
    try sub_raw.appendSlice(a, &(oidmod.fromHex(&blobA) catch unreachable));
    const subtree1 = try put(&map, a, .tree, sub_raw.items);
    var tree_body: std.ArrayList(u8) = .empty;
    defer tree_body.deinit(a);
    try tree_body.appendSlice(a, "100644 ");
    try tree_body.appendSlice(a, "f.txt");
    try tree_body.append(a, 0);
    try tree_body.appendSlice(a, &(oidmod.fromHex(&blob1) catch unreachable));
    try tree_body.appendSlice(a, "40000 src");
    try tree_body.append(a, 0);
    try tree_body.appendSlice(a, &(oidmod.fromHex(&subtree1) catch unreachable));
    const tree1 = try put(&map, a, .tree, tree_body.items);
    var c1_body: std.ArrayList(u8) = .empty;
    defer c1_body.deinit(a);
    try c1_body.appendSlice(a, "tree ");
    try c1_body.appendSlice(a, &tree1);
    try c1_body.appendSlice(a, "\nauthor t <t@t> 0 +0000\ncommitter t <t@t> 0 +0000\n\ninit\n");
    const commit1 = try put(&map, a, .commit, c1_body.items);

    // 全量:commit,tree,subtree,blob1,blobA = 5
    {
        const got = try collectObjects(a, store, commit1, &.{});
        defer a.free(got);
        try std.testing.expectEqual(@as(usize, 5), got.len);
        try std.testing.expectEqual(object.Kind.commit, got[0].kind);
        try std.testing.expectEqual(object.Kind.tree, got[1].kind);
        try std.testing.expectEqual(object.Kind.tree, got[2].kind);
        try std.testing.expectEqual(object.Kind.blob, got[3].kind);
        try std.testing.expectEqual(object.Kind.blob, got[4].kind);
    }
    // haves=commit1 -> 空
    {
        const got = try collectObjects(a, store, commit1, &[_][40]u8{commit1});
        defer a.free(got);
        try std.testing.expectEqual(@as(usize, 0), got.len);
    }
    // 增量:只改 f.txt,保留 src/ 子树;应恰好 commit2+tree2+blob2 = 3,旧子树复用
    const blob2 = try put(&map, a, .blob, "v2\n");
    var t2_body: std.ArrayList(u8) = .empty;
    defer t2_body.deinit(a);
    try t2_body.appendSlice(a, "100644 ");
    try t2_body.appendSlice(a, "f.txt");
    try t2_body.append(a, 0);
    try t2_body.appendSlice(a, &(oidmod.fromHex(&blob2) catch unreachable));
    try t2_body.appendSlice(a, "40000 src");
    try t2_body.append(a, 0);
    try t2_body.appendSlice(a, &(oidmod.fromHex(&subtree1) catch unreachable));
    const tree2 = try put(&map, a, .tree, t2_body.items);
    var c2_body: std.ArrayList(u8) = .empty;
    defer c2_body.deinit(a);
    try c2_body.appendSlice(a, "tree ");
    try c2_body.appendSlice(a, &tree2);
    try c2_body.appendSlice(a, "\nparent ");
    try c2_body.appendSlice(a, &commit1);
    try c2_body.appendSlice(a, "\nauthor t <t@t> 0 +0000\ncommitter t <t@t> 0 +0000\n\nv2\n");
    const commit2 = try put(&map, a, .commit, c2_body.items);
    {
        const got = try collectObjects(a, store, commit2, &[_][40]u8{commit1});
        defer a.free(got);
        try std.testing.expectEqual(@as(usize, 3), got.len);
        try std.testing.expectEqualStrings(&commit2, &got[0].hex);
        try std.testing.expectEqualStrings(&tree2, &got[1].hex);
        try std.testing.expectEqualStrings(&blob2, &got[2].hex);
    }
    Ctx.test_map = null;
}

test "pack header small/large sizes" {    const a = std.testing.allocator;
    {
        const h = try encodePackHeader(a, 3, 6);
        defer a.free(h);
        try std.testing.expectEqual(@as(usize, 1), h.len);
        try std.testing.expectEqual(@as(u8, 0x36), h[0]);
    }
    {
        // size 12000 blob:首字节 cont 置位 + 后续 varint
        const h = try encodePackHeader(a, 3, 12000);
        defer a.free(h);
        try std.testing.expect((h[0] & 0x80) != 0);
        try std.testing.expectEqual(@as(u8, 3), (h[0] >> 4) & 0x07);
        // 解码回 size
        var size: usize = h[0] & 0x0f;
        var shift: usize = 4;
        var i: usize = 1;
        var cont = (h[0] & 0x80) != 0;
        while (cont) {
            size |= @as(usize, h[i] & 0x7f) << @intCast(shift);
            shift += 7;
            cont = (h[i] & 0x80) != 0;
            i += 1;
        }
        try std.testing.expectEqual(@as(usize, 12000), size);
    }
}
