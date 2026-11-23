import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MANIFEST, ROOT } from "./generate.mjs";

const read = (path) => readFileSync(ROOT + path, "utf8");
const manifest = JSON.parse(read(MANIFEST));
const domains = Object.entries(manifest.domains);
const linuxContract = read("engine/ardiacore-linux/src/ardia/linux/ac_linux_contract.h");
const routesBody = linuxContract.slice(linuxContract.indexOf("kRoutes[] = {"), linuxContract.indexOf("\n};", linuxContract.indexOf("kRoutes[] = {")));
const linuxRoutes = [...routesBody.matchAll(/\{"([\w.]+)", "(ac_\w+)", "(\w*)"\}/g)].map(([, name, service, field]) => ({ name, service, field }));
const eventNamesBody = linuxContract.slice(linuxContract.indexOf("EventName(std::string_view topic)"), linuxContract.indexOf("\n}", linuxContract.indexOf("EventName(std::string_view topic)")));
const linuxEvents = new Set([...eventNamesBody.matchAll(/"([\w.]+)"/g)].map((match) => match[1]));
const windows = JSON.parse(read("packages/expo-windows/src/engine/domains/forwarded.json"));

test("the scans find the hosts' tables", () => {
  assert.ok(domains.length > 0);
  assert.ok(linuxRoutes.length > 30);
  assert.ok(linuxEvents.size > 3);
  assert.ok(Object.keys(windows.forwarded).length > 5);
});

test("the Linux WebUI allowlist routes exactly each generated domain's desktop-routed calls, to the same service", () => {
  for (const [domain, entry] of domains) {
    const routed = linuxRoutes.filter((route) => route.name.startsWith(`${domain}.`)).sort((a, b) => a.name.localeCompare(b.name));
    const schema = Object.entries(entry.calls)
      .filter(([, call]) => call.desktop === "route")
      .map(([verb, call]) => ({ name: `${domain}.${verb}`, service: call.service, field: "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(routed, schema, `kRoutes' ${domain} rows`);
  }
});

test("the Linux host forwards every generated domain's events under the same name", () => {
  for (const [domain, entry] of domains) {
    for (const event of entry.events) assert.ok(linuxEvents.has(`${domain}.${event}`), `EventName forwards ${domain}.${event}`);
  }
});

test("Windows forwards exactly each generated domain's service-backed calls to the same engine call, and its events by name", () => {
  for (const [domain, entry] of domains) {
    const forwarded = Object.fromEntries(Object.entries(entry.calls).filter(([, call]) => call.windows === "service").map(([verb, call]) => [verb, call.service]));
    assert.deepEqual(windows.forwarded[domain] ?? {}, forwarded, `forwarded.json's ${domain} rows`);
    const absent = Object.entries(entry.calls).filter(([, call]) => call.windows === "absent").map(([verb]) => verb).sort();
    assert.deepEqual([...(windows.missing[domain] ?? [])].sort(), absent, `forwarded.json's missing ${domain} verbs`);
    for (const event of entry.events) assert.equal(windows.topics[`${domain}.${event}`], `${domain}.${event}`, `Windows forwards ${domain}.${event}`);
  }
});

test("the Mac's module for each fully engine-backed domain is the generated one", () => {
  for (const [domain, entry] of domains) {
    if (!entry.swift) continue;
    const swift = read(entry.swift);
    assert.match(swift, new RegExp(`CallTable\\(domain: "${domain}"`));
    for (const [verb, call] of Object.entries(entry.calls)) assert.ok(swift.includes(`"${verb}": EngineCall.passing("${call.service}"),`), `${domain}.${verb}`);
  }
});
