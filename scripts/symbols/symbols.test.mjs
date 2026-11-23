import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import { fat, machO, words } from "./fixture.mjs";
import { crashFrames, frameOffset, freezeFrames, imageUuids, nativeFrames, wantedFrames } from "./frames.mjs";
import { knownSql, plan, resolve, RETRY_MISSING_MS, run } from "./job.mjs";
import { functionStarts, functionSymbols, imageFor, parseImage } from "./macho.mjs";
import { parseUuids, SymbolStore } from "./releases.mjs";
import { maskedWords, nameStripped } from "./stripped.mjs";
import { buildMap, demangle, lookup, parseMap, serializeMap } from "./symbol-map.mjs";

const NO_DEMANGLERS = { swift: [], cxx: [] };
const ENGINE_UUID = "4c4c4449-5555-3144-a17c-2ebff056d510";
const APP_UUID = "6c57f7df-5c37-325c-8c92-a15c7007c150";
const OTHER_UUID = "11111111-2222-3333-4444-555555555555";
const scratch = mkdtempSync(join(tmpdir(), "symbols-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const BASE = 0x100000000;
const TEXT = BASE + 0x1000;

function appBinary(uuid = APP_UUID) {
  return machO({
    uuid,
    base: BASE,
    textAddr: TEXT,
    text: Buffer.alloc(0x300, 0xd5),
    symbols: [
      { name: "_main", address: TEXT, type: 0x0f },
      { name: "-[MenuTarget undo:]", address: TEXT + 0x100, type: 0x0e },
      { name: "ltmp3", address: TEXT + 0x180, type: 0x0e },
      { name: "_$s5Ardia10MenuTargetC4undoyyypF", address: TEXT + 0x200, type: 0x0e },
      { name: "_$s5Ardia10MenuTargetC4undoyyypF.alias", address: TEXT + 0x200, type: 0x0f },
      { name: "_debug_map", address: TEXT + 0x10, type: 0x24 },
      { name: "_undefined", address: 0, type: 0x01, sect: 0 },
      { name: "_in_data", address: TEXT + 0x20, type: 0x0e, sect: 2 },
    ],
    starts: [TEXT, TEXT + 0x100, TEXT + 0x200],
  });
}

test("a Mach-O image gives its UUID, its __TEXT base and its __text section", () => {
  const { slice, image } = imageFor(appBinary());
  assert.equal(image.uuid, APP_UUID);
  assert.equal(image.arch, "arm64");
  assert.equal(image.base, BASE);
  assert.deepEqual([image.text.addr, image.text.size], [TEXT, 0x300]);
  assert.deepEqual(functionStarts(slice, image), [TEXT, TEXT + 0x100, TEXT + 0x200]);
  const names = functionSymbols(slice, image).map((s) => s.name);
  assert.deepEqual(names, ["_main", "-[MenuTarget undo:]", "_$s5Ardia10MenuTargetC4undoyyypF", "_$s5Ardia10MenuTargetC4undoyyypF.alias"]);
});

test("a fat file is searched slice by slice for the wanted UUID", () => {
  const x86 = machO({ uuid: OTHER_UUID, cpu: 0x01000007, text: Buffer.alloc(16), symbols: [] });
  const file = fat([x86, appBinary()]);
  assert.equal(imageFor(file, APP_UUID).image.arch, "arm64");
  assert.equal(imageFor(file, OTHER_UUID).image.arch, "x86_64");
  assert.equal(imageFor(file, ENGINE_UUID), null);
  assert.throws(() => imageFor(Buffer.from("not a binary at all")), /Mach-O/);
  assert.throws(() => parseImage(Buffer.alloc(64)), /Mach-O/);
});

test("a frame's offset is from the image's __TEXT start, and names the function that holds it", () => {
  const map = buildMap(appBinary(), APP_UUID, { demanglers: NO_DEMANGLERS });
  assert.equal(map.entries.length, 3);
  assert.deepEqual(lookup(map, 0x1000), { name: "main", delta: 0 });
  assert.deepEqual(lookup(map, 0x10ff), { name: "main", delta: 0xff });
  assert.deepEqual(lookup(map, 0x1100), { name: "-[MenuTarget undo:]", delta: 0 });
  assert.deepEqual(lookup(map, 0x1190), { name: "-[MenuTarget undo:]", delta: 0x90 });
  assert.deepEqual(lookup(map, 0x1280), { name: "$s5Ardia10MenuTargetC4undoyyypF.alias", delta: 0x80 });
  assert.equal(lookup(map, 0xfff), null);
  assert.equal(lookup(map, 0x1300), null);
  assert.equal(lookup(map, -1), null);
  assert.equal(lookup(map, 2 ** 60), null);
});

test("a framework's offsets start at 0 because its __TEXT does", () => {
  const binary = machO({ uuid: ENGINE_UUID, base: 0, textAddr: 0x4000, text: Buffer.alloc(0x100), symbols: [{ name: "__ZN4base5ValueD2Ev", address: 0x4040 }] });
  const map = buildMap(binary, ENGINE_UUID, { demanglers: NO_DEMANGLERS });
  assert.deepEqual(lookup(map, 0x4050), { name: "_ZN4base5ValueD2Ev", delta: 0x10 });
  assert.equal(lookup(map, 0x4000), null);
});

test("a symbol map survives being written and read back, and a bad one is refused", () => {
  const map = buildMap(appBinary(), APP_UUID, { demanglers: NO_DEMANGLERS });
  const back = parseMap(serializeMap(map));
  assert.deepEqual(back, { ...map });
  assert.throws(() => parseMap("hello\n"), /not an Ardia symbol map/);
  const text = serializeMap(map).split("\n");
  assert.throws(() => parseMap([text[0], text[2], text[1]].join("\n")), /sorted/);
  assert.throws(() => parseMap([text[0], "zz\t10\tx"].join("\n")), /malformed/);
  assert.throws(() => parseMap(text[0].replace(APP_UUID, "../../etc") + "\n"), /header/);
});

test("names go to the Swift and C++ demanglers that are there, and stay as they are without one", () => {
  const bin = join(scratch, "bin");
  mkdirSync(bin, { recursive: true });
  const fake = (name, prefix) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\nwhile IFS= read -r line; do echo "${prefix}$line"; done\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const demanglers = { swift: [["/nonexistent/swift-demangle", []], [fake("swift", "swift:"), []]], cxx: [[fake("cxx", "cxx:"), []]] };
  const names = ["_$s5Ardia1AC", "__ZN4base5ValueD2Ev", "____ZN4base1FEv_block_invoke_2", "-[Foo bar:]", "___49+[Foo baz]_block_invoke", "_main"];
  assert.deepEqual(demangle(names, demanglers), ["swift:$s5Ardia1AC", "cxx:_ZN4base5ValueD2Ev", "invocation function for block in cxx:_ZN4base1FEv", "-[Foo bar:]", "__49+[Foo baz]_block_invoke", "main"]);
  assert.deepEqual(demangle(names, NO_DEMANGLERS), ["$s5Ardia1AC", "_ZN4base5ValueD2Ev", "___ZN4base1FEv_block_invoke_2", "-[Foo bar:]", "__49+[Foo baz]_block_invoke", "main"]);
});

test("frames are read from crash and freeze events, keyed by their image's UUID", () => {
  const images = imageUuids(JSON.stringify([{ name: "Ardia", uuid: APP_UUID.toUpperCase() }, { name: "Chromium Framework", uuid: ENGINE_UUID }, { name: "bad", uuid: "nope" }, { name: 3, uuid: OTHER_UUID }]));
  assert.deepEqual([...images], [["Ardia", APP_UUID], ["Chromium Framework", ENGINE_UUID]]);
  assert.equal(imageUuids("not json").size, 0);
  assert.equal(frameOffset({ image_offset: "0x327180" }), 0x327180);
  for (const bad of ["327180", "0x", "0xzz", "0x" + "f".repeat(14), 12, null]) assert.equal(frameOffset({ image_offset: bad }), null);
  const crash = JSON.stringify([
    { type: "EXC_BAD_ACCESS", stacktrace: { frames: [{ module: "Ardia", image_offset: "0x7d038" }, { module: "Ardia", image_offset: "0x327180" }, { module: "AppKit", function: "-[NSUndoManager undo]" }] } },
    { type: "second", stacktrace: { frames: [{ module: "Chromium Framework", image_offset: "0x9ce0c00" }] } },
  ]);
  assert.equal(crashFrames(crash).length, 4);
  assert.deepEqual(nativeFrames(crashFrames(crash), images).map((f) => f.offset), [0x7d038, 0x327180, 0x9ce0c00]);
  const freeze = JSON.stringify([{ module: "system", image_offset: "0x10" }, { module: "Chromium Framework", image_offset: "0x318e860" }]);
  assert.deepEqual(nativeFrames(freezeFrames(freeze), images), [{ image: "Chromium Framework", uuid: ENGINE_UUID, offset: 0x318e860 }]);
  const wanted = wantedFrames([
    { kind: "crash", images: JSON.stringify([{ name: "Ardia", uuid: APP_UUID }]), frames: crash },
    { kind: "crash", images: JSON.stringify([{ name: "Ardia", uuid: APP_UUID }]), frames: crash },
    { kind: "freeze", images: JSON.stringify([{ name: "Chromium Framework", uuid: ENGINE_UUID }]), frames: freeze },
  ]);
  assert.equal(wanted.length, 3);
});

test("a frame is named once, and one without symbols is tried again after a day", () => {
  const now = 10 * RETRY_MISSING_MS;
  const wanted = [1, 2, 3, 4].map((offset) => ({ image: "Ardia", uuid: APP_UUID, offset }));
  const known = [
    { uuid: APP_UUID, offset: "1", source: "dsym", at: 0 },
    { uuid: APP_UUID, offset: 2, source: "none", at: now - 1000 },
    { uuid: APP_UUID, offset: 3, source: "none", at: now - RETRY_MISSING_MS },
    { uuid: APP_UUID, offset: 4, source: "match", at: now - 1000 },
    { uuid: APP_UUID, offset: 5, source: "match", at: now - RETRY_MISSING_MS },
    { uuid: APP_UUID, offset: 6, source: "outside", at: now - RETRY_MISSING_MS },
  ];
  const all = [...wanted, ...[5, 6, 7].map((offset) => ({ image: "Ardia", uuid: APP_UUID, offset }))];
  assert.deepEqual(plan(all, known, now).map((f) => f.offset), [3, 5, 6, 7]);
  assert.match(knownSql("sandbox", [APP_UUID, "x'); DROP TABLE y; --"]), new RegExp(`IN \\('${APP_UUID}'\\)`));
  assert.throws(() => knownSql("sandbox; DROP", []), /identifier/);
  const map = buildMap(appBinary(), APP_UUID, { demanglers: NO_DEMANGLERS });
  const rows = resolve([{ image: "Ardia", uuid: APP_UUID, offset: 0x1104 }, { image: "Ardia", uuid: APP_UUID, offset: 0x9000 }, { image: "Chromium Framework", uuid: ENGINE_UUID, offset: 5 }], new Map([[APP_UUID, map]]), 0);
  assert.deepEqual(rows.map((r) => [r.symbol, r.symbol_offset, r.source]), [["-[MenuTarget undo:]", 4, "dsym"], ["", 0, "outside"], ["", 0, "none"]]);
  assert.equal(rows[0].resolved_at, "1970-01-01 00:00:00.000");
  const kept = resolve([{ image: "Ardia", uuid: ENGINE_UUID, offset: 9 }], new Map(), 5, [{ uuid: ENGINE_UUID, offset: "9", source: "match", symbol: "MenuTarget.undo(_:)", symbol_offset: "400", at: 0 }]);
  assert.deepEqual(kept.map((r) => [r.symbol, r.symbol_offset, r.source]), [["MenuTarget.undo(_:)", 400, "match"]], "a recheck that finds nothing keeps the name it had");
});

test("release UUID lists are read strictly", () => {
  const rows = parseUuids([
    `${ENGINE_UUID}\tarm64\tChromium Framework.dSYM/Contents/Resources/DWARF/Chromium Framework`,
    `${APP_UUID}\tarm64\t../../etc/passwd`,
    `${OTHER_UUID}\tarm64\tx.dSYM/Contents/Resources/DWARF/../../../evil`,
    "garbage",
  ].join("\n"));
  assert.deepEqual(rows.map((r) => r.uuid), [ENGINE_UUID]);
});

const haveXz = spawnSync("xz", ["--version"]).status === 0 && spawnSync("tar", ["--version"]).status === 0;

test("end to end: frames from events are named from a published release's dSYM and a symbol-map asset, and written", { skip: !haveXz && "needs tar and xz" }, async () => {
  const release = join(scratch, "release");
  const dwarf = "Chromium Framework.dSYM/Contents/Resources/DWARF/Chromium Framework";
  mkdirSync(join(release, "Chromium Framework.dSYM/Contents/Resources/DWARF"), { recursive: true });
  const engine = machO({ uuid: ENGINE_UUID, base: 0, textAddr: 0x4000, text: Buffer.alloc(0x200), symbols: [{ name: "_ac_cli_control", address: 0x4000 }, { name: "-[CrApplication sendAction:to:from:]", address: 0x4100, type: 0x0e }] });
  writeFileSync(join(release, dwarf), fat([machO({ uuid: OTHER_UUID, cpu: 0x01000007, text: Buffer.alloc(16) }), engine]));
  const archive = join(scratch, "ArdiaCore-367b6b04ea64-symbols.tar.xz");
  assert.equal(spawnSync("tar", ["-cJf", archive, "-C", release, "Chromium Framework.dSYM"]).status, 0);
  const appMap = buildMap(appBinary(), APP_UUID, { demanglers: NO_DEMANGLERS });
  const assets = {
    "engine-dca8c35f7ac2/ArdiaCore-dca8c35f7ac2-uuids.txt": `${ENGINE_UUID}\tarm64\t${dwarf}\n`,
    "engine-367b6b04ea64/ArdiaCore-367b6b04ea64-uuids.txt": `${ENGINE_UUID}\tarm64\t${dwarf}\n`,
    "engine-367b6b04ea64/ArdiaCore-367b6b04ea64-symbols.tar.xz": readFileSync(archive),
    "v0.2.47/Ardia-0.2.47-symbol-map.tsv.gz": gzipSync(serializeMap({ ...appMap, source: "match" })),
  };
  const releases = [
    { tag_name: "engine-dca8c35f7ac2", assets: [{ name: "ArdiaCore-dca8c35f7ac2-uuids.txt" }, { name: "ArdiaCore-dca8c35f7ac2-symbols.tar.xz" }] },
    { tag_name: "engine-367b6b04ea64", assets: [{ name: "ArdiaCore-367b6b04ea64-uuids.txt" }, { name: "ArdiaCore-367b6b04ea64-symbols.tar.xz" }] },
    { tag_name: "v0.2.47", assets: [{ name: "Ardia-0.2.47.zip" }, { name: "Ardia-0.2.47-symbol-map.tsv.gz" }] },
    { tag_name: "not-a-release", assets: [{ name: "x-uuids.txt" }] },
  ];
  const fetched = [];
  const fetch = async (url) => {
    const u = String(url);
    fetched.push(u);
    if (u.startsWith("https://api.github.com/")) return new Response(JSON.stringify(u.endsWith("page=1") ? releases : []), { status: 200 });
    const key = decodeURIComponent(u.replace("https://github.com/ardia-browser/ardia/releases/download/", ""));
    if (key.includes("dca8c35f7ac2-symbols")) return new Response("gone", { status: 404 });
    return key in assets ? new Response(assets[key], { status: 200 }) : new Response("missing", { status: 404 });
  };
  const store = new SymbolStore({ cache: join(scratch, "cache"), repo: "ardia-browser/ardia", fetch, log: () => {} });
  const events = [
    { kind: "crash", images: JSON.stringify([{ name: "Ardia", uuid: APP_UUID }, { name: "Chromium Framework", uuid: ENGINE_UUID }]), frames: JSON.stringify([{ stacktrace: { frames: [{ module: "Chromium Framework", image_offset: "0x4104" }, { module: "Ardia", image_offset: "0x1210" }] } }]) },
    { kind: "freeze", images: JSON.stringify([{ name: "Chromium Framework", uuid: ENGINE_UUID }, { name: "Ardia", uuid: OTHER_UUID }]), frames: JSON.stringify([{ module: "Chromium Framework", image_offset: "0x45d4" }, { module: "Ardia", image_offset: "0x10" }]) },
  ];
  const statements = [];
  const reader = async (sql, { params }) => {
    assert.match(sql, /FROM telemetry\.events/);
    assert.equal(params.days, 14);
    return events.map((e) => JSON.stringify(e)).join("\n");
  };
  const sandbox = async (sql, { body } = {}) => {
    statements.push({ sql, body });
    return /^SELECT/.test(sql) ? JSON.stringify({ uuid: ENGINE_UUID, offset: 0x45d4, source: "dsym", at: 0 }) + "\n" : "";
  };
  const { rows, summary } = await run({ reader, sandbox, store, now: Date.UTC(2026, 10, 22) });
  const named = Object.fromEntries(rows.map((r) => [`${r.image}+0x${r.offset.toString(16)}`, `${r.symbol}|${r.symbol_offset}|${r.source}`]));
  assert.deepEqual(named, {
    "Chromium Framework+0x4104": "-[CrApplication sendAction:to:from:]|4|dsym",
    "Ardia+0x1210": "$s5Ardia10MenuTargetC4undoyyypF.alias|16|match",
    "Ardia+0x10": "|0|none",
  });
  assert.deepEqual(summary.buildsWithoutSymbols, [`Ardia ${OTHER_UUID}`]);
  assert.match(statements[0].sql, /CREATE TABLE IF NOT EXISTS sandbox\.ardia_frame_symbols/);
  const insert = statements.find((s) => /^INSERT/.test(s.sql));
  assert.equal(insert.body.split("\n").length, 3);
  assert.ok(fetched.some((u) => u.includes("dca8c35f7ac2-symbols")), "the first release listing the UUID is tried");
  assert.ok(existsSync(join(scratch, "cache/maps", `${ENGINE_UUID}.map.gz`)));
  assert.ok(!existsSync(join(scratch, "cache/work/engine-367b6b04ea64")));
  fetched.length = 0;
  const again = new SymbolStore({ cache: join(scratch, "cache"), repo: "ardia-browser/ardia", fetch, log: () => {} });
  assert.equal((await again.maps([ENGINE_UUID])).get(ENGINE_UUID).entries.length, 2);
  assert.deepEqual(fetched, [], "a cached map needs no download");
  await assert.rejects(run({ reader, sandbox: null, store }), /sandbox/);
  const dry = await run({ reader, sandbox: null, store, dryRun: true });
  assert.equal(dry.rows.length, 4);
});

test("masking ignores PC-relative fields, so moved code still matches", () => {
  const a = maskedWords(Uint32Array.from([0x94000010, 0x90000008, 0x91002108, 0xf9400508, 0x91000400, 0x14000002]));
  const b = maskedWords(Uint32Array.from([0x94000220, 0xb0000008, 0x91234108, 0xf9411108, 0x91000400, 0x14000002]));
  assert.deepEqual([...a], [...b]);
  const c = maskedWords(Uint32Array.from([0x91000800]));
  assert.notDeepEqual([...maskedWords(Uint32Array.from([0x91000400]))], [...c]);
});

test("a stripped build is named from its own Objective-C table, identical code, then position", () => {
  const body = (seed) => words([0xd503201f, seed, 0x94000000 | (seed & 0xff), 0xd65f03c0]);
  const sibling = machO({ uuid: OTHER_UUID, text: Buffer.concat([body(1), body(2), body(3), body(4)]), starts: [TEXT, TEXT + 16, TEXT + 32, TEXT + 48] });
  const dsym = machO({ uuid: OTHER_UUID, text: Buffer.alloc(64), symbols: ["_one", "_two", "_three", "_four"].map((name, i) => ({ name, address: TEXT + i * 16 })) });
  const target = machO({ uuid: APP_UUID, text: Buffer.concat([body(1), body(99), body(3), body(4)]), starts: [TEXT, TEXT + 16, TEXT + 32, TEXT + 48] });
  const { map, counts } = nameStripped({ targetBuffer: target, siblingBuffer: sibling, dsymBuffer: dsym, objc: new Map([[0x1030, "-[Foo four]"]]), demanglers: NO_DEMANGLERS });
  assert.equal(map.uuid, APP_UUID);
  assert.equal(map.source, "match");
  assert.deepEqual(map.entries.map((e) => e.name), ["one", "two (by position)", "three", "-[Foo four]"]);
  assert.deepEqual(counts, { objc: 1, code: 2, position: 1, none: 0 });
});

const haveClang = process.platform === "darwin" && spawnSync("xcrun", ["--find", "dsymutil"]).status === 0 && spawnSync("xcrun", ["--find", "clang"]).status === 0;

test("a real dSYM made by clang and dsymutil names the same functions atos does", { skip: !haveClang && "needs macOS with clang, dsymutil and atos" }, () => {
  const dir = join(scratch, "real");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.c"), "__attribute__((noinline)) int first(int x) { return x * 3 + 1; }\n__attribute__((noinline)) int second(int x) { return first(x) + first(x + 1); }\nint main(int c, char **v) { return second(c); }\n");
  const binary = join(dir, "a.out");
  assert.equal(spawnSync("xcrun", ["clang", "-arch", "arm64", "-g", "-O1", "-o", binary, join(dir, "a.c")]).status, 0);
  assert.equal(spawnSync("xcrun", ["dsymutil", binary, "-o", `${binary}.dSYM`]).status, 0);
  const uuid = spawnSync("dwarfdump", ["--uuid", binary], { encoding: "utf8" }).stdout.match(/UUID: (\S+)/)[1].toLowerCase();
  const map = buildMap(readFileSync(`${binary}.dSYM/Contents/Resources/DWARF/a.out`), uuid);
  const names = map.entries.map((e) => e.name);
  for (const name of ["first", "second", "main"]) assert.ok(names.includes(name), `${name} is in ${names}`);
  const second = map.entries.find((e) => e.name === "second");
  const offset = second.start + 4;
  const atos = spawnSync("atos", ["-arch", "arm64", "-o", `${binary}.dSYM/Contents/Resources/DWARF/a.out`, "-offset", `0x${offset.toString(16)}`], { encoding: "utf8" }).stdout;
  assert.match(atos, /^second /);
  assert.deepEqual(lookup(map, offset), { name: "second", delta: 4 });
});

test("hostile telemetry never reaches SQL or the stored rows as anything but a checked UUID, offset or image name", async () => {
  const { HOSTILE_VALUES } = await import("../security/hostile-inputs.mjs");
  const safeImage = /^[A-Za-z0-9 ._()+-]{1,64}$/;
  for (const { id, value } of HOSTILE_VALUES) {
    assert.equal(frameOffset({ image_offset: value }), null, id);
    assert.equal(imageUuids([{ name: "Ardia", uuid: value }]).size, 0, id);
    for (const name of imageUuids([{ name: value, uuid: APP_UUID }]).keys()) assert.match(name, safeImage, id);
    assert.deepEqual(parseUuids(typeof value === "string" ? value : ""), [], id);
    assert.throws(() => parseMap(typeof value === "string" ? value : ""), id);
    const frames = wantedFrames([
      { kind: "crash", images: value, frames: value },
      { kind: "freeze", images: JSON.stringify([{ name: value, uuid: APP_UUID }]), frames: JSON.stringify([{ module: value, image_offset: "0x10" }, { module: "Ardia", image_offset: value }]) },
    ]);
    for (const f of frames) {
      assert.match(f.uuid, /^[0-9a-f-]{36}$/, id);
      assert.match(f.image, safeImage, id);
    }
    if (typeof value === "string") assert.equal(knownSql("sandbox", [value]), knownSql("sandbox", []), id);
  }
});

test("a function the linker folded with identical ones says so instead of passing for the one name it kept", () => {
  const binary = machO({
    uuid: ENGINE_UUID,
    base: 0,
    textAddr: 0x4000,
    text: Buffer.alloc(0x100),
    symbols: [
      { name: "<deduplicated_symbol>", address: 0x4000 },
      { name: "__ZN5blink21ScriptEvaluationResultC2Ev", address: 0x4000, type: 0x0e },
      { name: "_only_one", address: 0x4080 },
    ],
  });
  const map = buildMap(binary, ENGINE_UUID, { demanglers: NO_DEMANGLERS });
  assert.deepEqual(map.entries.map((e) => e.name), ["_ZN5blink21ScriptEvaluationResultC2Ev (identical code folded)", "only_one"]);
});

test("a cached match map gives way to a dSYM a release publishes later, and stays when that download fails", { skip: !haveXz && "needs tar and xz" }, async () => {
  const dwarf = "Ardia.app.dSYM/Contents/Resources/DWARF/Ardia";
  const release = join(scratch, "later-release");
  mkdirSync(join(release, "Ardia.app.dSYM/Contents/Resources/DWARF"), { recursive: true });
  writeFileSync(join(release, dwarf), appBinary());
  const archive = join(scratch, "Ardia-0.2.49-symbols.tar.xz");
  assert.equal(spawnSync("tar", ["-cJf", archive, "-C", release, "Ardia.app.dSYM"]).status, 0);
  const releases = [
    { tag_name: "v0.2.50", assets: [{ name: "Ardia-0.2.50-uuids.txt" }, { name: "Ardia-0.2.50-symbols.tar.xz" }] },
    { tag_name: "v0.2.49", assets: [{ name: "Ardia-0.2.49-uuids.txt" }, { name: "Ardia-0.2.49-symbols.tar.xz" }] },
  ];
  let serveArchive = false;
  const fetch = async (url) => {
    const u = decodeURIComponent(String(url));
    if (u.startsWith("https://api.github.com/")) return new Response(JSON.stringify(u.endsWith("page=1") ? releases : []), { status: 200 });
    if (u.endsWith("Ardia-0.2.50-uuids.txt")) return new Response("gone", { status: 404 });
    if (u.endsWith("Ardia-0.2.49-uuids.txt")) return new Response(`${APP_UUID}\tarm64\t${dwarf}\n`, { status: 200 });
    if (u.endsWith("Ardia-0.2.49-symbols.tar.xz") && serveArchive) return new Response(readFileSync(archive), { status: 200 });
    return new Response("missing", { status: 404 });
  };
  const cache = join(scratch, "later-cache");
  const matched = { ...buildMap(appBinary(), APP_UUID, { demanglers: NO_DEMANGLERS }), source: "match", entries: [{ start: 0x1000, end: 0x1100, name: "guess" }] };
  const store = new SymbolStore({ cache, repo: "ardia-browser/ardia", fetch });
  store.saveMap(matched);
  assert.equal((await store.maps([APP_UUID])).get(APP_UUID).source, "match", "a failed dSYM download keeps the match map, and a missing manifest doesn't stop the index");
  const pageTwoRefused = new SymbolStore({
    cache: join(scratch, "page-two-cache"),
    repo: "ardia-browser/ardia",
    fetch: async (url) => {
      const u = decodeURIComponent(String(url));
      if (u.endsWith("page=1")) return new Response(JSON.stringify([{ tag_name: "v0.2.47", assets: [{ name: "Ardia-0.2.47-symbol-map.tsv.gz" }] }]), { status: 200 });
      if (u.endsWith("Ardia-0.2.47-symbol-map.tsv.gz")) return new Response(gzipSync(serializeMap(matched)), { status: 200 });
      return new Response("rate limited", { status: 403 });
    },
    log: () => {},
  });
  assert.equal((await pageTwoRefused.maps([APP_UUID])).get(APP_UUID)?.source, "match", "a map fetched before the listing fails is used in the same run");
  const offline = new SymbolStore({ cache, repo: "ardia-browser/ardia", fetch: async () => new Response("rate limited", { status: 403 }), log: () => {} });
  assert.equal((await offline.maps([APP_UUID])).get(APP_UUID).source, "match", "a release list GitHub refuses still leaves the cached map");
  serveArchive = true;
  const later = new SymbolStore({ cache, repo: "ardia-browser/ardia", fetch });
  const map = (await later.maps([APP_UUID])).get(APP_UUID);
  assert.equal(map.source, "dsym");
  assert.deepEqual(lookup(map, 0x1104), { name: "-[MenuTarget undo:]", delta: 4 });
});
