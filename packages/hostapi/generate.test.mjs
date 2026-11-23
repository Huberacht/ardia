import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDomains, MANIFEST, outputs, ROOT, validate } from "./generate.mjs";

const GENERATOR = fileURLToPath(new URL("./generate.mjs", import.meta.url));
const runAt = (generator, ...args) => spawnSync(process.execPath, [generator, ...args], { encoding: "utf8" });
const run = (...args) => runAt(GENERATOR, ...args);
const call = (overrides = {}) => ({ args: "Profile", result: "Done", service: "ac_demo_watch", desktop: "route", ...overrides });
const domain = (calls) => ({ kind: "engine", imports: {}, calls, events: {} });

test("every generated file matches the schema byte for byte", async () => {
  const result = run("--check");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `up to date: ${outputs(await loadDomains()).size} files\n`);
});

test("the generator takes exactly one mode", () => {
  assert.equal(run().status, 2);
  assert.equal(run("--check", "--write").status, 2);
  assert.equal(run("--force").status, 2);
});

test("run through a symlinked path, the generator still runs, so a check can't pass by doing nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "hostapi-link-"));
  try {
    const link = join(dir, "hostapi");
    symlinkSync(fileURLToPath(new URL(".", import.meta.url)), link, process.platform === "win32" ? "junction" : "dir");
    const linked = join(link, "generate.mjs");
    assert.equal(runAt(linked, "--force").status, 2);
    const result = runAt(linked, "--check");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^up to date: \d+ files\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git checks every generated file out with LF endings, so a CRLF checkout still matches byte for byte", async () => {
  const paths = [...outputs(await loadDomains()).keys()];
  const result = spawnSync("git", ["check-attr", "eol", "--", ...paths], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), paths.map((path) => `${path}: eol: lf`));
});

test("only engine domains are generated until positional module domains get their own call shape", () => {
  assert.doesNotThrow(() => validate("demo", domain({ watch: call() })));
  assert.throws(() => validate("demo", { ...domain({ watch: call() }), kind: "module" }), /kind is engine/);
  const { kind, ...unkinded } = domain({ watch: call() });
  assert.equal(kind, "engine");
  assert.throws(() => validate("demo", unkinded), /kind is engine/);
});

test("two runs give the same bytes, so the check never flaps", async () => {
  const once = outputs(await loadDomains());
  const twice = outputs(await loadDomains());
  assert.deepEqual([...once], [...twice]);
});

test("the manifest lists every schema call with its service and each host's binding", async () => {
  const domains = await loadDomains();
  const manifest = JSON.parse(readFileSync(ROOT + MANIFEST, "utf8"));
  assert.deepEqual(Object.keys(manifest.domains), Object.keys(domains));
  for (const [name, schema] of Object.entries(domains)) {
    const listed = manifest.domains[name];
    assert.deepEqual(Object.keys(listed.calls), Object.keys(schema.calls));
    assert.deepEqual(listed.events, Object.keys(schema.events));
    for (const [verb, row] of Object.entries(schema.calls)) {
      assert.equal(listed.calls[verb].service, row.service);
      assert.equal(listed.calls[verb].desktop, row.desktop);
      assert.equal(listed.calls[verb].mac, row.mac ?? "service");
      assert.equal(listed.calls[verb].windows, row.windows ?? "service");
    }
  }
});

test("a call that doesn't say whether the desktop host routes it is refused, never routed by default", () => {
  const { desktop, ...unsaid } = call();
  assert.equal(desktop, "route");
  assert.throws(() => validate("demo", domain({ watch: unsaid })), /never implied/);
  for (const binding of ["route", "custom", "absent"]) assert.doesNotThrow(() => validate("demo", domain({ watch: call({ desktop: binding }) })));
  assert.throws(() => validate("demo", domain({ watch: call({ desktop: "service" }) })), /desktop is one of/);
});

test("names, services and bindings outside the schema's forms are refused", () => {
  assert.throws(() => validate("Demo", domain({})), /lowerCamelCase/);
  assert.throws(() => validate("demo", domain({ "watch-all": call() })), /lowerCamelCase/);
  assert.throws(() => validate("demo", domain({ watch: call({ service: "demo_watch" }) })), /ac_\* call/);
  assert.throws(() => validate("demo", domain({ watch: call({ mac: "route" }) })), /mac is one of/);
  assert.throws(() => validate("demo", domain({ watch: call({ args: "" }) })), /args type/);
  assert.throws(() => validate("demo", { kind: "engine", imports: { "@ardia/core": ["Thing"] }, calls: {}, events: {} }), /relative/);
});

test("a domain the Mac serves straight from the engine gets its whole Swift module, and a mixed one gets none yet", () => {
  const files = outputs({ demo: domain({ watch: call() }), mixed: domain({ watch: call(), open: call({ mac: "custom", service: "ac_mixed_open" }) }) });
  assert.equal(files.get("packages/ardiacore/ios/DemoModule.swift").includes('"watch": EngineCall.passing("ac_demo_watch"),'), true);
  assert.equal(files.get("packages/ardiacore/ios/DemoModule.swift").includes("Events("), false);
  assert.equal(files.has("packages/ardiacore/ios/MixedModule.swift"), false);
  assert.equal(JSON.parse(files.get(MANIFEST)).domains.mixed.swift, null);
});
