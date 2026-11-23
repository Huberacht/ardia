import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as lib from "./build-cache.mjs";

const scratch = () => fs.mkdtempSync(join(tmpdir(), "build-cache-test-"));
const write = (root, rel, text, mode) => {
  const path = join(root, rel);
  fs.mkdirSync(join(path, ".."), { recursive: true });
  fs.writeFileSync(path, text);
  if (mode) fs.chmodSync(path, mode);
  return path;
};

function repo() {
  const dir = scratch();
  execFileSync("git", ["init", "-q", dir]);
  write(dir, "apps/browser/macos/Ardia-macOS/AppDelegate.swift", "class AppDelegate {}\n");
  write(dir, "apps/browser/macos/Ardia.xcodeproj/project.pbxproj", "a = 1;\nb = 2;\nc = 3;\n");
  write(dir, "apps/browser/macos/Podfile.lock", "PODS: []\n");
  write(dir, "packages/shell/ios/Shell.swift", "struct Shell {}\n");
  write(dir, "packages/shell/package.json", '{"name":"shell"}\n');
  write(dir, "packages/shell/src/index.ts", "export const shell = 1;\n");
  write(dir, "apps/browser/src/App.tsx", "export default 1;\n");
  write(dir, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  write(dir, ".gitignore", "node_modules\nbuild-*\n");
  write(dir, "apps/browser/build-x/ignored.o", "x");
  return dir;
}

const stampOf = (dir, extra = {}) =>
  lib.nativeStamp(dir, { config: "Debug", signing: "default", framework: "", engineKey: "k".repeat(40), xcode: "xcode 17A1", ...extra });

test("the stamp ignores JS, ignored files and pbxproj line order", () => {
  const dir = repo();
  const before = stampOf(dir);
  write(dir, "apps/browser/src/App.tsx", "export default 2;\n");
  write(dir, "packages/shell/src/index.ts", "export const shell = 2;\n");
  write(dir, "apps/browser/build-x/ignored.o", "y");
  write(dir, "apps/browser/macos/Ardia.xcodeproj/project.pbxproj", "c = 3;\na = 1;\nb = 2;\n");
  assert.equal(stampOf(dir), before);
});

test("the stamp changes with every native input", () => {
  const dir = repo();
  const seen = new Set([stampOf(dir)]);
  const expectNew = (label, value) => {
    assert.ok(!seen.has(value), label);
    seen.add(value);
  };
  write(dir, "packages/shell/ios/Shell.swift", "struct Shell { let a = 1 }\n");
  expectNew("pod source", stampOf(dir));
  write(dir, "apps/browser/macos/Ardia.xcodeproj/project.pbxproj", "a = 1;\nb = 2;\nc = 4;\n");
  expectNew("pbxproj content", stampOf(dir));
  write(dir, "pnpm-lock.yaml", "lockfileVersion: 9.1\n");
  expectNew("lockfile", stampOf(dir));
  write(dir, "patches/react-native-macos@0.81.9.patch", "diff\n");
  expectNew("new patch", stampOf(dir));
  write(dir, "packages/core-rs/Cargo.lock", "version = 4\n");
  expectNew("rust core", stampOf(dir));
  fs.chmodSync(join(dir, "packages/shell/ios/Shell.swift"), 0o755);
  expectNew("exec bit", stampOf(dir));
  expectNew("config", stampOf(dir, { config: "Release" }));
  expectNew("signing", stampOf(dir, { signing: "adhoc" }));
  expectNew("engine key", stampOf(dir, { engineKey: "j".repeat(40) }));
  expectNew("xcode", stampOf(dir, { xcode: "xcode 17B2" }));
});

test("a prebuilt framework is identified by its key, wherever it was fetched", () => {
  const key = "a40945952f4f";
  const a = `/w/one/apps/browser/build-ardiacore/prebuilt/${key}/Chromium Framework.framework`;
  const b = `/cache/engines/${key}/Chromium Framework.framework`;
  assert.equal(lib.frameworkIdentity(a, "x"), `prebuilt ${key}`);
  assert.equal(lib.frameworkIdentity(b, "x"), `prebuilt ${key}`);
  assert.equal(lib.frameworkIdentity("", `${key}ffff`), `prebuilt ${key}`);
  const local = scratch();
  const binary = write(local, "Versions/Current/Chromium Framework", "engine");
  fs.utimesSync(binary, new Date(1e12), new Date(1e12));
  assert.equal(lib.frameworkIdentity(local, key), "framework 6 1000000000000");
});

function fakeApp(root, marker = "app") {
  const app = join(root, "Ardia.app");
  write(app, "Contents/MacOS/Ardia", marker);
  return app;
}

test("the cache is keyed by stamp: a miss, a store, then a hit", () => {
  const cache = scratch();
  const app = fakeApp(scratch(), "built");
  assert.equal(lib.lookup(cache, "s1"), null);
  const stored = lib.store(cache, "s1", app, { config: "Debug", head: "abc" }, { measure: () => 10 });
  assert.equal(stored.meta.stamp, "s1");
  const hit = lib.lookup(cache, "s1");
  assert.equal(fs.readFileSync(join(hit.app, "Contents/MacOS/Ardia"), "utf8"), "built");
  assert.equal(hit.meta.bytes, 10);
  assert.equal(lib.lookup(cache, "s2"), null);
  const again = lib.store(cache, "s1", fakeApp(scratch(), "other"), {}, { measure: () => 10 });
  assert.equal(fs.readFileSync(join(again.app, "Contents/MacOS/Ardia"), "utf8"), "built");
  assert.deepEqual(fs.readdirSync(cache).filter((n) => n.startsWith(".tmp")), []);
});

test("an entry without its app or with another stamp is a miss", () => {
  const cache = scratch();
  write(cache, "s1/meta.json", JSON.stringify({ stamp: "s1" }));
  assert.equal(lib.lookup(cache, "s1"), null);
  write(cache, "s2/meta.json", JSON.stringify({ stamp: "other" }));
  write(cache, "s2/Ardia.app/Contents/MacOS/Ardia", "x");
  assert.equal(lib.lookup(cache, "s2"), null);
});

test("eviction keeps the most recently used within both caps and never the protected entry", () => {
  const list = [
    { stamp: "a", bytes: 4, usedAt: 1 },
    { stamp: "b", bytes: 4, usedAt: 4 },
    { stamp: "c", bytes: 4, usedAt: 3 },
    { stamp: "d", bytes: 4, usedAt: 2 },
  ];
  const byCount = lib.evictionPlan(list, { maxBytes: 100, maxEntries: 2 });
  assert.deepEqual(byCount.keep.map((e) => e.stamp), ["b", "c"]);
  assert.deepEqual(byCount.evict.map((e) => e.stamp), ["d", "a"]);
  const byBytes = lib.evictionPlan(list, { maxBytes: 9, maxEntries: 10 });
  assert.deepEqual(byBytes.keep.map((e) => e.stamp), ["b", "c"]);
  const protectedOld = lib.evictionPlan(list, { maxBytes: 9, maxEntries: 2, protect: ["a"] });
  assert.ok(protectedOld.keep.some((e) => e.stamp === "a"));
});

test("evict removes the least recently used entries on disk", () => {
  const cache = scratch();
  for (const [i, s] of ["old", "mid", "new"].entries()) {
    const e = lib.store(cache, s, fakeApp(scratch()), {}, { measure: () => 5 });
    lib.touch(e.dir, new Date(1e12 + i * 1000));
  }
  const plan = lib.evict(cache, { maxBytes: 100, maxEntries: 2 });
  assert.deepEqual(plan.evict.map((e) => e.stamp), ["old"]);
  assert.deepEqual(fs.readdirSync(cache).sort(), ["mid", "new"]);
});

test("the lock holder path matches scripts/agent/locked's naming", () => {
  const dd = "/Users/x/ardia-scratch/build-slots/2/ardia/apps/browser/build-slot";
  const digest = execFileSync("sh", ["-c", `printf %s "${dd}" | shasum | cut -c1-8`], { encoding: "utf8" }).trim();
  assert.equal(lib.lockHolderPath(dd, "/tmp"), `/tmp/ac-xcodebuild-build-slot-${digest}.holder`);
});

test("slot selection: free before busy, nearest tree first, then a new slot", () => {
  const root = scratch();
  for (const n of ["1", "2", "3", "5"]) fs.mkdirSync(join(root, n));
  const manifest = { a: "1", b: "2", c: "3" };
  const states = {
    1: { manifest: { a: "1", b: "x", c: "y" }, syncedAt: 10 },
    2: { manifest: { a: "1", b: "2", c: "3" }, syncedAt: 5 },
    3: { manifest: { a: "1", b: "2", c: "3" }, syncedAt: 20 },
    5: { manifest: {}, syncedAt: 30 },
  };
  const readState = (slot) => states[slot.split("/").pop()];
  const busy = (slot) => slot.endsWith("/3");
  assert.deepEqual(lib.pickSlots(root, manifest, { busy, readState }), [join(root, "2"), join(root, "1"), join(root, "5"), join(root, "4")]);
  assert.deepEqual(lib.pickSlots(root, manifest, { busy: () => true, readState }), [join(root, "4")]);
  const empty = scratch();
  assert.deepEqual(lib.pickSlots(empty, manifest), [join(empty, "1")]);
});

test("slot eviction drops the least recently used idle slots beyond the keep count", () => {
  const root = scratch();
  for (const n of ["1", "2", "3", "4"]) fs.mkdirSync(join(root, n));
  const used = { 1: 40, 2: 10, 3: 30, 4: 20 };
  const readState = (slot) => ({ syncedAt: used[slot.split("/").pop()] });
  const busy = (slot) => slot.endsWith("/2");
  assert.deepEqual(lib.slotsToEvict(root, { keep: 2, busy, readState, protect: [join(root, "4")] }), [join(root, "3")]);
  assert.deepEqual(lib.slotsToEvict(root, { keep: 3, busy, readState }), []);
});

test("syncing writes only changed files, with a fresh mtime, and removes deleted ones", () => {
  const src = repo();
  const slots = scratch();
  const slot = join(slots, "1");
  const first = lib.manifestOf(src, lib.listFiles(src, ["."]));
  const r1 = lib.syncTree(src, slot, first);
  assert.equal(r1.changed.length, Object.keys(first).length);
  const tree = lib.slotTree(slot);
  assert.equal(fs.existsSync(join(tree, "apps/browser/build-x/ignored.o")), false);
  const old = new Date(1e12);
  for (const rel of Object.keys(first)) fs.utimesSync(join(tree, rel), old, old);
  const keptInode = fs.statSync(join(tree, "packages/shell/ios/Shell.swift")).ino;
  lib.writeSlotState(slot, { ...lib.readSlotState(slot), syncedAt: old.getTime() + 1 });

  const other = scratch();
  execFileSync("cp", ["-R", `${src}/.`, other]);
  write(other, "apps/browser/macos/Ardia-macOS/AppDelegate.swift", "class AppDelegate { }\n");
  write(other, "apps/browser/macos/Ardia.xcodeproj/project.pbxproj", "b = 2;\na = 1;\nc = 3;\n");
  write(other, "packages/shell/ios/run.sh", "#!/bin/sh\n", 0o755);
  fs.rmSync(join(other, "packages/shell/src/index.ts"));
  const before = Date.now();
  const r2 = lib.syncTree(other, slot, lib.manifestOf(other, lib.listFiles(other, ["."])));
  assert.deepEqual(r2.changed, ["apps/browser/macos/Ardia-macOS/AppDelegate.swift", "packages/shell/ios/run.sh"]);
  assert.deepEqual(r2.removed, ["packages/shell/src/index.ts"]);
  assert.equal(fs.readFileSync(join(tree, "apps/browser/macos/Ardia-macOS/AppDelegate.swift"), "utf8"), "class AppDelegate { }\n");
  assert.ok(fs.statSync(join(tree, "apps/browser/macos/Ardia-macOS/AppDelegate.swift")).mtimeMs >= before - 1000);
  assert.ok(fs.statSync(join(tree, "packages/shell/ios/run.sh")).mode & 0o100);
  assert.equal(fs.statSync(join(tree, "packages/shell/ios/Shell.swift")).mtimeMs, old.getTime());
  assert.equal(fs.statSync(join(tree, "packages/shell/ios/Shell.swift")).ino, keptInode);
  assert.equal(fs.existsSync(join(tree, "packages/shell/src")), false);
  assert.equal(fs.readFileSync(join(tree, "apps/browser/macos/Ardia.xcodeproj/project.pbxproj"), "utf8"), "a = 1;\nb = 2;\nc = 3;\n");
});

test("a slot file edited after its sync is rewritten from the tree on the next sync", () => {
  const src = repo();
  const slot = join(scratch(), "1");
  const manifest = lib.manifestOf(src, lib.listFiles(src, ["."]));
  lib.syncTree(src, slot, manifest);
  const path = join(lib.slotTree(slot), "packages/shell/ios/Shell.swift");
  fs.writeFileSync(path, "tampered\n");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path, later, later);
  const r = lib.syncTree(src, slot, manifest);
  assert.deepEqual(r.drifted, ["packages/shell/ios/Shell.swift"]);
  assert.deepEqual(r.changed, ["packages/shell/ios/Shell.swift"]);
  assert.equal(fs.readFileSync(path, "utf8"), "struct Shell {}\n");
});

