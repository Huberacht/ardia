import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { templateProblems, templateSizes } from "./template-state.mjs";

export const TEMPLATE_CACHE_REVISION = 1;
export const TEMPLATE_MAX_AGE_HOURS = 12;

const ENTRY = "entry.json";

const plistValue = (app, key) => {
  try {
    return execFileSync("plutil", ["-extract", key, "raw", join(app, "Contents/Info.plist")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

export const fileSha256 = (file) => (file && existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null);

export function uboVersion(app) {
  try {
    return JSON.parse(readFileSync(join(app, "Contents/Resources/Extensions/ublock/manifest.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

export const appCdhash = (app) => spawnSync("codesign", ["-dvvv", app], { encoding: "utf8" }).stderr?.match(/^CDHash=([0-9a-f]+)$/m)?.[1] ?? null;

export function appIdentity(app) {
  return { version: plistValue(app, "CFBundleShortVersionString"), build: plistValue(app, "CFBundleVersion"), cdhash: appCdhash(app), ubo: uboVersion(app) };
}

export function templateKey({ identity, bundleSha, pagePort, recipe = "session", revision = TEMPLATE_CACHE_REVISION, ...rest }) {
  return { revision, recipe, version: identity.version, build: identity.build, cdhash: identity.cdhash, ubo: identity.ubo, bundleSha, pagePort, ...rest };
}

export const keyId = (key) => createHash("sha256").update(JSON.stringify(Object.keys(key).sort().map((k) => [k, key[k]]))).digest("hex").slice(0, 16);

export function keyProblems(key) {
  return Object.entries(key).filter(([, v]) => v === null || v === undefined || v === "" || v === 0).map(([k]) => `the key's ${k} is unknown`);
}

export function defaultCacheDir(src, out) {
  const app = resolve(src);
  const exportDir = dirname(app);
  if (basename(exportDir) === "export" && basename(dirname(dirname(exportDir))) === "dist") return join(dirname(exportDir), "bench", "templates");
  return join(out, ".templates");
}

const sameSizes = (a, b) => ["uboStoreMB", "uboBlobsMB", "uboLogMB"].every((k) => Number.isFinite(a?.[k]) && Math.abs(a[k] - b?.[k]) < 1e-9);

export function entryProblems(entry, key, { now = Date.now(), maxAgeHours = TEMPLATE_MAX_AGE_HOURS, sizes = null, validate = templateProblems } = {}) {
  if (!entry) return ["no cached template"];
  const problems = [];
  for (const k of new Set([...Object.keys(key), ...Object.keys(entry.key ?? {})]))
    if (entry.key?.[k] !== key[k]) problems.push(`${k} changed (${entry.key?.[k] ?? "none"} → ${key[k] ?? "none"})`);
  const made = Date.parse(entry.made);
  const ageHours = (now - made) / 3600_000;
  if (!Number.isFinite(made) || ageHours < 0) problems.push("it has no valid date");
  else if (ageHours > maxAgeHours) problems.push(`it is ${ageHours.toFixed(1)} h old, over ${maxAgeHours} h (startup components and uBO's lists move)`);
  if (!entry.record) problems.push("it has no template record");
  else {
    problems.push(...validate(entry.record));
    if (sizes && !sameSizes(sizes, entry.record.sizes)) problems.push("its files changed since it was stored");
  }
  return problems;
}

export function lookupTemplate(cacheDir, key, { sizesOf = templateSizes, ...opts } = {}) {
  const dir = join(cacheDir, keyId(key));
  const template = join(dir, "template");
  let entry = null;
  try {
    entry = JSON.parse(readFileSync(join(dir, ENTRY), "utf8"));
  } catch {}
  const problems = entry && existsSync(template) ? entryProblems(entry, key, { ...opts, sizes: sizesOf(template) }) : ["no cached template"];
  return problems.length ? { hit: false, problems, dir } : { hit: true, dir, template, entry };
}

export function storeTemplate(cacheDir, key, templateDir, record, { now = Date.now() } = {}) {
  const dir = join(cacheDir, keyId(key));
  const staging = `${dir}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  execFileSync("cp", ["-Rc", templateDir, join(staging, "template")]);
  writeFileSync(join(staging, ENTRY), JSON.stringify({ key, made: new Date(now).toISOString(), record }, null, 2));
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
  return dir;
}

export function copyCachedTemplate(hit, templateDir) {
  rmSync(templateDir, { recursive: true, force: true });
  mkdirSync(dirname(templateDir), { recursive: true });
  execFileSync("cp", ["-Rc", hit.template, templateDir]);
}

export const cachedAgeHours = (entry, now = Date.now()) => (now - Date.parse(entry.made)) / 3600_000;
