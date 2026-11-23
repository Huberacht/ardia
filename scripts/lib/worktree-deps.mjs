import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = ".ardia-linked-deps.json";
export const GUARD_FILE = ".pnpmfile.cjs";
export const NEVER_INDEX = ".metadata_never_index";
export const CACHE_STAMP = "deps.json";
export const USERS_DIR = ".users";
export const LINKED_DOT_ENTRIES = new Set([".bin"]);
export const WORKSPACE_SCOPE = "@ardia";
const MARKER_VERSION = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const SETUP_GRACE_MS = 60 * 60 * 1000;

const self = fileURLToPath(import.meta.url);
const lockedScript = path.join(path.dirname(self), "..", "agent", "locked");

export const HELP = `worktree-setup: give a worktree or scratch export working node_modules in seconds, as links into one shared,
read-only dependency tree instead of an APFS clone (a clone writes 100k+ inodes and keeps fseventsd busy).

  scripts/agent/worktree-setup <worktree> [--cache <dir>] [--replace]
  scripts/agent/worktree-setup --status <worktree>
  scripts/agent/worktree-setup --undo <worktree>
  scripts/agent/worktree-setup --prune [--older-than <days>] [--cache <dir>]
  scripts/agent/worktree-setup -h | --help

What it does to <worktree>:
  - node_modules (the root and every pnpm workspace project's) becomes a real folder of per-entry links into the
    dependency tree. @ardia/* links point at the worktree's own apps/* and packages/*.
    Dot entries other than .bin stay local, so caches (.cache, .vite) land in the worktree.
  - The dependency tree is a pnpm install made once per set of install inputs (the lockfile, .npmrc,
    pnpm-workspace.yaml, every workspace package.json, patches/, and the platform, CPU and Node major version)
    under the cache (default ~/ardia-scratch/deps.noindex/<key>, $ARDIA_DEPS_CACHE moves it). It is built, checked,
    made read-only and published under scripts/agent/locked pod; every later worktree with the same inputs reuses it
    in milliseconds. Read-only matters: pnpm with its guard skipped writes through per-entry links, and so can npm
    or a build script; the read-only tree refuses them all.
  - .pnpmfile.cjs blocks pnpm install there (pnpm run and pnpm exec print the block, then still run the script).
    Run tools with node or node_modules/.bin. It and .metadata_never_index go into the repo's info/exclude.
    Setup refuses a worktree that already has its own .pnpmfile.cjs.
  - node_modules/${MARKER} lists every folder setup manages, written before the first link. apps/browser/metro.config.js
    reads it to watch and resolve through the links, so Metro, js-bench.mjs bundle and the Xcode bundle phase work
    unchanged. The cache's ${USERS_DIR}/ records each linked worktree, so --prune keeps what is in use.
  - .metadata_never_index goes into the worktree, the cache and ~/ardia-scratch and ~/ardia-wt when they exist.

--status   says which tree the worktree uses and whether it still matches its install inputs.
--undo     removes the links, the guard, the marker and the worktree's record; the dependency tree is left alone.
--prune    deletes cached trees that no recorded worktree still links and unused for --older-than days (default 7),
           under the same lock as building one.
--replace  lets setup replace a worktree's own node_modules (a real install or a whole-folder link).
`;

export function normalizeLockfile(text) {
  const documents = text
    .split(/^---[ \t]*$/m)
    .map((document) => document.replace(/^\r?\n/, ""))
    .filter((document) => document.trim());
  return documents.at(-1) ?? "";
}

export function runtimeOf(process_ = process) {
  return `${process_.platform}-${process_.arch}-node${process_.versions.node.split(".")[0]}`;
}

export function dependencyKey({ files, runtime }) {
  const hash = createHash("sha256");
  hash.update(`runtime\0${runtime}`);
  const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, content] of sorted) hash.update(`\0file\0${name}\0${content.length}\0`).update(content);
  return hash.digest("hex").slice(0, 16);
}

