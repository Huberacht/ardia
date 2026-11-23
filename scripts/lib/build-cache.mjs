import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const STAMP_VERSION = 1;

export const NATIVE_PATHSPECS = [
  "apps/browser/macos",
  "apps/browser/app.json",
  "apps/browser/react-native.config.js",
  "apps/browser/package.json",
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "patches",
  "packages/*/ios/*",
  "packages/*/package.json",
  "packages/*/expo-module.config.json",
  "packages/shell/docktile",
  "packages/shell/plugin-host",
  "packages/ardiacore/scripts/*.sh",
  "packages/ardiacore/scripts/*.py",
  "packages/ardiacore/scripts/signing",
  "packages/ardiacore/scripts/first-run-resources.sha256",
  "packages/ardiacore/extensions",
  "engine/ardiacore/src/ardia/core/public",
  "packages/core-rs",
];

export const DEPS_PATHSPECS = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "patches", "apps/*/package.json", "packages/*/package.json"];

export const PODS_PATHSPECS = [
  ...DEPS_PATHSPECS,
  "apps/browser/macos/Podfile",
  "apps/browser/macos/Podfile.lock",
  "apps/browser/macos/Podfile.properties.json",
  "apps/browser/react-native.config.js",
  "apps/browser/app.json",
  "packages/*/ios/*.podspec",
  "packages/*/expo-module.config.json",
];

export const defaults = (env = process.env) => ({
  cacheRoot: env.AC_APP_CACHE || join(homedir(), "ardia-scratch/app-cache"),
  slotRoot: env.AC_BUILD_SLOTS || join(homedir(), "ardia-scratch/build-slots"),
  maxBytes: Number(env.AC_APP_CACHE_MAX_GB || 40) * 1024 ** 3,
  maxEntries: Number(env.AC_APP_CACHE_MAX_ENTRIES || 16),
  keepSlots: Number(env.AC_BUILD_SLOTS_KEEP || 3),
});

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export function contentId(path) {
  const st = fs.lstatSync(path);
  if (st.isSymbolicLink()) return `l:${sha256(fs.readlinkSync(path))}`;
  const data = fs.readFileSync(path);
  const mode = st.mode & 0o111 ? "x" : "f";
  if (path.endsWith(".pbxproj")) {
    const lines = data.toString("utf8").split("\n").map((l) => l.trimEnd()).filter(Boolean).sort();
    return `${mode}:p:${sha256(lines.join("\n"))}`;
  }
  return `${mode}:${sha256(data)}`;
}

