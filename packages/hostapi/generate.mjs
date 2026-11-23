#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: generate.mjs [--check|--write]
Reads the host API schema in packages/hostapi/schema and writes, or checks, what it generates:
each domain's TypeScript call and event types and the manifest in packages/ardiacore/src/engine/generated,
and the Swift module of every domain the Mac serves straight from the engine.`;

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const GENERATED_TS = "packages/ardiacore/src/engine/generated/";
export const MANIFEST = `${GENERATED_TS}manifest.json`;
export const SWIFT = "packages/ardiacore/ios/";
export const HOSTS = ["mac", "desktop", "windows"];
const BINDINGS = { mac: new Set(["service", "custom", "absent"]), desktop: new Set(["route", "custom", "absent"]), windows: new Set(["service", "custom", "absent"]) };
const NAME = /^[a-z][a-zA-Z]*$/;
const SERVICE = /^ac_[a-z][a-z_]*$/;
const TYPE_NAME = /^[A-Z][A-Za-z0-9]*$/;

const capitalized = (name) => name[0].toUpperCase() + name.slice(1);
const sortedKeys = (record) => Object.keys(record).sort();

export async function loadDomains() {
  const { domains } = await import(new URL("./schema/index.ts", import.meta.url).href);
  for (const [name, domain] of Object.entries(domains)) validate(name, domain);
  return domains;
}

export function validate(name, domain) {
  const fail = (message) => {
    throw new Error(`schema ${name}: ${message}`);
  };
  if (!NAME.test(name)) fail("the domain's name is lowerCamelCase letters");
  if (domain.kind !== "engine") fail("kind is engine: JSON calls to ac_* services; positional module domains have no generator yet");
  for (const [path, names] of Object.entries(domain.imports ?? {})) {
    if (!path.startsWith(".")) fail(`import ${path} is relative to the generated folder`);
    for (const type of names) if (!TYPE_NAME.test(type)) fail(`import ${type} from ${path} is a type name`);
  }
  for (const [verb, call] of Object.entries(domain.calls ?? {})) {
    if (!NAME.test(verb)) fail(`call ${verb} is lowerCamelCase letters`);
    if (typeof call.args !== "string" || !call.args.trim()) fail(`${verb} names its args type`);
    if (typeof call.result !== "string" || !call.result.trim()) fail(`${verb} names its result type`);
    if (!SERVICE.test(call.service ?? "")) fail(`${verb}'s service is an ac_* call`);
    if (call.desktop === undefined) fail(`${verb} says whether the desktop host routes it: desktop is route, custom or absent, never implied`);
    for (const host of HOSTS) if (call[host] !== undefined && !BINDINGS[host].has(call[host])) fail(`${verb}.${host} is one of ${[...BINDINGS[host]].join(", ")}`);
  }
  for (const [event, type] of Object.entries(domain.events ?? {})) {
    if (!NAME.test(event)) fail(`event ${event} is lowerCamelCase letters`);
    if (typeof type !== "string" || !type.trim()) fail(`event ${event} names its payload type`);
  }
}

export const bindingOf = (call, host) => call[host] ?? "service";

function typescript(name, domain) {
  const lines = [];
  for (const path of sortedKeys(domain.imports ?? {})) {
    lines.push(`import type { ${[...domain.imports[path]].sort().join(", ")} } from "${path}";`);
  }
  if (lines.length) lines.push("");
  const block = (typeName, rows) => {
    if (!rows.length) return [`export type ${typeName} = {};`];
    return [`export type ${typeName} = {`, ...rows.map((row) => `  ${row}`), "};"];
  };
  const calls = Object.entries(domain.calls ?? {}).map(([verb, call]) => `"${name}.${verb}": [${call.args}, ${call.result}];`);
  const events = Object.entries(domain.events ?? {}).map(([event, type]) => `"${name}.${event}": ${type};`);
  lines.push(...block(`${capitalized(name)}Calls`, calls), "", ...block(`${capitalized(name)}Events`, events));
  return `${lines.join("\n")}\n`;
}

const servedByEngine = (domain) => Object.values(domain.calls ?? {}).every((call) => bindingOf(call, "mac") === "service");

function swiftModule(name, domain) {
  const hasEvents = Object.keys(domain.events ?? {}).length > 0;
  const lines = [
    "import ExpoModulesCore",
    "",
    `public class ${capitalized(name)}Module: Module {`,
    "  public func definition() -> ModuleDefinition {",
    "    Name(Self.calls.moduleName)",
    ...(hasEvents ? ["    Events(Self.calls.domain)", "    Self.calls.forwardEvents(to: self)"] : []),
    "",
    "    Self.calls.function",
    "  }",
    "",
    `  static let calls = CallTable(domain: "${name}", handlers: [`,
    ...Object.entries(domain.calls ?? {}).map(([verb, call]) => `    "${verb}": EngineCall.passing("${call.service}"),`),
    "  ])",
    "}",
  ];
  return `${lines.join("\n")}\n`;
}

function manifest(domains) {
  const out = { domains: {} };
  for (const name of Object.keys(domains)) {
    const domain = domains[name];
    const calls = {};
    for (const [verb, call] of Object.entries(domain.calls ?? {})) {
      calls[verb] = { service: call.service, ...Object.fromEntries(HOSTS.map((host) => [host, bindingOf(call, host)])) };
    }
    out.domains[name] = {
      kind: domain.kind,
      types: `${GENERATED_TS}${name}.ts`,
      swift: servedByEngine(domain) ? `${SWIFT}${capitalized(name)}Module.swift` : null,
      calls,
      events: Object.keys(domain.events ?? {}),
    };
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function outputs(domains) {
  const files = new Map();
  for (const name of Object.keys(domains)) {
    const domain = domains[name];
    files.set(`${GENERATED_TS}${name}.ts`, typescript(name, domain));
    if (servedByEngine(domain)) files.set(`${SWIFT}${capitalized(name)}Module.swift`, swiftModule(name, domain));
  }
  files.set(MANIFEST, manifest(domains));
  return files;
}

const retired = (files) => (existsSync(ROOT + GENERATED_TS) ? readdirSync(ROOT + GENERATED_TS).map((file) => GENERATED_TS + file).filter((path) => !files.has(path)) : []);

export function stale(files) {
  const problems = [];
  for (const [path, text] of files) {
    const at = ROOT + path;
    if (!existsSync(at)) problems.push(`missing ${path}`);
    else if (readFileSync(at, "utf8") !== text) problems.push(`out of date ${path}`);
  }
  for (const path of retired(files)) problems.push(`not generated by the schema ${path}`);
  return problems;
}

async function main(argv) {
  const mode = argv[0];
  if (argv.length !== 1 || (mode !== "--check" && mode !== "--write")) {
    console.error(USAGE);
    process.exit(2);
  }
  const files = outputs(await loadDomains());
  if (mode === "--write") {
    for (const path of retired(files)) rmSync(ROOT + path, { recursive: true });
    for (const [path, text] of files) {
      mkdirSync(dirname(ROOT + path), { recursive: true });
      writeFileSync(ROOT + path, text);
    }
    console.log(`wrote ${[...files.keys()].map((path) => relative(ROOT, ROOT + path)).join(", ")}`);
    return;
  }
  const problems = stale(files);
  if (problems.length) {
    console.error(`${problems.join("\n")}\nrun: node packages/hostapi/generate.mjs --write`);
    process.exit(1);
  }
  console.log(`up to date: ${files.size} files`);
}

const runAsScript = import.meta.main ?? (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)));
if (runAsScript) await main(process.argv.slice(2));