export function workspacePatterns(workspaceYaml) {
  const patterns = [];
  let inPackages = false;
  for (const line of workspaceYaml.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (item) {
      patterns.push(item[1].replace(/^(['"])(.*)\1$/, "$2"));
      continue;
    }
    if (line.trim() && !/^\s/.test(line)) inPackages = false;
  }
  return patterns;
}

export function workspaceProjects(root, workspaceYaml) {
  const patterns = workspacePatterns(workspaceYaml);
  const excluded = new Set(patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1).replace(/\/$/, "")));
  const projects = new Set([""]);
  for (const pattern of patterns.filter((p) => !p.startsWith("!"))) {
    const candidates = pattern.endsWith("/*") ? listDirs(path.join(root, pattern.slice(0, -2))).map((name) => `${pattern.slice(0, -2)}/${name}`) : [pattern.replace(/\/$/, "")];
    for (const candidate of candidates) {
      if (!excluded.has(candidate) && fs.existsSync(path.join(root, candidate, "package.json"))) projects.add(candidate);
    }
  }
  return [...projects].sort();
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function installInputs(root, runtime = runtimeOf()) {
  const lockfile = readIfExists(path.join(root, "pnpm-lock.yaml"));
  if (lockfile === null) throw new Error(`${root} has no pnpm-lock.yaml`);
  const workspace = readIfExists(path.join(root, "pnpm-workspace.yaml")) ?? "";
  const projects = workspaceProjects(root, workspace);
  const names = ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ...projects.map((p) => (p ? `${p}/package.json` : "package.json"))];
  try {
    for (const entry of fs.readdirSync(path.join(root, "patches"), { withFileTypes: true })) if (entry.isFile()) names.push(`patches/${entry.name}`);
  } catch {}
  const files = names.map((name) => [name, readIfExists(path.join(root, name))]).filter(([, content]) => content !== null);
  return { files, runtime, projects, lockfile };
}

export function readEntries(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.name === WORKSPACE_SCOPE && entry.isDirectory()) {
        const links = fs
          .readdirSync(full, { withFileTypes: true })
          .filter((e) => e.isSymbolicLink())
          .map((e) => ({ name: e.name, link: fs.readlinkSync(path.join(full, e.name)) }));
        return { name: entry.name, kind: "workspace-scope", links };
      }
      return { name: entry.name, kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "dir" : "file" };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function planLinks({ sourceRoot, worktreeRoot, project, entries, exists = fs.existsSync }) {
  const sourceDir = path.join(sourceRoot, project, "node_modules");
  const targetDir = path.join(worktreeRoot, project, "node_modules");
  const ops = [{ type: "mkdir", path: targetDir }];
  const warnings = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && !LINKED_DOT_ENTRIES.has(entry.name)) continue;
    if (entry.kind === "workspace-scope") {
      const scopeDir = path.join(targetDir, entry.name);
      ops.push({ type: "mkdir", path: scopeDir });
      for (const { name, link } of entry.links) {
        const resolved = path.resolve(sourceDir, entry.name, link);
        const relative = path.relative(sourceRoot, resolved);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
          warnings.push(`${entry.name}/${name} in ${sourceDir} points outside its tree (${link}); not linked`);
          continue;
        }
        const own = path.join(worktreeRoot, relative);
        if (!exists(own)) {
          warnings.push(`${entry.name}/${name}: the worktree has no ${relative}; not linked`);
          continue;
        }
        ops.push({ type: "symlink", path: path.join(scopeDir, name), target: path.relative(scopeDir, own) });
      }
      continue;
    }
    ops.push({ type: "symlink", path: path.join(targetDir, entry.name), target: path.join(sourceDir, entry.name) });
  }
  return { ops, warnings };
}

export function markerOf(worktree) {
  const text = readIfExists(path.join(worktree, "node_modules", MARKER));
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { broken: true, projects: [] };
  }
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const partial = `${file}.${process.pid}.partial`;
  fs.writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(partial, file);
}

