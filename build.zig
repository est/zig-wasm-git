const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const mod = b.addModule("zig_wasm_git", .{
        .root_source_file = b.path("src/zig/root.zig"),
        .target = target,
        .optimize = optimize,
    });

    const lib = b.addLibrary(.{
        .name = "zig_wasm_git",
        .root_module = mod,
    });
    b.installArtifact(lib);

    // wasm artefact (freestanding, small) — executable exposes exports
    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
        .abi = .none,
    });
    const wasm_mod = b.addModule("zig_wasm_git_wasm", .{
        .root_source_file = b.path("src/zig/wasm.zig"),
        .target = wasm_target,
        .optimize = .ReleaseSmall,
    });
    const wasm_exe = b.addExecutable(.{
        .name = "zig_wasm_git",
        .root_module = wasm_mod,
    });
    wasm_exe.entry = .disabled;
    wasm_exe.rdynamic = true;
    b.installArtifact(wasm_exe);

    // Also library for native checks
    const wasm_lib_mod = b.addModule("zig_wasm_git_wasm_lib", .{
        .root_source_file = b.path("src/zig/root.zig"),
        .target = wasm_target,
        .optimize = .ReleaseSmall,
    });
    const wasm_lib = b.addLibrary(.{
        .name = "zig_wasm_git_wasm",
        .root_module = wasm_lib_mod,
    });
    b.installArtifact(wasm_lib);

    // Tests (native)
    const test_mod = b.createModule(.{
        .root_source_file = b.path("src/zig/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    const tests = b.addTest(.{ .root_module = test_mod });
    const run_tests = b.addRunArtifact(tests);
    const test_step = b.step("test", "Run zig tests");
    test_step.dependOn(&run_tests.step);

    // Filter/partial focused tests
    const filter_mod = b.createModule(.{
        .root_source_file = b.path("src/zig/filter.zig"),
        .target = target,
        .optimize = optimize,
    });
    const filter_tests = b.addTest(.{ .root_module = filter_mod });
    const run_filter = b.addRunArtifact(filter_tests);
    const filter_step = b.step("test-filter", "Run filter/partial tests");
    filter_step.dependOn(&run_filter.step);
}
