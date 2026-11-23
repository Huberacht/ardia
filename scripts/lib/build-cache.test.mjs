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

const POD_SOURCE = "packages/base/ios/Base.swift";
const PROJECT = "apps/browser/macos/Fake.xcodeproj/project.pbxproj";

function repo() {
  const dir = scratch();
  execFileSync("git", ["init", "-q", dir]);
  write(dir, "apps/browser/macos/FakeApp/Delegate.swift", "class Delegate {}\n");
  write(dir, PROJECT, "buildPhases = (\nStage,\nSources,\n);\n");
  write(dir, "apps/browser/macos/Fake.lock", "PODS: []\n");
  write(dir, POD_SOURCE, "struct Base {}\n");
  write(dir, "packages/base/package.json", '{"name":"base"}\n');
  write(dir, "packages/base/src/index.ts", "export const base = 1;\n");
  write(dir, "apps/browser/src/FakeScreen.tsx", "export default 1;\n");
  write(dir, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  write(dir, ".gitignore", "node_modules\nbuild-*\n");
  write(dir, "apps/browser/build-x/ignored.o", "x");
  return dir;
}

const framework = () => {
  const dir = join(scratch(), "Chromium Framework.framework");
  write(dir, "Versions/A/Chromium Framework", "engine");
  write(dir, "Versions/A/Helpers/helper", "helper", 0o755);
  fs.symlinkSync("A", join(dir, "Versions/Current"));
  return dir;
};

const inputs = (extra = {}) => ({
  framework: "framework f1",
  toolchain: "toolchain Xcode 27.2 | 27B52",
  env: lib.envFingerprint({ PATH: "/bin" }),
  ...extra,
});

const stampOf = (dir, extra = {}) =>
  lib.stampOf({ manifest: lib.manifestOf(dir, lib.listFiles(dir).filter(lib.isNative)), config: "Debug", signing: "default", ...inputs(extra) });

test("the native rules take sources, Pods inputs, patches, the lockfile and the Rust core, and leave JS out", () => {
  for (const rel of [POD_SOURCE, PROJECT, "apps/browser/macos/Fake.lock", "patches/x.patch", "pnpm-lock.yaml", "packages/base/package.json", "packages/core-rs/fake.toml", "engine/ardiacore/src/ardia/core/public/Fake.h"]) {
    assert.ok(lib.isNative(rel), rel);
  }
  for (const rel of ["apps/browser/src/FakeScreen.tsx", "packages/base/src/index.ts", "docs/fake.md"]) assert.ok(!lib.isNative(rel), rel);
});

test("the stamp ignores JS and ignored files", () => {
  const dir = repo();
  const before = stampOf(dir);
  write(dir, "apps/browser/src/FakeScreen.tsx", "export default 2;\n");
  write(dir, "packages/base/src/index.ts", "export const base = 2;\n");
  write(dir, "apps/browser/build-x/ignored.o", "y");
  assert.equal(stampOf(dir), before);
});

test("the stamp changes with every native input, a .pbxproj reorder included", () => {
  const dir = repo();
  const seen = new Set([stampOf(dir)]);
  const expectNew = (label, value) => {
    assert.ok(!seen.has(value), label);
    seen.add(value);
  };
  write(dir, POD_SOURCE, "struct Base { let a = 1 }\n");
  expectNew("pod source", stampOf(dir));
  write(dir, PROJECT, "buildPhases = (\nSources,\nStage,\n);\n");
  expectNew("pbxproj phase order", stampOf(dir));
  write(dir, "pnpm-lock.yaml", "lockfileVersion: 9.1\n");
  expectNew("lockfile", stampOf(dir));
  write(dir, "patches/fake@1.0.0.patch", "diff\n");
  expectNew("new patch", stampOf(dir));
  write(dir, "packages/core-rs/fake.toml", "version = 4\n");
  expectNew("rust core", stampOf(dir));
  fs.chmodSync(join(dir, POD_SOURCE), 0o755);
  expectNew("exec bit", stampOf(dir));
  expectNew("config", lib.stampOf({ manifest: lib.manifestOf(dir, lib.listFiles(dir).filter(lib.isNative)), config: "Release", ...inputs() }));
  expectNew("signing", lib.stampOf({ manifest: lib.manifestOf(dir, lib.listFiles(dir).filter(lib.isNative)), config: "Debug", signing: "adhoc", ...inputs() }));
  expectNew("framework", stampOf(dir, { framework: "framework f2" }));
  expectNew("toolchain", stampOf(dir, { toolchain: "toolchain Xcode 27.3 | 27C1" }));
  expectNew("new arch", stampOf(dir, { env: lib.envFingerprint({ RCT_NEW_ARCH_ENABLED: "1" }) }));
  expectNew("toolchains", stampOf(dir, { env: lib.envFingerprint({ TOOLCHAINS: "swift" }) }));
});

test("the environment fingerprint keeps build variables, drops the rest, and blocks an xcconfig override", () => {
  const fp = lib.envFingerprint({ RCT_NEW_ARCH_ENABLED: "0", TOOLCHAINS: "x", CC: "clang", HOME: "/h", PATH: "/bin", AC_LOCKED_AS: "me" });
  assert.deepEqual(fp.lines, ["env CC=clang", "env RCT_NEW_ARCH_ENABLED=0", "env TOOLCHAINS=x"]);
  assert.deepEqual(fp.blocked, []);
  assert.deepEqual(lib.envFingerprint({ XCODE_XCCONFIG_FILE: "/x.xcconfig" }).blocked, ["XCODE_XCCONFIG_FILE"]);
  assert.match(lib.stampInputs({ framework: framework(), env: { XCODE_XCCONFIG_FILE: "/x" }, toolchain: "t" }).blocked, /XCODE_XCCONFIG_FILE/);
  assert.match(lib.stampInputs({ framework: "/nowhere", env: {}, toolchain: "t" }).blocked, /no engine framework/);
  assert.match(lib.stampInputs({ framework: framework(), env: {}, toolchain: null }).blocked, /toolchain/);
});

test("the framework is identified by the content of every file, wherever it sits", () => {
  const a = framework();
  const b = framework();
  const cache = new lib.HashCache(join(scratch(), "hashes.json"));
  assert.equal(lib.frameworkIdentity(a, cache), lib.frameworkIdentity(b, cache));
  const before = lib.frameworkIdentity(a, cache);
  const helper = join(a, "Versions/A/Helpers/helper");
  const st = fs.statSync(helper);
  fs.writeFileSync(helper, "HELPER");
  fs.utimesSync(helper, st.atime, st.mtime);
  assert.notEqual(lib.frameworkIdentity(a, cache), before);
  assert.equal(lib.frameworkIdentity(join(scratch(), "none.framework"), cache), null);
  cache.save();
  assert.ok(fs.existsSync(cache.path));
});

test("deps and Pods inputs: a new pod source file or a new-arch flag means a fresh pod install", () => {
  const dir = repo();
  const manifest = () => lib.manifestOf(dir, lib.listFiles(dir));
  const pods = lib.podsHash(manifest(), {});
  const deps = lib.depsHash(manifest(), {});
  write(dir, POD_SOURCE, "struct Base { let changed = 1 }\n");
  assert.equal(lib.podsHash(manifest(), {}), pods);
  write(dir, "packages/base/ios/Added.mm", "int added;\n");
  assert.notEqual(lib.podsHash(manifest(), {}), pods);
  assert.notEqual(lib.podsHash(manifest(), { RCT_NEW_ARCH_ENABLED: "1" }), lib.podsHash(manifest(), {}));
  assert.equal(lib.depsHash(manifest(), {}), deps);
  write(dir, "pnpm-lock.yaml", "lockfileVersion: 10\n");
  assert.notEqual(lib.depsHash(manifest(), {}), deps);
});

function fakeApp(root, marker = "app") {
  const app = join(root, "Ardia.app");
  write(app, "Contents/MacOS/Ardia", marker);
  return app;
}
const one = () => 1;

test("the cache is keyed by stamp: a miss, a store, then a hit", () => {
  const cache = scratch();
  assert.equal(lib.lookup(cache, "s1"), null);
  const stored = lib.store(cache, "s1", fakeApp(scratch(), "built"), { config: "Debug", head: "abc" }, { measure: () => 10 });
  assert.equal(stored.meta.stamp, "s1");
  assert.equal(stored.meta.files, 3);
  const hit = lib.lookup(cache, "s1");
  assert.equal(fs.readFileSync(join(hit.app, "Contents/MacOS/Ardia"), "utf8"), "built");
  assert.equal(lib.lookup(cache, "s2"), null);
  assert.deepEqual(fs.readdirSync(cache).filter((n) => n.startsWith(".tmp")), []);
});

test("store keeps the first app for a stamp unless asked to replace it", () => {
  const cache = scratch();
  lib.store(cache, "s", fakeApp(scratch(), "first"), {}, { measure: one });
  lib.store(cache, "s", fakeApp(scratch(), "second"), {}, { measure: one });
  assert.equal(fs.readFileSync(join(lib.lookup(cache, "s").app, "Contents/MacOS/Ardia"), "utf8"), "first");
  lib.store(cache, "s", fakeApp(scratch(), "third"), {}, { measure: one, replace: true });
  assert.equal(fs.readFileSync(join(lib.lookup(cache, "s").app, "Contents/MacOS/Ardia"), "utf8"), "third");
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

test("a clone of an entry that vanished or came out partial is refused", () => {
  const cache = scratch();
  const entry = lib.store(cache, "s", fakeApp(scratch()), {}, { measure: one });
  const dest = join(scratch(), "out/Ardia.app");
  assert.equal(lib.cloneEntry(entry, dest), true);
  assert.equal(lib.cloneEntry({ ...entry, meta: { ...entry.meta, files: 99 } }, dest), false);
  fs.rmSync(entry.dir, { recursive: true });
  assert.equal(lib.cloneEntry(entry, join(scratch(), "again/Ardia.app")), false);
});

test("eviction keeps the most recently used within both caps, the protected entry and anything used in the grace period", () => {
  const list = [
    { stamp: "a", bytes: 4, usedAt: 1 },
    { stamp: "b", bytes: 4, usedAt: 4 },
    { stamp: "c", bytes: 4, usedAt: 3 },
    { stamp: "d", bytes: 4, usedAt: 2 },
  ];
  assert.deepEqual(lib.evictionPlan(list, { maxBytes: 100, maxEntries: 2, now: 1000 }).evict.map((e) => e.stamp), ["d", "a"]);
  assert.deepEqual(lib.evictionPlan(list, { maxBytes: 9, maxEntries: 10, now: 1000 }).keep.map((e) => e.stamp), ["b", "c"]);
  assert.ok(lib.evictionPlan(list, { maxBytes: 9, maxEntries: 2, protect: ["a"], now: 1000 }).keep.some((e) => e.stamp === "a"));
  assert.deepEqual(lib.evictionPlan(list, { maxBytes: 0, maxEntries: 0, graceMs: 2.5, now: 4 }).keep.map((e) => e.stamp), ["b", "c", "d"]);
});

test("evict removes the least recently used apps and engines on disk", () => {
  const cache = scratch();
  for (const [i, s] of ["old", "mid", "new"].entries()) {
    const e = lib.store(cache, s, fakeApp(scratch()), {}, { measure: () => 5 });
    lib.touch(e.dir, new Date(1e12 + i * 1000));
  }
  for (const [i, key] of ["aaaaaaaaaaaa", "bbbbbbbbbbbb"].entries()) {
    write(cache, `engines/${key}/.complete`, "");
    lib.touch(join(cache, "engines", key), new Date(1e12 + i * 1000));
  }
  const plan = lib.evict(cache, { maxBytes: 100, maxEntries: 2, keepEngines: 1 });
  assert.deepEqual(plan.evict.map((e) => e.stamp), ["old"]);
  assert.deepEqual(fs.readdirSync(cache).filter((n) => !n.startsWith(".")).sort(), ["engines", "mid", "new"]);
  assert.deepEqual(fs.readdirSync(join(cache, "engines")), ["bbbbbbbbbbbb"]);
});

test("the lock holder path matches scripts/agent/locked's naming", () => {
  const dd = "/x/build-slots/2/ardia/apps/web/build-slot";
  const digest = execFileSync("sh", ["-c", `printf %s "${dd}" | shasum | cut -c1-8`], { encoding: "utf8" }).trim();
  assert.equal(lib.lockHolderPath(dd, "/tmp"), `/tmp/ac-xcodebuild-build-slot-${digest}.holder`);
});

test("slot selection: free slots only, nearest tree first", () => {
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
  assert.deepEqual(lib.freeSlots(root, manifest, { busy, readState }), [join(root, "2"), join(root, "1"), join(root, "5")]);
  assert.deepEqual(lib.freeSlots(root, manifest, { busy: () => true, readState }), []);
});

test("a new slot is reserved atomically and stays busy while its owner lives", () => {
  const root = scratch();
  const a = lib.reserveSlot(root, process.pid);
  const b = lib.reserveSlot(root, process.pid);
  assert.notEqual(a, b);
  assert.ok(lib.slotBusy(a, { root: scratch() }));
  const dead = lib.reserveSlot(root, 999999);
  assert.ok(!lib.slotBusy(dead, { root: scratch() }));
  lib.releaseReservation(a);
  assert.ok(!lib.slotBusy(a, { root: scratch() }));
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
  const slot = join(scratch(), "1");
  const first = lib.manifestOf(src, lib.listFiles(src));
  assert.equal(lib.syncTree(src, slot, first).changed.length, Object.keys(first).length);
  const tree = lib.slotTree(slot);
  assert.equal(fs.existsSync(join(tree, "apps/browser/build-x/ignored.o")), false);
  const old = new Date(1e12);
  for (const rel of Object.keys(first)) fs.utimesSync(join(tree, rel), old, old);
  const keptInode = fs.statSync(join(tree, POD_SOURCE)).ino;
  lib.writeSlotState(slot, { ...lib.readSlotState(slot), syncedAt: Date.now() + 1 });

  const other = scratch();
  execFileSync("cp", ["-R", `${src}/.`, other]);
  write(other, "apps/browser/macos/FakeApp/Delegate.swift", "class Delegate { }\n");
  write(other, "packages/base/ios/run.sh", "#!/bin/sh\n", 0o755);
  fs.rmSync(join(other, "packages/base/src/index.ts"));
  const before = Date.now();
  const r = lib.syncTree(other, slot, lib.manifestOf(other, lib.listFiles(other)));
  assert.deepEqual(r.changed, ["apps/browser/macos/FakeApp/Delegate.swift", "packages/base/ios/run.sh"]);
  assert.deepEqual(r.removed, ["packages/base/src/index.ts"]);
  assert.deepEqual(r.mismatched, []);
  assert.ok(fs.statSync(join(tree, "apps/browser/macos/FakeApp/Delegate.swift")).mtimeMs >= before - 1000);
  assert.ok(fs.statSync(join(tree, "packages/base/ios/run.sh")).mode & 0o100);
  assert.equal(fs.statSync(join(tree, POD_SOURCE)).mtimeMs, old.getTime());
  assert.equal(fs.statSync(join(tree, POD_SOURCE)).ino, keptInode);
  assert.equal(fs.existsSync(join(tree, "packages/base/src")), false);
});

test("a slot file edited after its sync is rewritten from the tree, and removed when the tree deleted it", () => {
  const src = repo();
  const slot = join(scratch(), "1");
  lib.syncTree(src, slot, lib.manifestOf(src, lib.listFiles(src)));
  const tree = lib.slotTree(slot);
  const later = new Date(Date.now() + 5000);
  for (const rel of [POD_SOURCE, "apps/browser/macos/Fake.lock"]) {
    fs.writeFileSync(join(tree, rel), "drifted\n");
    fs.utimesSync(join(tree, rel), later, later);
  }
  fs.rmSync(join(src, "apps/browser/macos/Fake.lock"));
  const r = lib.syncTree(src, slot, lib.manifestOf(src, lib.listFiles(src)));
  assert.deepEqual(r.drifted.sort(), ["apps/browser/macos/Fake.lock", POD_SOURCE]);
  assert.deepEqual(r.changed, [POD_SOURCE]);
  assert.deepEqual(r.removed, ["apps/browser/macos/Fake.lock"]);
  assert.equal(fs.readFileSync(join(tree, POD_SOURCE), "utf8"), "struct Base {}\n");
  assert.equal(fs.existsSync(join(tree, "apps/browser/macos/Fake.lock")), false);
});

test("files an interrupted sync copied stay managed and are removed once the tree no longer has them", () => {
  const src = repo();
  const slot = join(scratch(), "1");
  lib.syncTree(src, slot, lib.manifestOf(src, lib.listFiles(src)));
  const tree = lib.slotTree(slot);
  write(tree, "packages/base/ios/Interrupted.mm", "half-synced\n");
  lib.writeSlotState(slot, { ...lib.readSlotState(slot), pending: ["packages/base/ios/Interrupted.mm"] });
  const r = lib.syncTree(src, slot, lib.manifestOf(src, lib.listFiles(src)));
  assert.deepEqual(r.removed, ["packages/base/ios/Interrupted.mm"]);
  assert.equal(fs.existsSync(join(tree, "packages/base/ios/Interrupted.mm")), false);
  assert.deepEqual(lib.readSlotState(slot).pending, []);
});

test("a file that changes between hashing and copying is reported and left pending", () => {
  const src = repo();
  const slot = join(scratch(), "1");
  const manifest = lib.manifestOf(src, lib.listFiles(src));
  write(src, POD_SOURCE, "edited while syncing\n");
  const r = lib.syncTree(src, slot, manifest);
  assert.deepEqual(r.mismatched, [POD_SOURCE]);
  assert.deepEqual(lib.readSlotState(slot).pending, [POD_SOURCE]);
  assert.ok(!(POD_SOURCE in lib.readSlotState(slot).manifest));
  const again = lib.syncTree(src, slot, lib.manifestOf(src, lib.listFiles(src)));
  assert.deepEqual(again.mismatched, []);
  assert.ok(again.changed.includes(POD_SOURCE));
});

test("node_modules links that would leave the tree are found, scoped and nested ones included", () => {
  const outside = scratch();
  fs.mkdirSync(join(outside, "pkg"));
  const fine = scratch();
  write(fine, "node_modules/real/package.json", "{}");
  fs.mkdirSync(join(fine, "node_modules/@scope"), { recursive: true });
  fs.symlinkSync("../../packages/base", join(fine, "node_modules/@scope/base"));
  fs.mkdirSync(join(fine, "node_modules/.bin"));
  fs.symlinkSync("../real/cli.js", join(fine, "node_modules/.bin/real"));
  assert.deepEqual(lib.escapingLinks(fine, { deep: true }), []);

  const scoped = scratch();
  fs.mkdirSync(join(scoped, "node_modules/@scope"), { recursive: true });
  fs.symlinkSync(join(outside, "pkg"), join(scoped, "node_modules/@scope/pkg"));
  assert.equal(lib.escapingLinks(scoped).length, 1);

  const absoluteInside = scratch();
  write(absoluteInside, "node_modules/real/package.json", "{}");
  fs.mkdirSync(join(absoluteInside, "apps/web/node_modules"), { recursive: true });
  fs.symlinkSync(join(absoluteInside, "node_modules/real"), join(absoluteInside, "apps/web/node_modules/real"));
  assert.equal(lib.escapingLinks(absoluteInside).length, 1);

  const nested = scratch();
  fs.mkdirSync(join(nested, "node_modules/a/node_modules"), { recursive: true });
  fs.symlinkSync("../../../../elsewhere", join(nested, "node_modules/a/node_modules/b"));
  assert.equal(lib.escapingLinks(nested).length, 0);
  assert.equal(lib.escapingLinks(nested, { deep: true }).length, 1);

  const whole = scratch();
  fs.symlinkSync(join(outside, "pkg"), join(whole, "node_modules"));
  assert.equal(lib.escapingLinks(whole).length, 1);
  assert.deepEqual(lib.escapingLinks(scratch()), []);
});

test("a slot under a symlinked slot root is busy by the lock locked takes on its real path", () => {
  const real = scratch();
  const linkParent = scratch();
  const linked = join(linkParent, "slots");
  fs.symlinkSync(real, linked);
  const slot = join(linked, "1");
  fs.mkdirSync(lib.slotDerivedData(slot), { recursive: true });
  const locks = scratch();
  const holder = lib.lockHolderPath(fs.realpathSync(lib.slotDerivedData(slot)), locks);
  fs.writeFileSync(holder, `pid ${process.pid} since now\n`);
  assert.ok(lib.slotBusy(slot, { root: locks }));
  assert.notEqual(lib.lockHolderPath(lib.slotDerivedData(slot), locks), holder);
});