test("store with replace swaps in the new app; without it keeps the first", () => {
  const cache = scratch();
  lib.store(cache, "s", fakeApp(scratch(), "first"), {}, { measure: () => 1 });
  lib.store(cache, "s", fakeApp(scratch(), "second"), {}, { measure: () => 1 });
  assert.equal(fs.readFileSync(join(lib.lookup(cache, "s").app, "Contents/MacOS/Ardia"), "utf8"), "first");
  lib.store(cache, "s", fakeApp(scratch(), "third"), {}, { measure: () => 1, replace: true });
  assert.equal(fs.readFileSync(join(lib.lookup(cache, "s").app, "Contents/MacOS/Ardia"), "utf8"), "third");
  assert.deepEqual(fs.readdirSync(cache).filter((n) => n.startsWith(".tmp")), []);
});

test("a node_modules with symlinks into another checkout is never seeded or installed through", () => {
  const shared = scratch();
  write(shared, "node_modules/react-native-macos/package.json", "{}");
  const real = scratch();
  write(real, "node_modules/react-native-macos/package.json", "{}");
  fs.mkdirSync(join(real, "node_modules/@ardia"));
  fs.symlinkSync("../../packages/core", join(real, "node_modules/@ardia/core"));
  assert.equal(lib.linksOutside(real), false);
  const linked = scratch();
  fs.mkdirSync(join(linked, "node_modules"));
  fs.symlinkSync(join(shared, "node_modules/react-native-macos"), join(linked, "node_modules/react-native-macos"));
  assert.equal(lib.linksOutside(linked), true);
  const whole = scratch();
  fs.symlinkSync(join(shared, "node_modules"), join(whole, "node_modules"));
  assert.equal(lib.linksOutside(whole), true);
  assert.equal(lib.linksOutside(scratch()), false);
});
