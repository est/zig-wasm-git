const std = @import("std");
const oid = @import("oid.zig");
const pktline = @import("pktline.zig");
const proto = @import("proto.zig");
const filter = @import("filter.zig");
const partial = @import("partial.zig");

// WASM exports: allocator + handlers for smart HTTP + filter/partial.
// Host provides imports:
//   host_log(ptr, len)
//   host_emit_bytes(ptr, len)  // stream response body
//   host_get_ref(name_ptr, name_len, out_oid_hex_ptr) -> i32 (1 found, 0 not)
//   host_put_ref, host_list_refs, host_has_object, host_get_object, host_put_object

extern fn host_emit_bytes(ptr: [*]const u8, len: usize) void;
extern fn host_log(ptr: [*]const u8, len: usize) void;

var heap: [256 * 1024]u8 = undefined;
var fba = std.heap.FixedBufferAllocator.init(&heap);
var heap_inited: bool = false;

fn gpa() std.mem.Allocator {
    if (!heap_inited) {
        fba = std.heap.FixedBufferAllocator.init(&heap);
        heap_inited = true;
    }
    return fba.allocator();
}

export fn wasm_alloc(len: usize) usize {
    const mem = gpa().alloc(u8, len) catch return 0;
    return @intFromPtr(mem.ptr);
}

export fn wasm_reset() void {
    fba = std.heap.FixedBufferAllocator.init(&heap);
    heap_inited = true;
}

fn sliceFromPtr(ptr: usize, len: usize) []const u8 {
    if (len == 0) return &.{};
    return @as([*]const u8, @ptrFromInt(ptr))[0..len];
}
fn sliceFromPtrMut(ptr: usize, len: usize) []u8 {
    if (len == 0) return &.{};
    return @as([*]u8, @ptrFromInt(ptr))[0..len];
}

// Host calls these with request body in wasm memory; we parse and emit response via host_emit_bytes.

// Build discovery advertisement for upload-pack: Host passes refs list as packed buffer:
// refs_ptr points to N * (40 hex + 1 space + name + '\n')? Instead Host builds refs via wasm helper.
// Simpler: Host calls wasm_build_discovery(refs_packed_ptr, refs_len, service_tag)
// For MVP, expose wasm_handle_discovery which emits discovery response directly if Host already built refs pktlines.
export fn wasm_handle_discovery(service: u32, refs_pkt_ptr: usize, refs_pkt_len: usize) i32 {
    const alloc = gpa();
    const refs_pkt = sliceFromPtr(refs_pkt_ptr, refs_pkt_len);
    const svc: proto.Service = if (service == 0) .upload_pack else .receive_pack;
    const resp = proto.buildDiscoveryResponse(alloc, svc, refs_pkt) catch return -1;
    defer alloc.free(resp);
    host_emit_bytes(resp.ptr, resp.len);
    return 0;
}

// Parse want/have/filter from pkt payload; Host can query filter presence.
export fn wasm_parse_filter(pkt_ptr: usize, pkt_len: usize, out_has_filter: *u32, out_filter_spec_ptr: *usize, out_filter_spec_len: *usize) i32 {
    const alloc = gpa();
    const pkt = sliceFromPtr(pkt_ptr, pkt_len);
    var fs = partial.FilterSet.fromPktLines(alloc, pkt) catch return -1;
    defer fs.deinit();
    if (fs.specs.len == 0) {
        out_has_filter.* = 0;
        out_filter_spec_ptr.* = 0;
        out_filter_spec_len.* = 0;
        return 0;
    }
    out_has_filter.* = 1;
    // Join specs as "a+b+c" for Host to apply
    var joined: std.ArrayList(u8) = .empty;
    for (fs.specs, 0..) |sp, i| {
        if (i != 0) joined.appendSlice(alloc, "+") catch return -1;
        joined.appendSlice(alloc, sp.raw) catch return -1;
    }
    const slice = joined.toOwnedSlice(alloc) catch return -1;
    const slen = slice.len;
    const ptr = wasm_alloc(slen);
    if (ptr == 0) {
        alloc.free(slice);
        return -1;
    }
    @memcpy(sliceFromPtrMut(ptr, slen), slice);
    alloc.free(slice);
    out_filter_spec_ptr.* = ptr;
    out_filter_spec_len.* = slen;
    return 0;
}

// Helper: Host asks "should omit?" for (kind_str, size)
export fn wasm_should_omit(kind_ptr: usize, kind_len: usize, size: usize, filter_ptr: usize, filter_len: usize) u32 {
    const alloc = gpa();
    const kind_s = sliceFromPtr(kind_ptr, kind_len);
    const filter_s = if (filter_len == 0) "" else sliceFromPtr(filter_ptr, filter_len);
    const kind: @import("object.zig").Kind = @import("object.zig").kindFromStr(kind_s) catch return 0;
    var specs: []filter.Spec = &.{};
    if (filter_s.len != 0) {
        specs = filter.parseCombine(alloc, filter_s) catch return 0;
        defer {
            for (specs) |sp| alloc.free(sp.raw);
            alloc.free(specs);
        }
        const omit = filter.shouldOmit(specs, switch (kind) {
            .blob => .blob,
            .tree => .tree,
            .commit => .commit,
            .tag => .tag,
        }, size);
        return if (omit) 1 else 0;
    }
    return 0;
}

// Expose pktline helpers for Host tests
export fn wasm_pktline_encode(payload_ptr: usize, payload_len: usize, out_ptr: *usize, out_len: *usize) i32 {
    const alloc = gpa();
    const payload = sliceFromPtr(payload_ptr, payload_len);
    const enc = pktline.encodeLine(alloc, payload) catch return -1;
    const p = wasm_alloc(enc.len);
    if (p == 0) return -1;
    @memcpy(sliceFromPtrMut(p, enc.len), enc);
    alloc.free(enc);
    out_ptr.* = p;
    out_len.* = enc.len;
    return 0;
}
