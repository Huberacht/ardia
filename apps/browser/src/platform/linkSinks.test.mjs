import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const root = new URL("../../../../", import.meta.url).pathname;
const SKIP = new Set(["node_modules", "dist", "build", "ios", "android", "macos", "windows", "Pods"]);
const SOURCE = /\.(ts|tsx)$/;

function sources(dir) {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) out.push(...sources(path));
    else if (SOURCE.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const packageSources = readdirSync(join(root, "packages")).flatMap((name) => {
  try {
    return statSync(join(root, "packages", name, "src")).isDirectory() ? sources(join("packages", name, "src")) : [];
  } catch {
    return [];
  }
});
const files = [...sources("apps/browser/src"), ...sources("apps/linux/src"), ...sources("apps/phone/src"), ...packageSources].map((path) => ({
  path: relative(root, join(root, path)),
  text: readFileSync(join(root, path), "utf8"),
}));
const FIXTURES = new Set(["apps/browser/src/platform/linkSinkTypeChecks.ts", "apps/phone/src/platform/linkSinkTypeChecks.ts"]);
const callersOf = (pattern) => files.filter((f) => !FIXTURES.has(f.path) && pattern.test(f.text)).map((f) => f.path).sort();

test("the sources scanned cover the Mac, Linux and phone UI and the shared packages", () => {
  for (const path of ["apps/browser/src/platform/clipboard.ts", "apps/phone/src/platform/system.ts", "apps/linux/src/linkShareSurface.ts", "packages/core/src/cleanUrl.ts"])
    assert.ok(files.some((f) => f.path === path), path);
});

test("only the downloads menu copies an address without cleaning it, since download links are often signed", () => {
  assert.deepEqual(callersOf(/\bcopyUncleanedUrl\(/), ["apps/browser/src/state/downloads/downloadMenu.ts"]);
});

test("a cleaned address or link text is only ever made by the cleaner", () => {
  assert.deepEqual(callersOf(/\bas (CleanedUrl|LinkText)\b|<(CleanedUrl|LinkText)>/), ["packages/core/src/cleanUrl.ts"]);
});

test("plain text copies never take an address: links go through copyLink", () => {
  const offenders = files.flatMap((f) =>
    [...f.text.matchAll(/(?<![.\w])copyText\(([^)]*)\)/g)].filter(([, argument]) => /url|href|link|address/i.test(argument)).map(([call]) => `${f.path}: ${call}`),
  );
  assert.deepEqual(offenders, []);
});

test("the phone shares links only through its branded sinks or a cleaned ShareLink", () => {
  assert.deepEqual(callersOf(/\bShare\.share\(/), ["apps/phone/src/platform/system.ts"]);
  assert.deepEqual(callersOf(/\.sharePage\(/).filter((path) => path.startsWith("apps/phone/")), ["apps/phone/src/platform/system.ts"]);
  const shareLinks = files.flatMap((f) => [...f.text.matchAll(/<ShareLink\b[^>]*>/g)].map(([tag]) => `${f.path}: ${tag}`));
  assert.ok(shareLinks.length > 0);
  for (const tag of shareLinks) assert.match(tag, /item=\{cleanUrl\(/, tag);
});
