import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { MANIFEST, ROOT } from "./generate.mjs";

const read = (path) => readFileSync(ROOT + path, "utf8");
const manifest = JSON.parse(read(MANIFEST));
const domains = Object.entries(manifest.domains);
const LINUX_ONLY_EVENTS = ["downloads.removed", "history.imported"];
const NO_WINDOWS_MODULE = ["webKit"];

export function stripComments(written) {
  const source = written.replace(/\\[ \t]*\r?\n/g, "");
  let out = "";
  for (let at = 0; at < source.length; ) {
    const two = source.slice(at, at + 2);
    if (two === "//") {
      const end = source.indexOf("\n", at);
      at = end < 0 ? source.length : end;
    } else if (two === "/*") {
      const end = source.indexOf("*/", at + 2);
      if (end < 0) throw new Error("a block comment never closes");
      out += " ";
      at = end + 2;
    } else if (source[at] === '"' || source[at] === "'") {
      const quote = source[at];
      let end = at + 1;
      while (end < source.length && source[end] !== quote) end += source[end] === "\\" ? 2 : 1;
      out += source.slice(at, end + 1);
      at = end + 1;
    } else {
      out += source[at++];
    }
  }
  return out;
}

const between = (text, from, to) => {
  const start = text.indexOf(from);
  if (start < 0 || text.indexOf(from, start + 1) >= 0) throw new Error(`the source declares ${from} exactly once`);
  return text.slice(start, text.indexOf(to, start));
};

export function linuxEventNames(header) {
  const body = between(stripComments(header), "EventName(std::string_view topic)", "\n}");
  const opening = /for\s*\(\s*const\s+auto\s+name\s*:\s*\{/g;
  const open = opening.exec(body);
  if (!open || opening.exec(body)) throw new Error("EventName loops over exactly one braced list of topics");
  const entry = /\s*"([^"\\\n]*)"\s*/y;
  const separator = /,?\s*\}\s*\)|,/y;
  const names = [];
  let at = open.index + open[0].length;
  for (;;) {
    entry.lastIndex = at;
    const name = entry.exec(body);
    if (!name) throw new Error(`EventName's topic list has an entry the scan can't read: ${JSON.stringify(body.slice(at, at + 80))}`);
    if (names.includes(name[1])) throw new Error(`EventName lists ${name[1]} twice`);
    names.push(name[1]);
    separator.lastIndex = entry.lastIndex;
    const next = separator.exec(body);
    if (!next) throw new Error(`EventName's topic list has an entry the scan can't read: ${JSON.stringify(body.slice(entry.lastIndex, entry.lastIndex + 80))}`);
    at = separator.lastIndex;
    if (next[0] !== ",") return new Set(names);
  }
}

export function macForwarding(bridgeSource) {
  const source = stripComments(bridgeSource);
  const topics = [...between(source, "*ForwardedTopics() {", "];").matchAll(/@"([^"]+)"/g)].map((match) => match[1]);
  const renamed = new Map([...between(source, "NSString *AppEventOfTopic(", "\n}").matchAll(/isEqualToString:@"([^"]+)"\] \? @"([^"]+)"/g)].map((match) => [match[1], match[2]]));
  return { topics, renamed };
}

const linuxContract = stripComments(read("engine/ardiacore-linux/src/ardia/linux/ac_linux_contract.h"));
export function parseRoutes(header) {
  const opening = /\bkRoutes\[\]\s*=\s*\{/g;
  const open = opening.exec(header);
  if (!open || opening.exec(header)) throw new Error("the header declares kRoutes exactly once");
  const row = /\s*\{\s*"([^"\\]*)"\s*,\s*"([^"\\]*)"\s*,\s*"([^"\\]*)"\s*\}\s*,?/y;
  const routes = [];
  let at = open.index + open[0].length;
  for (row.lastIndex = at; ; row.lastIndex = at) {
    const match = row.exec(header);
    if (!match) break;
    const [, name, service, field] = match;
    if (routes.some((route) => route.name === name)) throw new Error(`kRoutes routes ${name} twice; FindRoute would take the first`);
    routes.push({ name, service, field });
    at = row.lastIndex;
  }
  const close = /\s*\}\s*;/y;
  close.lastIndex = at;
  if (!close.test(header)) throw new Error(`kRoutes has a row the scan can't read: ${JSON.stringify(header.slice(at, at + 80))}`);
  return routes;
}

const linuxRoutes = parseRoutes(linuxContract);

const LINUX = "engine/ardiacore-linux/src/ardia/linux/";
const CUSTOM_ONLY_DOMAINS = ["autofill", "contentBlocker", "passwords", "profiles", "webKit", "webView", "windows"];

