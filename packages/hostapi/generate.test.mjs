import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDomains, MANIFEST, outputs, ROOT, validate } from "./generate.mjs";

const GENERATOR = fileURLToPath(new URL("./generate.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [GENERATOR, ...args], { encoding: "utf8" });
const call = (overrides = {}) => ({ args: "Profile", result: "Done", service: "ac_demo_watch", desktop: "route", ...overrides });
const domain = (calls) => ({ imports: {}, calls, events: {} });

test("every generated file matches the schema byte for byte", () => {
  const result = run("--check");
  assert.equal(result.status, 0, result.stderr);
});

test("the generator takes exactly one mode", () => {
  assert.equal(run().status, 2);
  assert.equal(run("--check", "--write").status, 2);
  assert.equal(run("--force").status, 2);
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
  assert.throws(() => validate("demo", { imports: { "@ardia/core": ["Thing"] }, calls: {}, events: {} }), /relative/);
});

test("a domain the Mac serves straight from the engine gets its whole Swift module, and a mixed one gets none yet", () => {
  const files = outputs({ demo: domain({ watch: call() }), mixed: domain({ watch: call(), open: call({ mac: "custom", service: "ac_mixed_open" }) }) });
  assert.equal(files.get("packages/ardiacore/ios/DemoModule.swift").includes('"watch": EngineCall.passing("ac_demo_watch"),'), true);
  assert.equal(files.get("packages/ardiacore/ios/DemoModule.swift").includes("Events("), false);
  assert.equal(files.has("packages/ardiacore/ios/MixedModule.swift"), false);
  assert.equal(JSON.parse(files.get(MANIFEST)).domains.mixed.swift, null);
});
