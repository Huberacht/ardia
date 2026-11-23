import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DOC = "docs/privacy.md";

const SCANNED = [
  "apps/browser/src",
  "apps/browser/macos",
  "apps/browser/windows",
  "apps/browser/official-plugins.json",
  "apps/linux/src",
  "packages/ardiacore",
  "packages/core",
  "packages/core-rs",
  "packages/expo-windows",
  "packages/hostapi",
  "packages/import",
  "packages/plugin-broker",
  "packages/plugin-sdk",
  "packages/shaders",
  "packages/shell",
  "packages/sync",
  "engine/ardiacore/src",
  "engine/ardiacore-linux/src",
  "engine/chromium/src",
  "engine/patches",
  "scripts/windows/engine/src",
  "scripts/windows/engine/patches",
];

const NOT_SHIPPED = [
  /(^|\/)(tests?|__tests__|test-native|fixtures|plugin-tests|selfCheck|probe|testdata)\//,
  /.\/scripts\//,
  /(^|\/)[^/]*Tests?\//,
  /\.(test|spec)\.[^/]+$/,
  /_test\.[^/]+$/,
  /(^|\/)engine\/patches\/build\//,
  /\.(md|lock|podspec|png|jpe?g|gif|ico|icns|webp|pak|zip|car|mp4|wasm|ttf|otf|woff2?|pdf)$/i,
  /(^|\/)(package|turbo|tsconfig[^/]*)\.json$/,
  /(^|\/)(THIRD_PARTY_NOTICES|LICENSE|NOTICE)[^/]*$/,
];

const RESERVED = /(^|\.)(example|test|invalid|localhost|local)$|^localhost$|^[\d.]+$|^0x[\da-f.]+$/i;
const URL_HOST = /\b(?:https?|wss?):\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

const read = (path) => readFileSync(join(ROOT, path), "utf8");

function shippedFiles() {
  const listed = execFileSync("git", ["-C", ROOT, "ls-files", "-z", "--", ...SCANNED], { encoding: "utf8", maxBuffer: 1 << 28 });
  return listed.split("\0").filter((path) => path && !NOT_SHIPPED.some((rule) => rule.test(path)));
}

function hostsIn(path) {
  let text = read(path);
  if (path.endsWith(".patch")) text = text.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).join("\n");
  return [...text.matchAll(URL_HOST)].map((m) => m[1].toLowerCase()).filter((host) => !RESERVED.test(host));
}

function section(doc, title) {
  const start = doc.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `${DOC} has a "## ${title}" section`);
  const end = doc.indexOf("\n## ", start + 1);
  return doc.slice(start, end < 0 ? undefined : end);
}

const ticked = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const looksLikeHost = (value) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value) && !/\.(md|ts|tsx|mjs|js|swift|mm|cc|h|py|sh|patch|json|plist|txt|ini)$/i.test(value);
const looksLikePath = (value) => /^[\w.@-]+(\/[\w.@-]+)+$/.test(value);

function tableRows(text) {
  const lines = text.split("\n").filter((line) => line.startsWith("|"));
  const header = lines[0]?.split("|").slice(1, -1).map((cell) => cell.trim()) ?? [];
  return lines.slice(2).map((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    return Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ""]));
  });
}

const doc = read(DOC);
const contacted = tableRows(section(doc, "Endpoints Ardia contacts"));
const named = section(doc, "Hosts named in the source that Ardia doesn't contact");
const disabled = tableRows(section(doc, "Google and Chromium endpoints that are off"));

test("every http(s) host hard-coded in Ardia's shipped sources is listed in docs/privacy.md", () => {
  const listed = new Set([...contacted.flatMap((row) => ticked(row.Host)), ...ticked(named)].filter(looksLikeHost).map((h) => h.toLowerCase()));
  const files = shippedFiles();
  assert.ok(files.length > 1000, "the scan still finds the app's sources");
  const missing = new Map();
  for (const path of files)
    for (const host of hostsIn(path))
      if (!listed.has(host)) missing.set(host, [...(missing.get(host) ?? []), path]);
  const report = [...missing].map(([host, paths]) => `${host} (${[...new Set(paths)].slice(0, 3).join(", ")})`);
  assert.deepEqual(report, [], `add each host to ${DOC}: a row under "Endpoints Ardia contacts" if Ardia itself contacts it, else the "doesn't contact" list`);
});

test("each endpoint row names a host and the code that contacts it", () => {
  assert.ok(contacted.length >= 10, "the endpoint table still has its rows");
  for (const row of contacted) {
    const hosts = ticked(row.Host).filter(looksLikeHost);
    const code = ticked(row.Code).filter(looksLikePath);
    assert.ok(hosts.length || /user|plugin|page/i.test(row.Host), `a row names its host: ${row.Host}`);
    assert.ok(code.length, `the ${row.Host} row cites the code that contacts it`);
    for (const path of code) assert.ok(existsSync(join(ROOT, path)), `${path}, cited for ${row.Host}, exists`);
    if (/Chromium's default/.test(row.Code)) continue;
    const text = code.map(read).join("\n").toLowerCase();
    for (const host of hosts) assert.ok(text.includes(host.toLowerCase()), `${host} is still named in ${code.join(" or ")}`);
  }
});

test("each disabled Google or Chromium endpoint still cites a patch, switch or build argument that turns it off", () => {
  assert.ok(disabled.length >= 10, "the disabled-endpoint table still has its rows");
  for (const row of disabled) {
    const paths = ticked(row["Off by"]).filter(looksLikePath);
    const proof = ticked(row.Proof);
    assert.ok(paths.length, `the ${row.Endpoint} row cites a file`);
    assert.ok(proof.length, `the ${row.Endpoint} row gives the literal that proves it`);
    for (const path of paths) assert.ok(existsSync(join(ROOT, path)), `${path}, cited for ${row.Endpoint}, exists`);
    const text = read(paths[0]);
    for (const literal of proof) assert.ok(text.includes(literal), `${paths[0]} still holds ${literal} (${row.Endpoint})`);
  }
});
