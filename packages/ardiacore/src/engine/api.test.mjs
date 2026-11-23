import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const src = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const ios = new URL("../../ios/", import.meta.url);
const nativeFiles = readdirSync(ios).filter((f) => /\.(swift|mm)$/.test(f));
const native = (file) => readFileSync(new URL(file, ios), "utf8");

const api = src("./api.ts");
const manifest = JSON.parse(src("./generated/manifest.json"));
const capitalized = (name) => name[0].toUpperCase() + name.slice(1);
const typeHead = (name) => api.match(new RegExp(`^export type ${name} = ((?:\\w+ & )*)\\{$`, "m"));
const typeBody = (name) => {
  const head = typeHead(name);
  assert.ok(head, `${name} is in api.ts`);
  return api.slice(head.index, api.indexOf("\n};", head.index));
};
const keysOf = (body) => new Set([...body.matchAll(/^ {2}"([a-zA-Z]+\.[a-zA-Z]+)":/gm)].map((m) => m[1]));
const generated = (kind) =>
  Object.entries(manifest.domains).flatMap(([domain, entry]) => (kind === "calls" ? Object.keys(entry.calls) : entry.events).map((verb) => `${domain}.${verb}`));
const declared = (name, kind) => new Set([...keysOf(typeBody(name)), ...generated(kind)]);
const sorted = (set) => [...set].sort();

test("api.ts takes each generated domain's calls and events from packages/hostapi and restates none of them", () => {
  for (const domain of Object.keys(manifest.domains)) {
    const name = capitalized(domain);
    assert.match(api, new RegExp(`^import type \\{ ${name}Calls, ${name}Events \\} from "\\./generated/${domain}";$`, "m"));
    assert.ok(typeHead("EngineCalls")[1].split(" & ").includes(`${name}Calls`), `EngineCalls composes ${name}Calls`);
    assert.ok(typeHead("EngineEvents")[1].split(" & ").includes(`${name}Events`), `EngineEvents composes ${name}Events`);
    for (const key of [...keysOf(typeBody("EngineCalls")), ...keysOf(typeBody("EngineEvents"))]) {
      assert.ok(!key.startsWith(`${domain}.`), `${key} comes from the schema, not a hand row`);
    }
  }
});

test("every call in api.ts has a handler in its domain's Swift call table, and nothing else does", () => {
  const swift = new Set();
  for (const file of nativeFiles.filter((f) => f.endsWith("Module.swift"))) {
    const text = native(file);
    const domain = text.match(/CallTable\(domain: "([a-zA-Z]+)"/)?.[1];
    if (!domain) continue;
    for (const [, verb] of text.matchAll(/^ {4}"([a-zA-Z]+)": /gm)) swift.add(`${domain}.${verb}`);
  }
  assert.deepEqual(sorted(swift), sorted(declared("EngineCalls", "calls")));
});

test("Preload pages loads its profile first, so a profile that isn't open yet is read and written, not skipped", () => {
  const services = native("ArdiaServices.mm");
  const sites = native("SitesModule.swift");
  const methodBody = (signature) => {
    const start = services.indexOf(signature);
    assert.ok(start >= 0, `ArdiaServices.mm defines ${signature}`);
    return services.slice(start, services.indexOf("\n}\n", start));
  };
  assert.doesNotMatch(native("ArdiaServices.h"), /ArdiaProfileTogglePreloadPages/, "the toggles read LoadedProfile, which is nil for a profile that isn't open");
  for (const signature of ["+ (void)preloadPages:", "+ (void)setPreloadPages:"]) {
    const body = methodBody(signature);
    assert.match(body, /ardia_host::WithProfile\(/, `${signature} loads the profile before using it`);
    assert.match(body, /reply\(nil, @"/, `${signature} answers an error when the profile can't be loaded`);
  }
  assert.match(sites, /"preloadPages": \{ args, reply in\s*ArdiaServices\.preloadPages\(profile: args\.profile\) \{ reply\.service\(\$0, \$1\) \}/);
  assert.match(sites, /"setPreloadPages": \{ args, reply in\s*ArdiaServices\.setPreloadPages\(try args\.bool\("on"\), profile: args\.profile\) \{ reply\.service\(\$0, \$1\) \}/);
});

test("every event in api.ts is emitted natively under that name, and nothing else is", () => {
  const emitted = new Set();
  for (const file of nativeFiles) {
    for (const [, swift, objc] of native(file).matchAll(/ArdiaEvents\.emit\("([^"]+)"|ArdiaEvents emit:@"([^"]+)"/g)) emitted.add(swift ?? objc);
  }
  const bridge = native("ArdiaEngineBridge.mm");
  const between = (from, to) => bridge.slice(bridge.indexOf(from), bridge.indexOf(to, bridge.indexOf(from)));
  const renamed = new Map([...between("NSString *AppEventOfTopic(", "\n}").matchAll(/isEqualToString:@"([^"]+)"\] \? @"([^"]+)"/g)].map((m) => [m[1], m[2]]));
  for (const [, topic] of between("ForwardedTopics()", "];").matchAll(/@"([^"]+)"/g)) emitted.add(renamed.get(topic) ?? topic);
  assert.deepEqual(sorted(emitted), sorted(declared("EngineEvents", "events")));
});