function prepareTarget(worktree, projects, previous, replace) {
  const managed = [...new Set([...projects, ...(previous?.projects ?? [])])];
  const dirs = managed.map((project) => path.join(worktree, project, "node_modules")).filter((dir) => lstatOrNull(dir));
  if (previous === null) {
    if (dirs.length && !replace) {
      const what = lstatOrNull(dirs[0]).isSymbolicLink() ? "is a link to a whole node_modules" : "is its own install";
      throw new Error(`${dirs[0]} ${what}; pass --replace to swap it for per-entry links`);
    }
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  const dropped = new Set(managed.filter((project) => !projects.includes(project)).map((project) => path.join(worktree, project, "node_modules")));
  for (const dir of dirs) {
    if (lstatOrNull(dir).isSymbolicLink() || dropped.has(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.name.startsWith(".") || LINKED_DOT_ENTRIES.has(entry.name)) {
        fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
      }
    }
  }
}

function applyOps(ops) {
  let links = 0;
  for (const op of ops) {
    if (op.type === "mkdir") fs.mkdirSync(op.path, { recursive: true });
    else {
      fs.symlinkSync(op.target, op.path);
      links++;
    }
  }
  return links;
}

const GUARD_SIGNATURE = "pnpm install is blocked in a worktree linked by scripts/agent/worktree-setup";

export const GUARD_SOURCE = `const message = [
  "",
  "worktree-setup: this worktree's node_modules are links into a shared dependency tree, so pnpm install is",
  "blocked here: it would rewrite that tree under every worktree that uses it.",
  "Run tools with node or node_modules/.bin. pnpm run and pnpm exec still run their script after this message.",
  "To install for real: scripts/agent/worktree-setup --undo <this worktree>, then pnpm install under scripts/agent/locked pod.",
  "",
].join("\\n");
let told = false;
function blocked() {
  if (!told) process.stderr.write(message);
  told = true;
  throw new Error("${GUARD_SIGNATURE}");
}
module.exports = { hooks: { preResolution: blocked, readPackage: blocked } };
`;

export function isOurGuard(text) {
  return text !== null && text.includes(`throw new Error("${GUARD_SIGNATURE}")`);
}

export function checkGuardSlot(worktree) {
  const tracked = spawnSync("git", ["-C", worktree, "ls-files", "--error-unmatch", GUARD_FILE], { stdio: "ignore" }).status === 0;
  if (tracked) throw new Error(`${worktree} tracks its own ${GUARD_FILE}, so its pnpm install can't be blocked; link it by hand or not at all`);
  const existing = readIfExists(path.join(worktree, GUARD_FILE));
  if (existing !== null && !isOurGuard(existing)) {
    throw new Error(`${path.join(worktree, GUARD_FILE)} is someone else's pnpmfile; move it away first (setup would replace it and --undo would delete it)`);
  }
}

export function withFileLock(lockDir, action, { waitMs = 10000, staleMs = 30000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = lstatOrNull(lockDir);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`${lockDir} is still held after ${waitMs} ms`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return action();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function excludeFromGit(worktree, names) {
  const result = spawnSync("git", ["-C", worktree, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const file = path.resolve(worktree, result.stdout.trim());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withFileLock(`${file}.worktree-setup.lock`, () => {
    const current = readIfExists(file) ?? "";
    const lines = new Set(current.split(/\r?\n/));
    const missing = names.map((name) => `/${name}`).filter((line) => !lines.has(line));
    if (missing.length) fs.appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  });
  return file;
}

export function dropNeverIndex(dir) {
  const file = path.join(dir, NEVER_INDEX);
  if (fs.existsSync(dir) && !fs.existsSync(file)) {
    fs.writeFileSync(file, "");
    return true;
  }
  return false;
}

export function defaultCacheRoot() {
  return path.resolve(process.env.ARDIA_DEPS_CACHE || path.join(os.homedir(), "ardia-scratch", "deps.noindex"));
}

function nodeModulesDirsOf(root) {
  return [path.join(root, "node_modules"), ...listDirs(root).flatMap((top) => listDirs(path.join(root, top)).map((name) => path.join(root, top, name, "node_modules")))].filter((dir) => fs.existsSync(dir));
}

export function pnpmInstall(staging) {
  const log = path.join(staging, "install.log");
  const out = fs.openSync(log, "w");
  const result = spawnSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--package-import-method=clone-or-copy", "--reporter=append-only"], { cwd: staging, stdio: ["ignore", out, out] });
  fs.closeSync(out);
  if (result.status !== 0) {
    const tail = (readIfExists(log) ?? "").split("\n").slice(-20).join("\n");
    throw new Error(`pnpm install for the dependency cache failed (exit ${result.status ?? result.error?.code}); the end of ${log}:\n${tail}`);
  }
}

function copyInputs(worktree, staging, files) {
  for (const [name] of files) {
    fs.mkdirSync(path.dirname(path.join(staging, name)), { recursive: true });
    fs.copyFileSync(path.join(worktree, name), path.join(staging, name));
  }
}

function setWritable(dirs, writable) {
  if (dirs.length === 0) return;
  execFileSync("chmod", ["-R", writable ? "u+w" : "a-w", ...dirs]);
}

export function removeTree(dir) {
  if (!lstatOrNull(dir)) return;
  spawnSync("chmod", ["-R", "u+w", dir]);
  fs.rmSync(dir, { recursive: true, force: true });
}

export function buildCache({ worktree, cacheRoot, install = pnpmInstall, runtime = runtimeOf() }) {
  const inputs = installInputs(worktree, runtime);
  const key = dependencyKey(inputs);
  const final = path.join(cacheRoot, key);
  if (fs.existsSync(path.join(final, CACHE_STAMP))) return { dir: final, key, created: false };
  fs.mkdirSync(cacheRoot, { recursive: true });
  dropNeverIndex(cacheRoot);
  const staging = path.join(cacheRoot, `.staging-${key}-${process.pid}`);
  removeTree(staging);
  fs.mkdirSync(staging, { recursive: true });
  try {
    copyInputs(worktree, staging, inputs.files);
    install(staging);
    const installed = readIfExists(path.join(staging, "node_modules", ".pnpm", "lock.yaml"));
    if (installed === null || normalizeLockfile(installed) !== normalizeLockfile(inputs.lockfile)) throw new Error("the cache install's lockfile doesn't match the worktree's");
    setWritable(nodeModulesDirsOf(staging), false);
    const fingerprint = { key, runtime, files: Object.fromEntries(inputs.files.map(([name, content]) => [name, createHash("sha256").update(content).digest("hex")])) };
    writeJsonAtomic(path.join(staging, CACHE_STAMP), { ...fingerprint, created: new Date().toISOString(), from: worktree });
    removeTree(final);
    fs.renameSync(staging, final);
    return { dir: final, key, created: true };
  } catch (error) {
    removeTree(staging);
    throw error;
  }
}

export function underPodLock(args) {
  const result = spawnSync(lockedScript, ["pod", "--wait", "500", "--", process.execPath, self, ...args], { stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) throw new Error(`${args[0]} under scripts/agent/locked pod failed (exit ${result.status ?? result.error?.code})`);
}

function userRecord(cacheRoot, worktree) {
  return path.join(cacheRoot, USERS_DIR, `${createHash("sha256").update(worktree).digest("hex").slice(0, 16)}.json`);
}

export function setupWorktree(worktreeArg, options = {}) {
  const started = Date.now();
  const log = options.log ?? console.log;
  const worktree = fs.realpathSync(worktreeArg);
  const cacheRoot = path.resolve(options.cacheRoot ?? defaultCacheRoot());
  const runtime = options.runtime ?? runtimeOf();
  checkGuardSlot(worktree);
  const inputs = installInputs(worktree, runtime);
  const key = dependencyKey(inputs);
  const previous = markerOf(worktree);
  if (previous === null && !options.replace) prepareTarget(worktree, inputs.projects, null, false);

  fs.mkdirSync(path.join(cacheRoot, USERS_DIR), { recursive: true });
  dropNeverIndex(cacheRoot);
  const record = userRecord(cacheRoot, worktree);
  writeJsonAtomic(record, { worktree, key, at: new Date().toISOString() });

  const final = path.join(cacheRoot, key);
  const stamp = path.join(final, CACHE_STAMP);
  let createdCache = false;
  if (!fs.existsSync(stamp)) {
    log(`installing ${key} into ${cacheRoot} (once per set of install inputs, under scripts/agent/locked pod)`);
    const build = options.build ?? (() => underPodLock(["--build-cache", worktree, "--cache", cacheRoot]));
    build({ worktree, cacheRoot, runtime });
    if (!fs.existsSync(stamp)) throw new Error(`building ${final} didn't publish ${CACHE_STAMP}`);
    createdCache = true;
  } else {
    fs.utimesSync(stamp, new Date(), new Date());
  }
  const sourceRoot = fs.realpathSync(final);

  const plans = [];
  for (const project of inputs.projects) {
    const sourceDir = path.join(sourceRoot, project, "node_modules");
    if (fs.existsSync(sourceDir)) plans.push({ project, sourceDir, ...planLinks({ sourceRoot, worktreeRoot: worktree, project, entries: readEntries(sourceDir) }) });
  }
  prepareTarget(worktree, inputs.projects, previous, options.replace ?? false);
  const rootModules = path.join(worktree, "node_modules");
  fs.mkdirSync(rootModules, { recursive: true });
  const markerFile = path.join(rootModules, MARKER);
  const managed = [...new Set([...plans.map((p) => p.project), ...(previous?.projects ?? [])])].sort();
  const marker = { version: MARKER_VERSION, key, root: sourceRoot, nodeModules: plans.map((p) => p.sourceDir), projects: managed, state: "linking", created: new Date().toISOString() };
  writeJsonAtomic(markerFile, marker);

  let links = 0;
  const warnings = [];
  for (const plan of plans) {
    links += applyOps(plan.ops);
    warnings.push(...plan.warnings);
  }
  marker.projects = plans.map((p) => p.project);
  marker.state = "linked";
  writeJsonAtomic(markerFile, marker);

  fs.writeFileSync(path.join(worktree, GUARD_FILE), GUARD_SOURCE);
  const neverIndexed = [worktree, path.join(os.homedir(), "ardia-scratch"), path.join(os.homedir(), "ardia-wt")].filter(dropNeverIndex);
  const exclude = excludeFromGit(worktree, [GUARD_FILE, NEVER_INDEX]);

  const ms = Date.now() - started;
  log(`worktree-setup: ${worktree}`);
  log(`  dependencies: ${createdCache ? "a new cached install" : "the cached install"} ${sourceRoot} (key ${key})`);
  log(`  linked ${links} entries in ${marker.projects.length} node_modules folders (${marker.projects.map((p) => p || ".").join(", ")}) in ${ms} ms`);
  log(`  pnpm install is blocked by ${GUARD_FILE}; marker ${markerFile}; recorded in ${record}`);
  if (neverIndexed.length) log(`  added ${NEVER_INDEX} to ${neverIndexed.join(", ")}`);
  if (exclude) log(`  ${GUARD_FILE} and ${NEVER_INDEX} are listed in ${exclude}`);
  for (const warning of warnings) log(`  warning: ${warning}`);
  log(`  undo: scripts/agent/worktree-setup --undo ${worktree}`);
  return { worktree, key, sourceRoot, links, projects: marker.projects, warnings, ms, createdCache };
}

export function undoWorktree(worktreeArg, { log = console.log } = {}) {
  const worktree = fs.realpathSync(worktreeArg);
  const marker = markerOf(worktree);
  if (!marker) throw new Error(`${worktree} isn't linked by worktree-setup (no node_modules/${MARKER})`);
  const projects = new Set(["", ...(marker.projects ?? [])]);
  for (const project of [...projects].sort().reverse()) fs.rmSync(path.join(worktree, project, "node_modules"), { recursive: true, force: true });
  const guard = path.join(worktree, GUARD_FILE);
  if (isOurGuard(readIfExists(guard))) fs.rmSync(guard);
  if (marker.root) fs.rmSync(userRecord(path.dirname(marker.root), worktree), { force: true });
  log(`worktree-setup: removed the links in ${worktree} (${[...projects].map((p) => p || ".").join(", ")}) and its pnpm guard; ${marker.root} is untouched`);
}

export function worktreeStatus(worktreeArg) {
  const worktree = fs.realpathSync(worktreeArg);
  const marker = markerOf(worktree);
  if (!marker) return { linked: false, worktree, problems: [`no node_modules/${MARKER}`] };
  const problems = [];
  const key = dependencyKey(installInputs(worktree));
  if (key !== marker.key) problems.push(`the worktree's install inputs changed (key ${key}, linked ${marker.key}); run worktree-setup again`);
  if (!marker.root || !fs.existsSync(path.join(marker.root, CACHE_STAMP))) problems.push(`the cached install ${marker.root} is gone; run worktree-setup again`);
  if (marker.state !== "linked") problems.push("setup didn't finish; run worktree-setup again");
  if (readIfExists(path.join(worktree, GUARD_FILE)) !== GUARD_SOURCE) problems.push(`${GUARD_FILE} is missing or changed, so pnpm install isn't blocked`);
  return { linked: true, worktree, marker, key, problems };
}

export function liveUsers(cacheRoot, now = Date.now()) {
  const users = new Map();
  const dir = path.join(cacheRoot, USERS_DIR);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return users;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const marker = record.worktree ? markerOf(record.worktree) : null;
    const linked = marker?.key === record.key && marker.root && path.basename(marker.root) === record.key;
    const fresh = now - fs.statSync(file).mtimeMs < SETUP_GRACE_MS;
    if (linked || fresh) users.set(record.key, [...(users.get(record.key) ?? []), record.worktree]);
    else fs.rmSync(file, { force: true });
  }
  return users;
}

export function pruneCaches({ cacheRoot = defaultCacheRoot(), olderThanDays = 7, now = Date.now(), log = console.log } = {}) {
  const root = path.resolve(cacheRoot);
  const users = liveUsers(root, now);
  const removed = [];
  for (const name of listDirs(root)) {
    if (name === USERS_DIR) continue;
    const dir = path.join(root, name);
    const stamp = lstatOrNull(path.join(dir, CACHE_STAMP));
    const stale = name.startsWith(".staging-") ? now - fs.statSync(dir).mtimeMs > DAY_MS : stamp && now - stamp.mtimeMs > olderThanDays * DAY_MS;
    if (!stale || users.has(name)) continue;
    removeTree(dir);
    removed.push(dir);
  }
  log(removed.length ? `worktree-setup: removed ${removed.join(", ")}` : `worktree-setup: nothing to prune in ${root}`);
  return removed;
}

export function parseArgs(argv) {
  const options = { command: "setup", positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case "-h":
      case "--help":
        options.command = "help";
        break;
      case "--status":
        options.command = "status";
        break;
      case "--undo":
        options.command = "undo";
        break;
      case "--prune":
        options.command = "prune";
        break;
      case "--prune-locked":
        options.command = "prune-locked";
        break;
      case "--build-cache":
        options.command = "build-cache";
        break;
      case "--cache":
        options.cacheRoot = path.resolve(value());
        break;
      case "--older-than":
        options.olderThanDays = Number(value());
        break;
      case "--replace":
        options.replace = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        options.positional.push(arg);
    }
  }
  return options;
}

export function main(argv) {
  const options = parseArgs(argv);
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot();
  if (options.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.command === "prune") {
    underPodLock(["--prune-locked", "--cache", cacheRoot, "--older-than", String(options.olderThanDays ?? 7)]);
    return 0;
  }
  if (options.command === "prune-locked") {
    pruneCaches({ cacheRoot, olderThanDays: options.olderThanDays ?? 7 });
    return 0;
  }
  const [worktree, ...rest] = options.positional;
  if (!worktree || rest.length) {
    process.stderr.write(HELP);
    return 64;
  }
  if (options.command === "build-cache") {
    buildCache({ worktree: fs.realpathSync(worktree), cacheRoot });
    return 0;
  }
  if (options.command === "undo") {
    undoWorktree(worktree);
    return 0;
  }
  if (options.command === "status") {
    const status = worktreeStatus(worktree);
    if (!status.linked) console.log(`worktree-setup: ${status.worktree} isn't linked`);
    else console.log(`worktree-setup: ${status.worktree} uses ${status.marker.root} (key ${status.marker.key})`);
    for (const problem of status.problems) console.log(`  ${problem}`);
    return status.linked && status.problems.length === 0 ? 0 : 1;
  }
  setupWorktree(worktree, { ...options, cacheRoot });
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === self) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`worktree-setup: ${error.message}\n`);
    process.exitCode = 1;
  }
}
