import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareApp, untouchedCopy } from "./app-copy.mjs";

const PLIST = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fake</string><key>CFBundleIdentifier</key><string>dev.ardia.fake</string></dict></plist>`;
const entitlements = (keys) => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${keys.map((k) => `<key>${k}</key><true/>`).join("")}</dict></plist>`;

function fakeApp({ debug = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "app-copy-"));
  const app = join(dir, "Fake.app");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents/Resources"), { recursive: true });
  writeFileSync(join(app, "Contents/Info.plist"), PLIST);
  copyFileSync("/usr/bin/true", join(app, "Contents/MacOS/Fake"));
  writeFileSync(join(app, "Contents/Resources/main.jsbundle"), "shipped");
  const plist = join(dir, "ent.plist");
  writeFileSync(plist, entitlements(debug ? ["com.apple.security.get-task-allow"] : []));
  execFileSync("codesign", ["--force", "--sign", "-", "--entitlements", plist, app], { stdio: "ignore" });
  const own = join(dir, "own.jsbundle");
  writeFileSync(own, "shipped");
  const other = join(dir, "other.jsbundle");
  writeFileSync(other, "the tree");
  return { dir, app, own, other };
}

const birth = (path) => statSync(path).birthtimeMs;

test("a release app run with its own bundle and no injection is cloned untouched: no ip.txt, no re-sign", () => {
  const { dir, app, own } = fakeApp();
  const copy = prepareApp(app, join(dir, "out"), { bundle: own });
  assert.equal(existsSync(join(copy, "Contents/Resources/ip.txt")), false);
  execFileSync("codesign", ["--verify", "--strict", copy]);
  assert.equal(readFileSync(join(copy, "Contents/Resources/main.jsbundle"), "utf8"), "shipped");
});

test("the untouched copy is reused on the next run instead of cloned again", () => {
  const { dir, app, own } = fakeApp();
  const first = prepareApp(app, join(dir, "out"), { bundle: own });
  const made = birth(join(first, "Contents/Info.plist"));
  const second = prepareApp(app, join(dir, "out"), { bundle: own });
  assert.equal(second, first);
  assert.equal(birth(join(second, "Contents/Info.plist")), made);
});

test("a copy left from another bundle is cloned fresh, not reused", () => {
  const { dir, app, own, other } = fakeApp();
  prepareApp(app, join(dir, "out"), { bundle: other });
  const copy = prepareApp(app, join(dir, "out"), { bundle: own });
  assert.equal(existsSync(join(copy, "Contents/Resources/ip.txt")), false);
  assert.equal(readFileSync(join(copy, "Contents/Resources/main.jsbundle"), "utf8"), "shipped");
  execFileSync("codesign", ["--verify", "--strict", copy]);
});

test("another bundle is swapped in and the copy re-signed", () => {
  const { dir, app, other } = fakeApp();
  const copy = prepareApp(app, join(dir, "out"), { bundle: other });
  assert.equal(readFileSync(join(copy, "Contents/Resources/main.jsbundle"), "utf8"), "the tree");
  assert.equal(existsSync(join(copy, "Contents/Resources/ip.txt")), true);
  execFileSync("codesign", ["--verify", "--strict", copy]);
});

test("a debug build still gets ip.txt, so it can't load Metro's code instead of its bundle", () => {
  const { dir, app, own } = fakeApp({ debug: true });
  const copy = prepareApp(app, join(dir, "out"), { bundle: own });
  assert.equal(existsSync(join(copy, "Contents/Resources/ip.txt")), true);
  execFileSync("codesign", ["--verify", "--strict", copy]);
});

test("the injection entitlements still force a re-sign", () => {
  const { dir, app, own } = fakeApp();
  const copy = prepareApp(app, join(dir, "out"), { bundle: own, entitlements: ["com.apple.security.cs.disable-library-validation"] });
  assert.match(execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", copy], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), /disable-library-validation/);
});

test("untouchedCopy: only an unchanged release bundle without missing entitlements skips the re-sign", () => {
  const { app, own, other } = fakeApp();
  const granted = "<plist><dict></dict></plist>";
  assert.equal(untouchedCopy({ source: app, bundle: null, granted, missing: [] }), true);
  assert.equal(untouchedCopy({ source: app, bundle: own, granted, missing: [] }), true);
  assert.equal(untouchedCopy({ source: app, bundle: other, granted, missing: [] }), false);
  assert.equal(untouchedCopy({ source: app, bundle: own, granted, missing: ["x"] }), false);
  assert.equal(untouchedCopy({ source: app, bundle: own, granted: "<key>com.apple.security.get-task-allow</key>", missing: [] }), false);
});

test("a cached copy whose resources were changed after cloning is cloned again, not reused", () => {
  const { dir, app, own } = fakeApp();
  const first = prepareApp(app, join(dir, "out"), { bundle: own });
  writeFileSync(join(first, "Contents/Resources/main.jsbundle"), "tampered");
  const second = prepareApp(app, join(dir, "out"), { bundle: own });
  assert.equal(readFileSync(join(second, "Contents/Resources/main.jsbundle"), "utf8"), "shipped");
  execFileSync("codesign", ["--verify", "--strict", second]);
});
