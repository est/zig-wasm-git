const std = @import("std");
const filter = @import("filter.zig");
const object = @import("object.zig");

// Wire partial clone/filter negotiation helpers.
// Client sends: "filter <spec>" pkt-lines inside upload-pack request (v2) or via filter capability.
// Server (Host) asks WASM: parse request filter lines → FilterSet → Host applies filter when enumerating objects.

pub const FilterSet = struct {
    specs: []filter.Spec,
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) FilterSet {
        return .{ .specs = &.{}, .allocator = allocator };
    }

    pub fn deinit(self: *FilterSet) void {
        for (self.specs) |s| self.allocator.free(s.raw);
        self.allocator.free(self.specs);
    }

    pub fn addRaw(self: *FilterSet, raw: []const u8) !void {
        const specs = try filter.parseCombine(self.allocator, raw);
        // specs owns raw dupes; we take them
        var new_list: std.ArrayList(filter.Spec) = .empty;
        errdefer new_list.deinit(self.allocator);
        try new_list.appendSlice(self.allocator, self.specs);
        try new_list.appendSlice(self.allocator, specs);
        self.allocator.free(self.specs);
        self.allocator.free(specs); // only frees slice, not raws (they're moved)
        // Actually parseCombine allocated slice + each raw; we moved raws, so need to keep slice but not double-free.
        // Simpler: parse one-by-one via parseCombine per spec is messy. We'll reimplement: parseCombine already duped raws.
        // To avoid double-free confusion, we leak `specs` slice after moving (already freed slice header above).
        // Keep new list as specs.
        // Correction: we already freed specs slice header; raws remain owned by new_list entries.
        // So we must NOT free raws again separately.
        // Replace self.specs.
        self.specs = try new_list.toOwnedSlice(self.allocator);
    }

    pub fn addSpec(self: *FilterSet, spec_text: []const u8) !void {
        const sp = try filter.parseOne(spec_text);
        var new_list = try self.allocator.alloc(filter.Spec, self.specs.len + 1);
        @memcpy(new_list[0..self.specs.len], self.specs);
        new_list[self.specs.len] = .{
            .kind = sp.kind,
            .limit_bytes = sp.limit_bytes,
            .object_type = sp.object_type,
            .raw = try self.allocator.dupe(u8, spec_text),
        };
        self.allocator.free(self.specs);
        self.specs = new_list;
    }

    pub fn shouldOmit(self: *const FilterSet, kind: object.Kind, size: usize) bool {
        if (self.specs.len == 0) return false;
        const ot: filter.ObjectType = switch (kind) {
            .blob => .blob,
            .tree => .tree,
            .commit => .commit,
            .tag => .tag,
        };
        return filter.shouldOmit(self.specs, ot, size);
    }

    /// Extract filter lines from pkt-line upload-pack request body.
    /// Looks for lines starting with "filter " and collects the spec after.
    pub fn fromPktLines(allocator: std.mem.Allocator, pkt_data: []const u8) !FilterSet {
        var fs = FilterSet.init(allocator);
        errdefer fs.deinit();
        var parser = @import("pktline.zig").Parser{ .data = pkt_data };
        var iter: usize = 0;
        while (iter < 64) : (iter += 1) {
            const line = parser.next() catch break;
            const payload = line orelse continue;
            if (payload.len >= 2 and std.mem.eql(u8, payload[0..2], "00")) continue;
            if (std.mem.startsWith(u8, payload, "filter ")) {
                const spec = std.mem.trim(u8, payload["filter ".len..], " \r\n");
                const specs = try filter.parseCombine(allocator, spec);
                defer allocator.free(specs);
                for (specs) |sp| {
                    try fs.addSpec(sp.raw);
                }
                for (specs) |sp| allocator.free(sp.raw);
            }
        }
        return fs;
    }
};

test "partial filterset blob:none omits blobs" {
    const alloc = std.testing.allocator;
    var fs = FilterSet.init(alloc);
    defer fs.deinit();
    try fs.addSpec("blob:none");
    try std.testing.expect(fs.shouldOmit(.blob, 10));
    try std.testing.expect(!fs.shouldOmit(.tree, 10));
    try std.testing.expect(!fs.shouldOmit(.commit, 100));
}

test "partial from pktlines" {
    const alloc = std.testing.allocator;
    // pktline "filter blob:none\n" -> "0015filter blob:none\n" (4 + 15? actually total len includes 4)
    // "filter blob:none\n" is 17 bytes + 4 = 21 => 0x15
    const pkt = "0015filter blob:none\n0000";
    var fs = try FilterSet.fromPktLines(alloc, pkt);
    defer fs.deinit();
    try std.testing.expectEqual(@as(usize, 1), fs.specs.len);
}