export function namesIn(source, list) {
  const opening = new RegExp(`\\b${list}\\[\\]\\s*=\\s*\\{`, "g");
  const open = opening.exec(source);
  if (!open || opening.exec(source)) throw new Error(`the source declares ${list} exactly once`);
  const close = source.indexOf("}", open.index + open[0].length);
  const body = source.slice(open.index + open[0].length, close);
  const names = [...body.matchAll(/"([^"\\\n]*)"/g)].map((match) => match[1]);
  if (body.replace(/"[^"\\\n]*"/g, "").replace(/[\s,]/g, "")) throw new Error(`${list} has an entry the scan can't read: ${JSON.stringify(body.trim().slice(0, 80))}`);
  return names;
}

export function constantIn(source, name) {
  const found = [...source.matchAll(new RegExp(`\\b${name}\\[\\]\\s*=\\s*"([^"\\\\]*)"\\s*;`, "g"))];
  if (found.length !== 1) throw new Error(`the source declares ${name} exactly once`);
  return found[0][1];
}

export function linuxServed(read) {
  const native = (file) => stripComments(read(LINUX + file));
  const siteControls = native("ac_linux_site_controls.cc");
  const notAdvertised = new Set([...between(siteControls, "Capabilities() {", "\n}").matchAll(/name != "([^"]+)"/g)].map((match) => match[1]));
  const credentials = native("ac_linux_credentials.cc");
  const typedMethods = new Set(namesIn(native("ac_linux_credentials.h"), "kCapabilities"));
  const typedMethodOf = (name) => `Ardia${name[0].toUpperCase()}${name.slice(1)}`;
  const dispatched = [...native("ac_linux_host.cc").matchAll(/\bname == "([a-zA-Z]+\.[a-zA-Z]+)"/g)].map((match) => match[1]);
  return new Set([
    ...[...namesIn(siteControls, "kServiceCalls"), ...namesIn(siteControls, "kBlockerCalls")].filter((name) => !notAdvertised.has(name)),
    ...namesIn(credentials, "kManagedNames"),
    ...namesIn(credentials, "kSecretNames").filter((name) => typedMethods.has(typedMethodOf(name))),
    ...namesIn(native("ac_linux_cast_core.h"), "kCastCapabilities"),
    ...namesIn(native("ac_linux_capture.h"), "kCaptureCapabilities"),
    ...namesIn(native("ac_linux_page_messages.h"), "kLinuxPageMessageRoutes"),
    ...namesIn(native("ac_linux_link_tabs.h"), "kLinuxLinkTabRoutes"),
    constantIn(native("ac_linux_idle_profiles.h"), "kLinuxUnloadIdleProfileCall"),
    ...dispatched,
  ]);
}

const linuxEvents = linuxEventNames(linuxContract);
const windows = JSON.parse(read("packages/expo-windows/src/engine/domains/forwarded.json"));
const { topics: macTopics, renamed: macRenamed } = macForwarding(read("packages/ardiacore/ios/ArdiaEngineBridge.mm"));
const generatedEvent = (name) => domains.some(([domain]) => name.startsWith(`${domain}.`));
const eventsOf = (host, binding) => domains.flatMap(([domain, entry]) => Object.entries(entry.events).filter(([, event]) => event[host] === binding).map(([event, row]) => ({ name: `${domain}.${event}`, topic: row.topic })));

test("the scans find the hosts' tables", () => {
  assert.ok(domains.length > 0);
  assert.ok(linuxRoutes.length > 30);
  assert.ok(linuxEvents.size > 3);
  assert.ok(Object.keys(windows.forwarded).length > 5);
  assert.ok(macTopics.length > 3);
  assert.ok(macRenamed.size > 0);
});

test("the kRoutes scan reads rows however they're wrapped and refuses what it can't read or a name routed twice", () => {
  const header = (rows) => `inline constexpr Route kRoutes[] = {\n${rows}\n};\n\ninline const Route* FindRoute(std::string_view name) {}\n`;
  assert.deepEqual(parseRoutes(header('    {\n"history.query",\n "ac_history_query", ""},\n    {"downloads.pause", "ac_downloads_command", "null"}')), [
    { name: "history.query", service: "ac_history_query", field: "" },
    { name: "downloads.pause", service: "ac_downloads_command", field: "null" },
  ]);
  assert.throws(() => parseRoutes(header('    {\n"history.query", "ac_evil", ""},\n    {"history.query", "ac_history_query", ""},')), /twice/);
  assert.throws(() => parseRoutes(header('    {"history.query", "ac_history_query", ""},\n    {kName, "ac_history_add", ""},')), /can't read/);
  assert.throws(() => parseRoutes(header('    {"history.query", "ac_history_query"},')), /can't read/);
  assert.throws(() => parseRoutes("struct Route {};"), /exactly once/);
});

test("the Linux WebUI allowlist routes exactly each generated domain's desktop-routed calls, to the same service", () => {
  for (const [domain, entry] of domains) {
    const routed = linuxRoutes.filter((route) => route.name.startsWith(`${domain}.`)).sort((a, b) => a.name.localeCompare(b.name));
    const schema = Object.entries(entry.calls)
      .filter(([, call]) => call.desktop === "route")
      .map(([verb, call]) => ({ name: `${domain}.${verb}`, service: call.service, field: call.routeField ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(routed, schema, `kRoutes' ${domain} rows`);
  }
});

test("comments never count as table entries: a commented-out row is read as gone", () => {
  assert.equal(stripComments('a // "x.y"\nb /* @"z" */ c "/* kept */" \'/\''), 'a \nb   c "/* kept */" \'/\'');
  assert.throws(() => stripComments("a /* open"), /never closes/);
  const header = 'inline std::string_view EventName(std::string_view topic) {\n  for (const auto name : {"history.changed", /* "bookmarks.changed", */ "downloads.changed"}) {\n  // "extensions.sync"\n  }\n}\n';
  assert.deepEqual([...linuxEventNames(header)], ["history.changed", "downloads.changed"]);
  assert.equal(stripComments('a // b \\\nc\nd'), "a \nd");
  assert.equal(stripComments('a // b \\\r\nc\r\nd'), "a \nd");
  assert.equal(stripComments('a // b \\ \t\nc\nd'), "a \nd");
  assert.equal(stripComments('a // b \\\t \r\nc\r\nd'), "a \nd");
  const contract = read("engine/ardiacore-linux/src/ardia/linux/ac_linux_contract.h");
  const loop = '  for (const auto name : {"history.changed",';
  assert.ok(contract.includes(loop));
  assert.throws(() => linuxEventNames(contract.replace(loop, `  // topics \\\n${loop}`)), /exactly one braced list/);
  assert.throws(() => linuxEventNames(contract.replace(loop, `  // topics \\ \t\n${loop}`)), /exactly one braced list/);
});

test("the EventName scan reads every topic however it's spelled and refuses what it can't read", () => {
  const header = (list) => `inline std::string_view EventName(std::string_view topic) {\n  for (const auto name : {${list}}) {\n    if (topic == name) return name;\n  }\n  return {};\n}\n`;
  assert.deepEqual([...linuxEventNames(header('"history.changed",\n   "downloads.test-extra", "a.b_c:d",'))], ["history.changed", "downloads.test-extra", "a.b_c:d"]);
  assert.deepEqual([...linuxEventNames(header('"history.changed"'))], ["history.changed"]);
  assert.throws(() => linuxEventNames(header('"history.changed", kExtraTopic')), /can't read/);
  assert.throws(() => linuxEventNames(header('"history.changed" "downloads.changed"')), /can't read/);
  assert.throws(() => linuxEventNames(header('"history.changed", "history.changed"')), /twice/);
  assert.throws(() => linuxEventNames(header('"history.\\"changed"')), /can't read/);
  const contract = read("engine/ardiacore-linux/src/ardia/linux/ac_linux_contract.h");
  const extra = contract.replace('"downloads.removed"}', '"downloads.removed", "downloads.test-extra"}');
  assert.notEqual(extra, contract);
  assert.ok(linuxEventNames(extra).has("downloads.test-extra"));
  const bridgeSource = read("packages/ardiacore/ios/ArdiaEngineBridge.mm");
  const commented = bridgeSource.replace('@"extensions.action", ', '/* @"extensions.action", */ ');
  assert.notEqual(commented, bridgeSource);
  assert.ok(macForwarding(bridgeSource).topics.includes("extensions.action"));
  assert.ok(!macForwarding(commented).topics.includes("extensions.action"));
  assert.ok(!macForwarding(bridgeSource.replace('@"extensions.action", ', '\n// @"extensions.action",\n')).topics.includes("extensions.action"));
});

test("the custom-only domains are exactly the ones no host passes any call of straight to the engine", () => {
  const engineFree = domains.filter(([, entry]) => Object.values(entry.calls).every((call) => call.service === undefined)).map(([domain]) => domain);
  assert.deepEqual(engineFree.sort(), CUSTOM_ONLY_DOMAINS);
});

test("the Linux host serves exactly a custom-only domain's desktop custom calls: each is in a native dispatch list it advertises or a branch of its own, and nothing it refuses is custom", () => {
  const served = linuxServed(read);
  assert.ok(served.has("contentBlocker.state") && served.has("passwords.unlock") && served.has("profiles.unloadIdle"));
  assert.ok(!served.has("contentBlocker.devDelayNextLoad"), "Linux refuses contentBlocker.devDelayNextLoad as unavailable");
  for (const domain of CUSTOM_ONLY_DOMAINS) {
    const entry = manifest.domains[domain];
    const custom = Object.entries(entry.calls).filter(([, call]) => call.desktop === "custom").map(([verb]) => `${domain}.${verb}`).sort();
    const nativelyServed = Object.keys(entry.calls).map((verb) => `${domain}.${verb}`).filter((name) => served.has(name)).sort();
    assert.deepEqual(custom, nativelyServed, `${domain}'s desktop custom calls`);
    for (const [verb, call] of Object.entries(entry.calls)) assert.notEqual(call.desktop, "route", `${domain}.${verb} has no engine service to route to`);
  }
});

test("the Linux dispatch scans read every list however it's spelled and refuse what they can't read", () => {
  assert.deepEqual(namesIn('constexpr std::string_view kNames[] = {\n  "a.b", "c.d",\n};', "kNames"), ["a.b", "c.d"]);
  assert.throws(() => namesIn('constexpr std::string_view kNames[] = {"a.b", kOther};', "kNames"), /can't read/);
  assert.throws(() => namesIn('kNames[] = {"a.b"}; kNames[] = {"c.d"};', "kNames"), /exactly once/);
  assert.equal(constantIn('inline constexpr char kCall[] = "profiles.unloadIdle";', "kCall"), "profiles.unloadIdle");
  assert.throws(() => constantIn("inline constexpr char kCall[] = kOther;", "kCall"), /exactly once/);
  const siteControls = read(`${LINUX}ac_linux_site_controls.cc`);
  const exclusion = 'if (name != "contentBlocker.devDelayNextLoad") names.push_back(name);';
  assert.ok(siteControls.includes(exclusion));
  const advertisedAll = (path) => (path.endsWith("ac_linux_site_controls.cc") ? siteControls.replace(exclusion, "names.push_back(name);") : read(path));
  assert.ok(linuxServed(advertisedAll).has("contentBlocker.devDelayNextLoad"));
  const commented = (path) => (path.endsWith("ac_linux_host.cc") ? read(path).replace('if (name == "profiles.loaded") {', 'if (false /* name == "profiles.loaded" */) {') : read(path));
  assert.ok(!linuxServed(commented).has("profiles.loaded"));
});

test("the Linux host forwards exactly the desktop-forwarded events and its own Linux-only topics, nothing undeclared", () => {
  const forwarded = eventsOf("desktop", "forward");
  for (const { name, topic } of forwarded) assert.equal(topic, name, `${name} reaches Linux under its own topic`);
  for (const name of LINUX_ONLY_EVENTS) {
    const [domain, event] = name.split(".");
    assert.equal(manifest.domains[domain]?.events[event], undefined, `${name} is Linux-only, so it isn't in the schema`);
  }
  assert.deepEqual([...linuxEvents].sort(), [...forwarded.map(({ name }) => name), ...LINUX_ONLY_EVENTS].sort(), "EventName's topics");
});

test("each host forwards an engine topic as one event only", () => {
  for (const host of ["mac", "desktop", "windows"]) {
    const topics = eventsOf(host, "forward").map(({ topic }) => topic);
    assert.deepEqual(topics.filter((topic, index) => topics.indexOf(topic) !== index), [], `${host} forwards a topic twice`);
  }
});

test("the Mac forwards exactly each generated domain's Mac-forwarded engine topics, under the event's name", () => {
  const forwarded = eventsOf("mac", "forward");
  const generatedTopics = macTopics.filter((topic) => generatedEvent(macRenamed.get(topic) ?? topic));
  assert.deepEqual([...generatedTopics].sort(), forwarded.map(({ topic }) => topic).sort());
  for (const { name, topic } of forwarded) assert.equal(macRenamed.get(topic) ?? topic, name, `the Mac emits topic ${topic} as ${name}`);
});

test("a domain Windows has no module for is absent there call by call and event by event, and forwarded.json never names it", () => {
  for (const domain of NO_WINDOWS_MODULE) {
    const entry = manifest.domains[domain];
    assert.ok(entry, `${domain} is a generated domain`);
    assert.deepEqual(Object.entries(entry.calls).filter(([, call]) => call.windows !== "absent").map(([verb]) => verb), [], `${domain}'s calls Windows serves`);
    assert.deepEqual(Object.entries(entry.events).filter(([, event]) => event.windows !== "absent").map(([event]) => event), [], `${domain}'s events Windows sends`);
    assert.equal(Object.hasOwn(windows.forwarded, domain), false, `forwarded.json forwards ${domain}`);
    assert.equal(Object.hasOwn(windows.missing, domain), false, `forwarded.json lists ${domain} as missing, which gives it a module`);
  }
});

test("Windows forwards exactly each generated domain's service-backed calls to the same engine call, and its forwarded events from their engine topics", () => {
  for (const [domain, entry] of domains.filter(([domain]) => !NO_WINDOWS_MODULE.includes(domain))) {
    const forwarded = Object.fromEntries(Object.entries(entry.calls).filter(([, call]) => call.windows === "service").map(([verb, call]) => [verb, call.service]));
    assert.deepEqual(windows.forwarded[domain] ?? {}, forwarded, `forwarded.json's ${domain} rows`);
    const absent = Object.entries(entry.calls).filter(([, call]) => call.windows === "absent").map(([verb]) => verb).sort();
    assert.deepEqual([...(windows.missing[domain] ?? [])].sort(), absent, `forwarded.json's missing ${domain} verbs`);
  }
  const forwarded = Object.fromEntries(eventsOf("windows", "forward").map(({ name, topic }) => [topic, name]));
  const generatedTopics = Object.fromEntries(Object.entries(windows.topics).filter(([, name]) => generatedEvent(name)));
  assert.deepEqual(generatedTopics, forwarded, "forwarded.json's topics for generated domains");
});

test("the Mac's call table for each domain is the generated one: each service-backed call passes to its service and each custom one to its module's handler", () => {
  for (const [domain, entry] of domains) {
    const swift = read(entry.swift);
    assert.match(swift, new RegExp(`CallTable\\(domain: "${domain}"`));
    for (const [verb, call] of Object.entries(entry.calls)) {
      const row = { service: `"${verb}": EngineCall.passing("${call.service}"),`, custom: `"${verb}": ${verb}Handler,` }[call.mac];
      if (row) assert.ok(swift.includes(row), `${domain}.${verb}`);
      else assert.ok(!swift.includes(`"${verb}": `), `${domain}.${verb} is absent on the Mac`);
    }
  }
});

test("a domain the Mac serves partly or wholly by hand builds its module's table from the generated one", () => {
  const mixed = domains.filter(([, entry]) => entry.swift.endsWith("Calls.swift"));
  assert.deepEqual(mixed.map(([domain]) => domain).sort(), ["autofill", "bookmarks", "contentBlocker", "downloads", "engine", "extensions", "favicons", "passwords", "permissions", "profiles", "search", "sites", "tabs", "webKit", "webView", "windows"]);
  for (const [domain, entry] of mixed) {
    const module = read(entry.swift.replace(/Calls\.swift$/, "Module.swift"));
    assert.match(module, new RegExp(`static let calls = ${domain}CallTable\\(`), `${domain}'s module`);
    assert.doesNotMatch(module, /CallTable\(domain:/, `${domain}'s module lists no rows of its own`);
  }
});

const moduleDomains = Object.entries(manifest.modules);
const filesUnder = (dir, pattern) => readdirSync(ROOT + dir, { recursive: true }).filter((file) => pattern.test(file)).map((file) => `${dir}${file}`.replaceAll("\\", "/")).sort();
const moduleFunctions = moduleDomains.flatMap(([domain, entry]) => Object.entries(entry.modules).flatMap(([module, row]) => Object.entries(row.functions).map(([fn, binding]) => ({ domain, module, fn, binding }))));
const moduleEvents = moduleDomains.flatMap(([domain, entry]) => Object.entries(entry.modules).flatMap(([module, row]) => Object.entries(row.events).map(([event, binding]) => ({ domain, module, event, binding }))));

function skipQuoted(text, at) {
  const quote = text[at];
  let end = at + 1;
  while (end < text.length && text[end] !== quote) end += text[end] === "\\" ? 2 : 1;
  return end;
}

const REGEX_AFTER_WORD = /\b(?:return|typeof|instanceof|case|do|else|in|of|void|delete|new|throw|yield|await)\s*$/;
const CONTROL_HEAD = /\b(?:if|while|for|with)\s*$/;

export function stripJsComments(source) {
  let out = "";
  let previous = "";
  const parens = [];
  let closedControl = false;
  for (let at = 0; at < source.length; ) {
    const char = source[at];
    const two = source.slice(at, at + 2);
    if (two === "//") {
      const end = source.indexOf("\n", at);
      at = end < 0 ? source.length : end;
    } else if (two === "/*") {
      const end = source.indexOf("*/", at + 2);
      if (end < 0) throw new Error("a block comment never closes");
      out += " ";
      at = end + 2;
    } else if (char === '"' || char === "'" || char === "`") {
      const end = skipQuoted(source, at);
      out += source.slice(at, end + 1);
      previous = char;
      at = end + 1;
    } else if (char === "/" && (previous === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(previous) || REGEX_AFTER_WORD.test(out) || (previous === ")" && closedControl))) {
      let end = at + 1;
      for (let inClass = false; end < source.length && (inClass || source[end] !== "/"); end++) {
        if (source[end] === "\\") end++;
        else if (source[end] === "[") inClass = true;
        else if (source[end] === "]") inClass = false;
      }
      out += source.slice(at, end + 1);
      previous = "/";
      at = end + 1;
    } else {
      if (char === "(") parens.push(CONTROL_HEAD.test(out));
      if (char === ")") closedControl = parens.pop() ?? false;
      out += char;
      if (/\S/.test(char)) previous = char;
      at++;
    }
  }
  return out;
}

export function skipCppLiteral(text, at) {
  if (text[at] === "'" && /[0-9A-Za-z]/.test(text[at - 1] ?? "") && /[0-9A-Za-z]/.test(text[at + 1] ?? "")) return at;
  const raw = text[at] === '"' && text[at - 1] === "R" ? /^"([^()\\\s]{0,16})\(/.exec(text.slice(at)) : null;
  if (raw) {
    const end = text.indexOf(`)${raw[1]}"`, at + raw[0].length);
    if (end < 0) throw new Error("a raw string never closes");
    return end + raw[1].length + 1;
  }
  return skipQuoted(text, at);
}

export function cppLiteralStarts(text) {
  const inside = new Uint8Array(text.length);
  for (let at = 0; at < text.length; at++) {
    if (text[at] !== '"' && text[at] !== "'") continue;
    const end = skipCppLiteral(text, at);
    inside.fill(1, at, end + 1);
    at = end;
  }
  return inside;
}

export function stripCppComments(source) {
  let out = "";
  for (let at = 0; at < source.length; ) {
    const two = source.slice(at, at + 2);
    if (two === "//") {
      const end = source.indexOf("\n", at);
      at = end < 0 ? source.length : end;
    } else if (two === "/*") {
      const end = source.indexOf("*/", at + 2);
      if (end < 0) throw new Error("a block comment never closes");
      out += " ";
      at = end + 2;
    } else if (source[at] === '"' || source[at] === "'") {
      const end = skipCppLiteral(source, at);
      out += source.slice(at, end + 1);
      at = end + 1;
    } else {
      out += source[at++];
    }
  }
  return out;
}

export function closing(text, open, skip = skipQuoted) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const want = pairs[text[open]];
  if (!want) throw new Error(`a group opens with ( { or [, not ${JSON.stringify(text.slice(open, open + 20))}`);
  const stack = [];
  for (let at = open; at < text.length; at++) {
    const char = text[at];
    if (char === '"' || char === "'" || char === "`") at = skip(text, at);
    else if (pairs[char]) stack.push(pairs[char]);
    else if (char === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return at;
    }
  }
  throw new Error("a group never closes");
}

export function topLevelStatements(body) {
  const statements = [];
  let current = "";
  const flush = () => {
    const statement = current.trim();
    if (statement && statement.startsWith(".") && statements.length) statements[statements.length - 1] += statement;
    else if (statement) statements.push(statement);
    current = "";
  };
  for (let at = 0; at < body.length; at++) {
    const char = body[at];
    if (char === '"' || char === "'" || char === "`" || "({[".includes(char)) {
      const end = "({[".includes(char) ? closing(body, at) : skipQuoted(body, at);
      current += body.slice(at, end + 1);
      at = end;
    } else if (char === "\n" || char === ";") flush();
    else current += char;
  }
  flush();
  return statements;
}

export function topLevelReturnKeys(body) {
  const keys = [];
  for (let at = 0; at < body.length; at++) {
    const char = body[at];
    if (char === '"' || char === "'" || char === "`") at = skipQuoted(body, at);
    else if ("({[".includes(char)) at = closing(body, at);
    else if (/^return\b/.test(body.slice(at, at + 7)) && !/[\w$]/.test(body[at - 1] ?? "")) {
      const returned = /^return\s*\{/.exec(body.slice(at));
      if (returned) keys.push(...objectKeys(body, at + returned[0].length - 1));
    }
  }
  return keys;
}

export function block(text, open) {
  if (text[open] !== "{") throw new Error(`a block opens with {, not ${JSON.stringify(text.slice(open, open + 20))}`);
  let depth = 0;
  for (let at = open; at < text.length; at++) {
    const char = text[at];
    if (char === '"' || char === "'" || char === "`") at = skipQuoted(text, at);
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return { start: open, end: at + 1, body: text.slice(open + 1, at) };
  }
  throw new Error("a block never closes");
}

export function objectKeys(text, open) {
  const { body } = block(text, open);
  const keys = [];
  let depth = 0;
  let expectKey = true;
  for (let at = 0; at < body.length; at++) {
    const char = body[at];
    if (char === '"' || char === "'" || char === "`") {
      at = skipQuoted(body, at);
      expectKey = false;
    } else if ("({[".includes(char)) {
      depth++;
      expectKey = false;
    } else if (")}]".includes(char)) {
      depth--;
    } else if (depth === 0 && char === ",") {
      expectKey = true;
    } else if (depth === 0 && expectKey && /\S/.test(char)) {
      expectKey = false;
      const key = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*[:(,]|^(?:async\s+)?([A-Za-z_$][\w$]*)\s*$/.exec(body.slice(at));
      if (key && !body.startsWith("...", at)) keys.push(key[1] ?? key[2]);
    }
  }
  return keys;
}

export function swiftRegistrations(source, className) {
  const declared = new RegExp(`\\bclass ${className}\\b[^{]*\\{`).exec(source);
  if (!declared) throw new Error(`the source declares no class ${className}`);
  const classBody = block(source, declared.index + declared[0].length - 1).body;
  const definition = /\bfunc definition\(\)\s*->\s*ModuleDefinition\s*\{/.exec(classBody);
  if (!definition) throw new Error(`${className} has no definition()`);
  let body = block(classBody, definition.index + definition[0].length - 1).body;
  for (let view = /\bView\([^)]*\)\s*\{/.exec(body); view; view = /\bView\([^)]*\)\s*\{/.exec(body)) {
    const { end } = block(body, view.index + view[0].length - 1);
    body = body.slice(0, view.index) + body.slice(end);
  }
  const statements = topLevelStatements(body);
  const name = statements.filter((statement) => /^Name\s*\(\s*Self\.moduleName\s*\)$/.test(statement));
  const rest = statements.filter((statement) => !name.includes(statement));
  return {
    generated: rest.map((statement) => /^Self\.(\w+)Function$/.exec(statement)?.[1]).filter(Boolean),
    events: rest.includes("Self.eventsDefinition"),
    name: name.length === 1,
    handWritten: [
      ...[...rest.join("\n").matchAll(/\b(Name|Function|AsyncFunction|Events|Property|Constant|Constants)\s*\(/g)].map((match) => match[1]),
      ...name.slice(1).map(() => "Name"),
      ...rest.filter((statement) => /\bSelf\.(?:\w+Function|eventsDefinition)\b/.test(statement) && !/^Self\.(?:\w+Function|eventsDefinition)$/.test(statement)),
    ],
  };
}

export function nativeModuleCalls(source) {
  const calls = [];
  for (const match of source.matchAll(/\brequire(?:Optional)?NativeModule\b\s*/g)) {
    let at = match.index + match[0].length;
    let type;
    if (source[at] === "<") {
      let depth = 0;
      const start = at;
      for (; at < source.length; at++) {
        if (source[at] === "<") depth++;
        else if (source[at] === ">" && source[at - 1] !== "=" && --depth === 0) break;
      }
      type = source.slice(start + 1, at).trim();
      at++;
      while (/\s/.test(source[at] ?? "")) at++;
    }
    if (source[at] !== "(") continue;
    const close = closing(source, at);
    calls.push({ whole: source.slice(match.index, close + 1), type, argument: source.slice(at + 1, close).trim(), end: close + 1 });
  }
  return calls;
}

export function nativeModuleTypingProblems(source, domain, modules) {
  const map = `${domain[0].toUpperCase()}${domain.slice(1)}Modules`;
  const problems = [];
  let typed = 0;
  for (const { whole, type, argument } of nativeModuleCalls(source)) {
    const literal = /^(["'])(Ardia[A-Za-z]+)\1$/.exec(argument)?.[2];
    if (literal !== undefined) {
      if (!modules[literal]) continue;
      if (type === modules[literal].native || type === `${map}["${literal}"]`) typed++;
      else problems.push(`${whole} types ${literal} as ${type ?? "nothing"} instead of ${modules[literal].native}`);
      continue;
    }
    const index = new RegExp(`^${map}\\[(\\w+)\\]$`).exec(type ?? "")?.[1];
    if (index === undefined || !new RegExp(`<${index} extends keyof ${map}>\\s*\\(\\s*${argument.replace(/[^\w$]/g, "")}\\s*:\\s*${index}\\s*\\)`).test(source)) {
      problems.push(`${whole} takes a module name without the generated ${map} type`);
    } else typed++;
  }
  const wrappers = [...source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:<[^=]*?>\s*)?\([^)]*\)\s*(?::[^=]+)?=>\s*require(?:Optional)?NativeModule\b/g)].map((match) => match[1]);
  const ends = [
    ...nativeModuleCalls(source).map(({ whole, end }) => ({ whole, end })),
    ...wrappers.flatMap((wrapper) => [...source.matchAll(new RegExp(`\\b${wrapper}\\s*\\(`, "g"))].map((match) => {
      const end = closing(source, match.index + match[0].length - 1) + 1;
      return { whole: source.slice(match.index, end), end };
    })),
  ];
  for (const { whole, end } of ends) if (/^\s*as\s+(?:any|unknown)\b/.test(source.slice(end))) problems.push(`${whole} is cast past its generated type`);
  return { problems, typed };
}

export function linuxModuleDispatch(sources) {
  const methods = new Set();
  const events = new Set();
  for (const written of sources) {
    const text = stripCppComments(written);
    const literal = cppLiteralStarts(text);
    for (const match of text.matchAll(/\bSendEvent\(\s*"(Ardia[A-Za-z]+)"\s*,\s*"([a-zA-Z]+)"/g)) if (!literal[match.index]) events.add(`${match[1]}.${match[2]}`);
    for (const branch of text.matchAll(/\bif\s*\((?=\s*(?:method|name)\s*==)/g)) {
      if (literal[branch.index]) continue;
      const open = branch.index + branch[0].length - 1;
      const close = closing(text, open, skipCppLiteral);
      const names = text.slice(open + 1, close).split("||").map((part) => /^\s*(?:method|name)\s*==\s*"(Ardia[A-Za-z]+\.[a-z][A-Za-z]*)"\s*$/.exec(part)?.[1]);
      if (names.some((name) => name === undefined)) continue;
      let at = close + 1;
      while (/\s/.test(text[at] ?? "")) at++;
      const statement = text[at] === "{" ? text.slice(at + 1, closing(text, at, skipCppLiteral)) : text.slice(at, text.indexOf(";", at) + 1);
      if (/^\s*return\s+(?:true|false)\s*;\s*$/.test(statement)) continue;
      for (const name of names) methods.add(name);
    }
  }
  return { methods, events };
}

export function windowsNativeModules(sources) {
  const methods = new Map();
  const events = new Set();
  for (const written of sources) {
    const source = stripComments(written);
    for (const match of source.matchAll(/\bEmitEvent\([^,]+,\s*L"(Ardia[A-Za-z]+)"\s*,\s*L"([a-zA-Z]+)"/g)) events.add(`${match[1]}.${match[2]}`);
    const modules = [...source.matchAll(/REACT_MODULE\(\s*\w+\s*,\s*L"([^"]+)"\s*\)/g)].map((match) => match[1]);
    if (modules.length > 1) throw new Error(`one header registers ${modules.join(" and ")}; the scan reads one module per header`);
    if (!modules.length) continue;
    methods.set(modules[0], new Set([...source.matchAll(/REACT_(?:SYNC_)?METHOD\(\s*(\w+)\s*(?:,\s*L"([^"]+)"\s*)?\)/g)].map((match) => match[2] ?? match[1])));
  }
  return { methods, events };
}

const WINDOWS_JS = "packages/expo-windows/src/";

function resolveImport(from, path, exists) {
  const base = `${from.slice(0, from.lastIndexOf("/") + 1)}${path}`.split("/").reduce((parts, part) => (part === ".." ? parts.slice(0, -1) : part === "." ? parts : [...parts, part]), []).join("/");
  const found = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(exists);
  if (!found) throw new Error(`${from} imports ${path}, which the scan can't find`);
  return found;
}

export function windowsJsMembers(name, path, read, exists, seen = new Set()) {
  if (seen.has(`${path}:${name}`)) throw new Error(`${name} in ${path} refers back to itself`);
  seen.add(`${path}:${name}`);
  const source = stripJsComments(read(path));
  const local = new RegExp(`\\bconst ${name}\\s*(?::[^=]+)?=\\s*([A-Za-z_$][\\w$]*)\\s*\\(`).exec(source);
  if (local) return windowsJsMembers(local[1], path, read, exists, seen);
  const imported = [...source.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)].find(([, names]) => names.split(",").some((entry) => entry.trim().split(/\s+as\s+/).at(-1) === name));
  if (imported) {
    const original = imported[1].split(",").map((entry) => entry.trim().split(/\s+as\s+/)).find((parts) => parts.at(-1) === name)[0];
    return windowsJsMembers(original, resolveImport(path, imported[2], exists), read, exists, seen);
  }
  const constant = new RegExp(`\\bexport\\s+const\\s+${name}\\b[^=]*=\\s*\\{`).exec(source);
  if (constant) return new Set(objectKeys(source, constant.index + constant[0].length - 1));
  const fn = new RegExp(`\\bexport\\s+function\\s+${name}\\b`).exec(source);
  if (fn) {
    const opening = /\)\s*(?::[^{]+)?\{/g;
    opening.lastIndex = fn.index;
    const open = opening.exec(source);
    const body = block(source, open.index + open[0].length - 1);
    const returned = topLevelReturnKeys(body.body);
    if (returned.length) return new Set(returned);
  }
  throw new Error(`the scan can't read Windows' JS module ${name} in ${path}`);
}

export function windowsJsModules(read, exists) {
  const modulesPath = `${WINDOWS_JS}modules.ts`;
  const modules = stripJsComments(read(modulesPath));
  const written = between(modules, "const writtenInJs", "\n");
  const members = new Map();
  for (const [, module, value] of written.matchAll(/\b(Ardia[A-Za-z]+):\s*([A-Za-z_$][\w$]*)/g)) members.set(module, () => windowsJsMembers(value, modulesPath, read, exists));
  const defaultsSource = stripJsComments(read(`${WINDOWS_JS}defaults.ts`));
  const declared = /\bexport const moduleDefaults\b[^=]*=\s*\{/.exec(defaultsSource);
  const defaults = new Map();
  const { body } = block(defaultsSource, declared.index + declared[0].length - 1);
  for (const match of body.matchAll(/(?:^|\n)\s*(Ardia[A-Za-z]+):\s*\{/g)) defaults.set(match[1], new Set(objectKeys(body, match.index + match[0].length - 1)));
  const events = new Set();
  for (const path of filesUnder(WINDOWS_JS, /\.tsx?$/).filter((file) => !/\.test\./.test(file))) {
    for (const match of stripJsComments(read(path)).matchAll(/\bemit(?:NativeEvent|WhenListened)\(\s*"(Ardia[A-Za-z]+)"\s*,\s*"([a-zA-Z]+)"/g)) events.add(`${match[1]}.${match[2]}`);
  }
  return { members, defaults, events };
}

const exists = (path) => existsSync(ROOT + path);

test("the module-domain scans find the shaders pilot and read the hosts' real tables", () => {
  assert.ok(moduleDomains.some(([domain]) => domain === "shaders"));
  assert.ok(moduleFunctions.length >= 4);
  assert.equal(stripJsComments('const a = /^\\/*x/s; // gone\nconst b = "/* kept */"; /* gone */ return /a\\/b/;'), 'const a = /^\\/*x/s; \nconst b = "/* kept */";   return /a\\/b/;');
  assert.equal(stripJsComments("const half = width / 2; const third = 3 / 1;"), "const half = width / 2; const third = 3 / 1;");
  assert.deepEqual(objectKeys('{ a: 1, b(x) { return { c: 2 }; }, async d() {}, e, ...f, "g": 3, h: { i: 4 } }', 0), ["a", "b", "d", "e", "h"]);
  const linux = linuxModuleDispatch(filesUnder("engine/ardiacore-linux/src/", /\.(cc|h|mm)$/).map(read));
  assert.ok(linux.methods.has("ArdiaCalendar.status") && linux.methods.has("ArdiaConfig.watch"));
  assert.ok(linux.events.has("ArdiaShell.shell"));
  const windowsNative = windowsNativeModules(filesUnder("apps/browser/windows/Ardia/", /\.h$/).map(read));
  assert.ok(windowsNative.methods.get("ArdiaKeychain")?.has("delete") && windowsNative.methods.get("ArdiaFocus")?.has("keyHoldCounts"));
  const js = windowsJsModules(read, exists);
  assert.ok(js.members.get("ArdiaUpdater")().size > 0 && js.members.get("ArdiaSwipe")().size > 0 && js.members.get("ArdiaImport")().size > 0);
  assert.ok(js.defaults.get("ArdiaCli")?.has("canInstallUnattended") && js.defaults.get("ArdiaTranslate")?.has("languageName"));
  assert.ok(js.events.has("ArdiaShell.onOpenURLs") && js.events.has("ArdiaImport.onImportEvent"));
});

test("the host scans count only real dispatch entries, callable members and emitted events, so a missing method or event fails", () => {
  const linux = linuxModuleDispatch(['const char* kNote = "ArdiaDemo.hold";\nif (method == "ArdiaDemo.probe") return;\nSendEvent("ArdiaDemo", "tone", payload);\nLog("ArdiaDemo.missing");']);
  assert.deepEqual([...linux.methods], ["ArdiaDemo.probe"]);
  assert.deepEqual([...linux.events], ["ArdiaDemo.tone"]);
  assert.equal(linuxModuleDispatch(['// if (method == "ArdiaDemo.probe")']).methods.size, 0);
  const native = windowsNativeModules(['REACT_MODULE(Demo, L"ArdiaDemo")\n  REACT_METHOD(hold)\n  REACT_METHOD(remove, L"delete")\n  REACT_SYNC_METHOD(peek)\n  EmitEvent(context, L"ArdiaDemo", L"tone", payload);', 'std::wstring note = L"ArdiaDemo.missing";']);
  assert.deepEqual([...native.methods.get("ArdiaDemo")], ["hold", "delete", "peek"]);
  assert.deepEqual([...native.events], ["ArdiaDemo.tone"]);
  assert.throws(() => windowsNativeModules(['REACT_MODULE(A, L"ArdiaA") REACT_MODULE(B, L"ArdiaB")']), /one module per header/);
  const files = {
    "w/modules.ts": 'import { demoOnWindows as demo } from "./demo";\nconst made = demoMaker();\nimport { demoMaker } from "./maker";\n',
    "w/demo/index.ts": 'export const demoOnWindows = { hold: () => noteMissing("probe"), async peek() { return probe(); } };',
    "w/maker.ts": "export function demoMaker(host = null) {\n  const probe = () => 1;\n  return { open, close: () => probe() };\n}",
  };
  const readFile = (path) => files[path];
  const has = (path) => Object.hasOwn(files, path);
  assert.deepEqual([...windowsJsMembers("demo", "w/modules.ts", readFile, has)], ["hold", "peek"]);
  assert.deepEqual([...windowsJsMembers("made", "w/modules.ts", readFile, has)], ["open", "close"]);
  assert.throws(() => windowsJsMembers("nowhere", "w/modules.ts", readFile, has), /can't read/);
});

test("each Mac module of a module domain conforms to its generated protocol and registers exactly its generated name, events and functions, with no hand-written ones beside its views", () => {
  for (const [domain, entry] of moduleDomains) {
    const generated = read(entry.swift);
    const sources = filesUnder(`${entry.package}/ios/`, /\.swift$/).filter((path) => path !== entry.swift).map((path) => [path, stripComments(read(path))]);
    const listed = JSON.parse(read(`${entry.package}/expo-module.config.json`)).apple?.modules ?? [];
    for (const [module, row] of Object.entries(entry.modules)) {
      const onMac = (binding) => binding.mac === "custom";
      const functions = Object.keys(row.functions).filter((fn) => onMac(row.functions[fn]));
      const events = Object.keys(row.events).filter((event) => onMac(row.events[event]));
      const conforming = sources.flatMap(([path, text]) => [...text.matchAll(new RegExp(`\\bclass (\\w+): Module, ${row.native}\\b`, "g"))].map((match) => ({ path, text, name: match[1] })));
      for (const [path, text] of sources) assert.doesNotMatch(text, new RegExp(`Name\\("${module}"\\)`), `${path} names ${module} itself instead of Name(Self.moduleName)`);
      if (!functions.length && !events.length) {
        assert.deepEqual(conforming, [], `${module} has nothing on the Mac, so no module conforms to ${row.native}`);
        continue;
      }
      assert.match(generated, new RegExp(`protocol ${row.native}\\b`), `${entry.swift} declares ${row.native}`);
      assert.equal(conforming.length, 1, `exactly one Mac module in ${entry.package}/ios conforms to ${row.native}`);
      const [{ path, text, name }] = conforming;
      assert.ok(listed.includes(name), `${entry.package}/expo-module.config.json registers ${name}`);
      const registered = swiftRegistrations(text, name);
      assert.ok(registered.name, `${path}: ${name} takes its name from ${row.native}`);
      assert.deepEqual(registered.generated.sort(), [...functions].sort(), `${domain} ${module}'s Mac functions are exactly the generated ones`);
      assert.equal(registered.events, events.length > 0, `${path}: ${name} declares its events from ${row.native}`);
      assert.deepEqual(registered.handWritten, [], `${path}: ${name} registers functions, events, constants or a name by hand`);
    }
  }
});

test("the Mac registration scan sees a hand-written function, event or name beside the generated ones, and ignores what a view declares", () => {
  const module = (definition) => `public class DemoModule: Module, DemoNative {\n  static func hold(_ on: Bool) {}\n\n  public func definition() -> ModuleDefinition {\n${definition}\n  }\n}\n`;
  const clean = swiftRegistrations(module('    Name(Self.moduleName)\n    Self.holdFunction\n    View(DemoView.self) {\n      Prop("on") { (view: DemoView, on: Bool) in view.on = on }\n      Events("onTone")\n    }'), "DemoModule");
  assert.deepEqual(clean, { generated: ["hold"], events: false, name: true, handWritten: [] });
  assert.deepEqual(swiftRegistrations(module('    Name(Self.moduleName)\n    Self.holdFunction\n    AsyncFunction("extra") { () in }'), "DemoModule").handWritten, ["AsyncFunction"]);
  assert.deepEqual(swiftRegistrations(module('    Name(Self.moduleName)\n    Self.holdFunction\n    Function("extra") { () in 1 }'), "DemoModule").handWritten, ["Function"]);
  assert.deepEqual(swiftRegistrations(module('    Name(Self.moduleName)\n    Events("tone")\n    Self.holdFunction'), "DemoModule").handWritten, ["Events"]);
  assert.deepEqual(swiftRegistrations(module('    Name("ArdiaDemo")\n    Self.holdFunction'), "DemoModule"), { generated: ["hold"], events: false, name: false, handWritten: ["Name"] });
});

test("a module domain's package reaches each of its Expo modules only through the generated types", () => {
  for (const [domain, entry] of moduleDomains) {
    const sources = filesUnder(`${entry.package}/src/`, /\.tsx?$/).filter((path) => path !== entry.types).map((path) => [path, stripJsComments(read(path))]);
    assert.ok(sources.some(([, text]) => text.includes('from "./generated/native"')), `${entry.package}/src imports its generated types`);
    let typed = 0;
    for (const [path, text] of sources) {
      const found = nativeModuleTypingProblems(text, domain, entry.modules);
      assert.deepEqual(found.problems, [], path);
      typed += found.typed;
    }
    assert.ok(typed > 0, `${entry.package}/src reaches a module through its generated types`);
  }
});

test("the typing scan refuses a wrapper typed any, a literal typed by hand and a cast past the generated type", () => {
  const modules = { ArdiaDemo: { native: "DemoNative" } };
  const wrapper = (type) => `const nativeModule = <Name extends keyof DemoModules>(name: Name) => requireNativeModule<${type}>(name);\nconst Backdrop = nativeModule("ArdiaDemo");`;
  assert.deepEqual(nativeModuleTypingProblems(wrapper("DemoModules[Name]"), "demo", modules), { problems: [], typed: 1 });
  assert.equal(nativeModuleTypingProblems(wrapper("any"), "demo", modules).problems.length, 1);
  assert.equal(nativeModuleTypingProblems("const m = (name: string) => requireNativeModule<DemoModules[Name]>(name);", "demo", modules).problems.length, 1);
  assert.equal(nativeModuleTypingProblems('requireNativeModule<{ hold(on: boolean): Promise<void> }>("ArdiaDemo");', "demo", modules).problems.length, 1);
  assert.equal(nativeModuleTypingProblems('requireNativeModule("ArdiaDemo");', "demo", modules).problems.length, 1);
  assert.deepEqual(nativeModuleCalls('requireNativeModule<{ run(cb: () => void): Promise<Map<string, number>> }>( "ArdiaDemo" )').map(({ type, argument }) => [type, argument]), [["{ run(cb: () => void): Promise<Map<string, number>> }", '"ArdiaDemo"']]);
  assert.deepEqual(nativeModuleTypingProblems('requireNativeModule<DemoNative>("ArdiaDemo"); requireNativeModule<{}>("ArdiaElse");', "demo", modules), { problems: [], typed: 1 });
  assert.equal(nativeModuleTypingProblems(`${wrapper("DemoModules[Name]")}\nconst loose = nativeModule("ArdiaDemo") as any;`, "demo", modules).problems.length, 1);
});

test("the Linux host dispatches a module function and sends a module event exactly when its desktop binding is host", () => {
  const linux = linuxModuleDispatch(filesUnder("engine/ardiacore-linux/src/", /\.(cc|h|mm)$/).map(read));
  for (const { module, fn, binding } of moduleFunctions) assert.equal(linux.methods.has(`${module}.${fn}`), binding.desktop === "host", `${module}.${fn} is ${binding.desktop} on the desktop host`);
  for (const { module, event, binding } of moduleEvents) assert.equal(linux.events.has(`${module}.${event}`), binding.desktop === "host", `event ${module}.${event} is ${binding.desktop} on the desktop host`);
});

test("Windows serves a module function as a native method, a JS member or a default, and sends a module event, exactly when its windows binding is custom", () => {
  const native = windowsNativeModules(filesUnder("apps/browser/windows/Ardia/", /\.h$/).map(read));
  const js = windowsJsModules(read, exists);
  for (const { module, fn, binding } of moduleFunctions) {
    const served = native.methods.get(module)?.has(fn) || js.members.get(module)?.().has(fn) || js.defaults.get(module)?.has(fn) || false;
    assert.equal(served, binding.windows === "custom", `${module}.${fn} is ${binding.windows} on Windows`);
  }
  for (const { module, event, binding } of moduleEvents) {
    const sent = native.events.has(`${module}.${event}`) || js.events.has(`${module}.${event}`);
    assert.equal(sent, binding.windows === "custom", `event ${module}.${event} is ${binding.windows} on Windows`);
  }
});

test("the Linux scan counts a comparison only when it is an if that dispatches, never a boolean helper, and reads raw strings and digit separators", () => {
  const helper = [
    'bool HandlesHold(std::string_view method) { return method == "ArdiaDemo.hold"; }',
    'bool Handles(std::string_view method) {\n  if (method == "ArdiaDemo.peek") return true;\n  if (method == "ArdiaDemo.look") { return false; }\n  return false;\n}',
    'const bool held = name == "ArdiaDemo.held" ? Run() : false;',
    'if (method == "ArdiaDemo.mixed" && ready) return Run();',
  ].join("\n");
  assert.deepEqual([...linuxModuleDispatch([helper]).methods], []);
  const dispatching = [
    'constexpr int kLimit = 5\'000;',
    'const char* kPage = R"html(<a href="//x">)</a> if (method == "ArdiaDemo.inRaw") Run();)html";',
    'void Invoke(std::string_view method, Done done) {',
    '  if (method == "ArdiaDemo.probe" || name == "ArdiaDemo.peek") {',
    '    return Probe(std::move(done));',
    '  }',
    '  if (method == "ArdiaDemo.open") return Open(kLimit);',
    '}',
  ].join("\n");
  assert.deepEqual([...linuxModuleDispatch([dispatching]).methods].sort(), ["ArdiaDemo.open", "ArdiaDemo.peek", "ArdiaDemo.probe"]);
  assert.deepEqual([...linuxModuleDispatch(['const char* kHelp = "SendEvent(\\"ArdiaDemo\\", \\"tone\\")";\nSendEvent("ArdiaDemo", "real", payload);']).events], ["ArdiaDemo.real"]);
  assert.equal(stripCppComments('int a = 1\'000; // gone\nconst char* b = R"x(// kept)x"; /* gone */'), 'int a = 1\'000; \nconst char* b = R"x(// kept)x";  ');
});

test("the Windows JS scan takes a factory's own returned object, never one a nested helper returns, and reads a regex right after a control statement's condition", () => {
  const files = {
    "w/modules.ts": 'import { demoMaker } from "./maker";\n',
    "w/maker.ts": [
      "export function demoMaker() {",
      "  const helper = () => {",
      "    return { hold: () => 1 };",
      "  };",
      "  function inner() {",
      "    return { peek: 2 };",
      "  }",
      "  if (helper()) { const ready = inner(); }",
      "  return { open: () => helper() };",
      "}",
    ].join("\n"),
  };
  assert.deepEqual([...windowsJsMembers("demoMaker", "w/modules.ts", (path) => files[path], (path) => Object.hasOwn(files, path))], ["open"]);
  assert.deepEqual(topLevelReturnKeys("if (x) { return { gone: 1 }; }\nconst f = () => ({ also: 2 });\nreturn { kept: 3 };"), ["kept"]);
  const regexAfterIf = "if (enabled) /[/*]/.test(value);\nwhile (more) /a\\/b/.test(next);\nconst half = (a + b) / 2 / c;";
  assert.equal(stripJsComments(regexAfterIf), regexAfterIf);
  assert.equal(stripJsComments("for (const x of list) /x/.test(x); // gone"), "for (const x of list) /x/.test(x); ");
  assert.equal(stripJsComments("const y = typeof /x/; const z = f(a) / 2; /* gone */"), "const y = typeof /x/; const z = f(a) / 2;  ");
});

test("the Mac registration scan counts only a generated definition that stands as its own statement, and sees a hand-written registration however it's spaced", () => {
  const module = (definition) => `public class DemoModule: Module, DemoNative {\n  public func definition() -> ModuleDefinition {\n${definition}\n  }\n}\n`;
  const assigned = swiftRegistrations(module("    Name(Self.moduleName)\n    let _ = Self.holdFunction\n    Function (\"extra\") { 1 }"), "DemoModule");
  assert.deepEqual(assigned.generated, []);
  assert.deepEqual(assigned.handWritten, ["Function", "let _ = Self.holdFunction"]);
  assert.deepEqual(swiftRegistrations(module("    Name (Self.moduleName)\n    Self.holdFunction; Self.eventsDefinition\n    AsyncFunction\n      (\"late\") { () in }"), "DemoModule"), { generated: ["hold"], events: true, name: true, handWritten: ["AsyncFunction"] });
  assert.deepEqual(swiftRegistrations(module("    Name(Self.moduleName)\n    Name(Self.moduleName)\n    Self.holdFunction"), "DemoModule").handWritten, ["Name"]);
  assert.deepEqual(topLevelStatements("Name(Self.moduleName)\nAsyncFunction(\"a\") { (x: Int) in\n  x\n}\n  .runOnQueue(.main)\n"), ["Name(Self.moduleName)", 'AsyncFunction("a") { (x: Int) in\n  x\n}.runOnQueue(.main)']);
});

test("the typing scan sees a cast past the generated type after a native module call spread over several lines", () => {
  const modules = { ArdiaDemo: { native: "DemoNative" } };
  const direct = 'const Demo = requireNativeModule<DemoNative>(\n  "ArdiaDemo"\n) as unknown as { hold(): void };';
  assert.equal(nativeModuleTypingProblems(direct, "demo", modules).problems.length, 1);
  const wrapped = 'const nativeModule = <Name extends keyof DemoModules>(name: Name) => requireNativeModule<DemoModules[Name]>(name);\nconst Demo = nativeModule(\n  "ArdiaDemo"\n)\n  as any;';
  assert.equal(nativeModuleTypingProblems(wrapped, "demo", modules).problems.length, 1);
  const clean = 'const nativeModule = <Name extends keyof DemoModules>(name: Name) => requireNativeModule<DemoModules[Name]>(name);\nconst Demo = nativeModule(\n  "ArdiaDemo"\n);\nconst asText = String(Demo) as string;';
  assert.deepEqual(nativeModuleTypingProblems(clean, "demo", modules), { problems: [], typed: 1 });
});

test("the typing scan reads a module named in single quotes like one in double quotes", () => {
  const modules = { ArdiaDemo: { native: "DemoNative" } };
  assert.deepEqual(nativeModuleTypingProblems("const Demo = requireNativeModule<DemoNative>('ArdiaDemo');", "demo", modules), { problems: [], typed: 1 });
  assert.equal(nativeModuleTypingProblems("const Demo = requireNativeModule<{ hold(): void }>('ArdiaDemo');", "demo", modules).problems.length, 1);
  assert.equal(nativeModuleTypingProblems("const Demo = requireNativeModule('ArdiaDemo');", "demo", modules).problems.length, 1);
});