export function listFiles(repo, pathspecs) {
  const out = execFileSync("git", ["-C", repo, "ls-files", "-co", "--exclude-standard", "-z", "--", ...pathspecs], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return [...new Set(out.split("\0").filter(Boolean))].sort();
}

export function manifestOf(repo, files) {
  const manifest = {};
  for (const rel of files) {
    const path = join(repo, rel);
    let st;
    try {
      st = fs.lstatSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) continue;
    manifest[rel] = contentId(path);
  }
  return manifest;
}

export function hashManifest(manifest, extra = []) {
  const h = createHash("sha256");
  for (const rel of Object.keys(manifest).sort()) h.update(`${rel}\0${manifest[rel]}\n`);
  for (const line of extra) h.update(`${line}\n`);
  return h.digest("hex");
}

export function frameworkIdentity(framework, engineKey) {
  const prebuilt = framework?.match(/\/(?:prebuilt|engines)\/([0-9a-f]{12})\/Chromium Framework\.framework\/?$/);
  if (prebuilt) return `prebuilt ${prebuilt[1]}`;
  const binary = framework && join(framework, "Versions/Current/Chromium Framework");
  if (binary && fs.existsSync(binary)) {
    const st = fs.statSync(binary);
    return `framework ${st.size} ${Math.floor(st.mtimeMs)}`;
  }
  return `prebuilt ${String(engineKey).slice(0, 12)}`;
}

export function xcodeIdentity() {
  try {
    const developer = execFileSync("xcode-select", ["-p"], { encoding: "utf8" }).trim();
    const plist = join(dirname(developer), "version.plist");
    const text = fs.readFileSync(plist, "utf8");
    return `xcode ${text.match(/<key>ProductBuildVersion<\/key>\s*<string>([^<]+)</)?.[1] ?? "unknown"}`;
  } catch {
    return "xcode unknown";
  }
}

export function engineKeyOf(repo) {
  const r = spawnSync(join(repo, "engine/engine-key.sh"), ["--platform", "macos"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "unknown";
}

export function stampOf({ manifest, config, signing = "default", framework, engineKey, xcode }) {
  return hashManifest(manifest, [
    `stamp v${STAMP_VERSION}`,
    `config ${config}`,
    `signing ${signing}`,
    `engine ${engineKey}`,
    frameworkIdentity(framework, engineKey),
    xcode,
  ]).slice(0, 32);
}

export function nativeStamp(repo, { config, signing, framework, engineKey = engineKeyOf(repo), xcode = xcodeIdentity() }) {
  return stampOf({ manifest: manifestOf(repo, listFiles(repo, NATIVE_PATHSPECS)), config, signing, framework, engineKey, xcode });
}

const readJson = (path, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJsonAtomic = (path, value) => {
  const tmp = `${path}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, path);
};

export function cacheEntryDir(cacheRoot, stamp) {
  return join(cacheRoot, stamp);
}

export function lookup(cacheRoot, stamp) {
  const dir = cacheEntryDir(cacheRoot, stamp);
  const meta = readJson(join(dir, "meta.json"));
  if (!meta || meta.stamp !== stamp || !fs.existsSync(join(dir, "Ardia.app/Contents/MacOS"))) return null;
  return { dir, app: join(dir, "Ardia.app"), meta };
}

export function touch(dir, now = new Date()) {
  const used = join(dir, ".used");
  fs.writeFileSync(used, "");
  fs.utimesSync(used, now, now);
}

export function duBytes(path) {
  const r = spawnSync("du", ["-sk", path], { encoding: "utf8" });
  return r.status === 0 ? Number(r.stdout.split(/\s/)[0]) * 1024 : 0;
}

export function store(cacheRoot, stamp, app, meta = {}, { hermesc = null, measure = duBytes, replace = false } = {}) {
  const existing = lookup(cacheRoot, stamp);
  if (existing && !replace) {
    touch(existing.dir);
    return existing;
  }
  if (existing) {
    const trash = join(cacheRoot, `.tmp-replaced-${process.pid}-${Date.now()}`);
    fs.renameSync(existing.dir, trash);
    fs.rmSync(trash, { recursive: true, force: true });
  }
  fs.mkdirSync(cacheRoot, { recursive: true });
  const tmp = join(cacheRoot, `.tmp-${process.pid}-${Date.now()}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp);
  execFileSync("cp", ["-Rc", app, join(tmp, "Ardia.app")]);
  if (hermesc && fs.existsSync(hermesc)) execFileSync("cp", ["-c", hermesc, join(tmp, "hermesc")]);
  const full = { ...meta, stamp, created: new Date().toISOString(), bytes: measure(tmp) };
  fs.writeFileSync(join(tmp, "meta.json"), JSON.stringify(full, null, 1));
  touch(tmp);
  const dir = cacheEntryDir(cacheRoot, stamp);
  try {
    fs.renameSync(tmp, dir);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!lookup(cacheRoot, stamp)) throw e;
  }
  return lookup(cacheRoot, stamp);
}

export function entries(cacheRoot) {
  let names;
  try {
    names = fs.readdirSync(cacheRoot);
  } catch {
    return [];
  }
  const list = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const dir = join(cacheRoot, name);
    const meta = readJson(join(dir, "meta.json"));
    if (!meta) continue;
    let usedAt = 0;
    try {
      usedAt = fs.statSync(join(dir, ".used")).mtimeMs;
    } catch {}
    list.push({ stamp: name, dir, bytes: meta.bytes ?? 0, usedAt, meta });
  }
  return list;
}

export function evictionPlan(list, { maxBytes, maxEntries, protect = [] }) {
  const sorted = [...list].sort((a, b) => b.usedAt - a.usedAt);
  const keep = [];
  const evict = [];
  let bytes = 0;
  for (const e of sorted) {
    const protectedEntry = protect.includes(e.stamp);
    if (protectedEntry || (keep.length < maxEntries && bytes + e.bytes <= maxBytes)) {
      keep.push(e);
      bytes += e.bytes;
    } else evict.push(e);
  }
  return { keep, evict, bytes };
}

export function evict(cacheRoot, opts) {
  const plan = evictionPlan(entries(cacheRoot), opts);
  for (const e of plan.evict) fs.rmSync(e.dir, { recursive: true, force: true });
  try {
    for (const name of fs.readdirSync(cacheRoot)) {
      const path = join(cacheRoot, name);
      if (name.startsWith(".tmp-") && Date.now() - fs.statSync(path).mtimeMs > 3600e3) fs.rmSync(path, { recursive: true, force: true });
    }
  } catch {}
  return plan;
}

export function manifestDiff(from, to) {
  const changed = [];
  const removed = [];
  for (const [rel, id] of Object.entries(to)) if (from[rel] !== id) changed.push(rel);
  for (const rel of Object.keys(from)) if (!(rel in to)) removed.push(rel);
  return { changed: changed.sort(), removed: removed.sort() };
}

export const slotTree = (slot) => join(slot, "ardia");
export const slotDerivedData = (slot) => join(slotTree(slot), "apps/browser/build-slot");
export const slotStatePath = (slot) => join(slot, "slot.json");
export const readSlotState = (slot) => readJson(slotStatePath(slot), { manifest: {}, syncedAt: 0 });
export const writeSlotState = (slot, state) => writeJsonAtomic(slotStatePath(slot), state);

export function lockHolderPath(derivedData, root = process.env.AC_LOCK_ROOT || "/tmp") {
  const base = derivedData.replace(/\/+$/, "").split("/").pop();
  const digest = createHash("sha1").update(derivedData.replace(/\/+$/, "")).digest("hex").slice(0, 8);
  return join(root, `ac-xcodebuild-${base.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40)}-${digest}.holder`);
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

export function slotBusy(slot, { root } = {}) {
  let holder;
  try {
    holder = fs.readFileSync(lockHolderPath(slotDerivedData(slot), root), "utf8");
  } catch {
    return false;
  }
  const [kind, value] = holder.trim().split(/\s+/);
  if (kind === "pid") return pidAlive(Number(value));
  if (kind === "take") return Number(value) * 1000 > Date.now();
  return false;
}

export function listSlots(slotRoot) {
  let names;
  try {
    names = fs.readdirSync(slotRoot);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^\d+$/.test(n))
    .sort((a, b) => Number(a) - Number(b))
    .map((n) => join(slotRoot, n));
}

export function rankSlots(slots, manifest, { busy = slotBusy, readState = readSlotState } = {}) {
  return slots
    .map((slot) => {
      const state = readState(slot);
      const { changed, removed } = manifestDiff(state.manifest ?? {}, manifest);
      return { slot, busy: busy(slot), distance: changed.length + removed.length, usedAt: state.syncedAt ?? 0 };
    })
    .sort((a, b) => a.busy - b.busy || a.distance - b.distance || b.usedAt - a.usedAt);
}

export function nextSlotPath(slotRoot, slots = listSlots(slotRoot)) {
  const used = new Set(slots.map((s) => Number(s.split("/").pop())));
  let n = 1;
  while (used.has(n)) n++;
  return join(slotRoot, String(n));
}

export function pickSlots(slotRoot, manifest, opts = {}) {
  const ranked = rankSlots(listSlots(slotRoot), manifest, opts);
  const free = ranked.filter((r) => !r.busy).map((r) => r.slot);
  return [...free, nextSlotPath(slotRoot)];
}

export function slotsToEvict(slotRoot, { keep, busy = slotBusy, readState = readSlotState, protect = [] } = {}) {
  const idle = listSlots(slotRoot)
    .filter((s) => !protect.includes(s) && !busy(s))
    .map((slot) => ({ slot, usedAt: readState(slot).syncedAt ?? 0 }))
    .sort((a, b) => b.usedAt - a.usedAt);
  const kept = keep - protect.length;
  return idle.slice(Math.max(0, kept)).map((s) => s.slot);
}

function copyInto(srcRepo, dstRepo, rel, now) {
  const src = join(srcRepo, rel);
  const dst = join(dstRepo, rel);
  fs.mkdirSync(dirname(dst), { recursive: true });
  const st = fs.lstatSync(src);
  const tmp = `${dst}.ac-sync-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  if (st.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), tmp);
  } else {
    fs.copyFileSync(src, tmp, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(tmp, st.mode & 0o7777);
    fs.utimesSync(tmp, now, now);
  }
  try {
    if (fs.lstatSync(dst).isDirectory()) fs.rmSync(dst, { recursive: true, force: true });
  } catch {}
  fs.renameSync(tmp, dst);
}

function pruneEmptyDirs(root, rel) {
  let dir = dirname(rel);
  while (dir && dir !== ".") {
    try {
      fs.rmdirSync(join(root, dir));
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

export function driftedPaths(tree, state) {
  const drifted = [];
  const since = state.syncedAt ?? 0;
  for (const [rel, id] of Object.entries(state.manifest ?? {})) {
    let st;
    try {
      st = fs.lstatSync(join(tree, rel));
    } catch {
      drifted.push(rel);
      continue;
    }
    if (st.mtimeMs > since || st.ctimeMs > since) {
      if (contentId(join(tree, rel)) !== id) drifted.push(rel);
    }
  }
  return drifted;
}

export function syncTree(srcRepo, slot, manifest, { now = new Date() } = {}) {
  const tree = slotTree(slot);
  fs.mkdirSync(tree, { recursive: true });
  const state = readSlotState(slot);
  const drifted = new Set(driftedPaths(tree, state));
  const base = { ...(state.manifest ?? {}) };
  for (const rel of drifted) delete base[rel];
  const { changed, removed } = manifestDiff(base, manifest);
  for (const rel of removed) {
    fs.rmSync(join(tree, rel), { force: true });
    pruneEmptyDirs(tree, rel);
  }
  for (const rel of changed) copyInto(srcRepo, tree, rel, now);
  writeSlotState(slot, { ...state, manifest, syncedAt: Date.now() + 1 });
  return { changed, removed, drifted: [...drifted] };
}

export function linksOutside(dir) {
  const nodeModules = join(dir, "node_modules");
  try {
    if (fs.lstatSync(nodeModules).isSymbolicLink()) return true;
    for (const name of fs.readdirSync(nodeModules)) {
      if (name.startsWith(".") || name.startsWith("@")) continue;
      const path = join(nodeModules, name);
      if (!fs.lstatSync(path).isSymbolicLink()) continue;
      const target = fs.realpathSync(path);
      if (!target.startsWith(fs.realpathSync(dir) + "/")) return true;
    }
  } catch {
    return false;
  }
  return false;
}
