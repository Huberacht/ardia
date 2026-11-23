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
export const LINKED_DOT_ENTRIES = new Set([".bin"]);
export const WORKSPACE_SCOPE = "@ardia";
const MARKER_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

const here = path.dirname(fileURLToPath(import.meta.url));
const lockedScript = path.join(here, "..", "agent", "locked");

export const HELP = `worktree-setup: give a worktree or scratch export working node_modules in seconds, as links into one shared,
read-only dependency tree instead of an APFS clone (a clone writes 100k+ inodes and keeps fseventsd busy).

  scripts/agent/worktree-setup <worktree> [--deps cache|shared] [--shared <checkout>] [--cache <dir>] [--replace]
  scripts/agent/worktree-setup --status <worktree>
  scripts/agent/worktree-setup --undo <worktree>
  scripts/agent/worktree-setup --prune [--older-than <days>] [--cache <dir>]
  scripts/agent/worktree-setup -h | --help

What it does to <worktree>:
  - node_modules (the root and every pnpm workspace project's) becomes a real folder of per-entry links into the
    dependency tree. @ardia/* links point at the worktree's own apps/* and packages/*, never the shared tree's.
    Dot entries other than .bin stay local, so caches (.cache, .vite) land in the worktree.
  - The dependency tree is a pnpm install of the worktree's lockfile, workspace settings and patches/, made once
    under the cache (default ~/ardia-scratch/deps.noindex/<key>, $ARDIA_DEPS_CACHE moves it) under
    scripts/agent/locked pod, then made read-only; every later worktree on that lockfile reuses it in milliseconds.
    Read-only matters: pnpm run with its guard skipped writes through per-entry links, and the cache stops it.
    --deps shared links the shared checkout's node_modules instead, only when its installed lockfile, workspace
    settings and patches match. Nothing stops a write through those links but the guard, and a pnpm install there
    changes every worktree that follows it, so use it only when the cache can't be built (no network, say).
  - .pnpmfile.cjs blocks pnpm install there (pnpm run and pnpm exec print the block, then still run the script).
    Run tools with node or node_modules/.bin. It and .metadata_never_index go into the repo's info/exclude.
  - node_modules/${MARKER} records the tree. apps/browser/metro.config.js reads it to watch and resolve through
    the links, so Metro, js-bench.mjs bundle and the Xcode bundle phase work unchanged.
  - .metadata_never_index goes into the worktree, the cache and ~/ardia-scratch and ~/ardia-wt when they exist.

--status   says which tree the worktree uses and whether it still matches its lockfile.
--undo     removes the links, the guard and the marker; the dependency tree is left alone.
--prune    deletes cached trees no linked git worktree of the shared checkout uses and unused for --older-than days
           (default 7).
--replace  lets setup replace a worktree's own node_modules (a real install or a whole-folder link).
`;

export function normalizeLockfile(text) {
  const documents = text
    .split(/^---[ \t]*$/m)
    .map((document) => document.replace(/^\r?\n/, ""))
    .filter((document) => document.trim());
  return documents.at(-1) ?? "";
}

export function dependencyKey({ lockfile, workspace, patches }) {
  const hash = createHash("sha256");
  hash.update("lockfile\0").update(normalizeLockfile(lockfile));
  hash.update("\0workspace\0").update(workspace ?? "");
  const sorted = [...patches].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, content] of sorted) hash.update(`\0patch\0${name}\0`).update(content);
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

function readPatches(root) {
  const dir = path.join(root, "patches");
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
  return names.map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]);
}

export function worktreeInputs(root) {
  const lockfile = readIfExists(path.join(root, "pnpm-lock.yaml"));
  if (lockfile === null) throw new Error(`${root} has no pnpm-lock.yaml`);
  return { lockfile, workspace: readIfExists(path.join(root, "pnpm-workspace.yaml")) ?? "", patches: readPatches(root) };
}

export function installedInputs(root) {
  const lockfile = readIfExists(path.join(root, "node_modules", ".pnpm", "lock.yaml"));
  if (lockfile === null) return null;
  return { lockfile, workspace: readIfExists(path.join(root, "pnpm-workspace.yaml")) ?? "", patches: readPatches(root) };
}

export function chooseSource({ mode, worktreeKey, sharedKey }) {
  if (mode !== "shared") return "cache";
  if (sharedKey === null || sharedKey !== worktreeKey) {
    throw new Error("the shared checkout's installed dependencies don't match this worktree's lockfile, workspace settings and patches; drop --deps shared to use the cache");
  }
  return "shared";
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
          warnings.push(`${entry.name}/${name} in ${sourceDir} points outside its checkout (${link}); not linked`);
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
    return { broken: true };
  }
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

function prepareTarget(worktree, projects, replace) {
  const dirs = projects.map((project) => path.join(worktree, project, "node_modules")).filter((dir) => lstatOrNull(dir));
  if (markerOf(worktree) === null) {
    if (dirs.length && !replace) {
      const what = lstatOrNull(dirs[0]).isSymbolicLink() ? "is a link to a whole node_modules" : "is its own install";
      throw new Error(`${dirs[0]} ${what}; pass --replace to swap it for per-entry links`);
    }
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  for (const dir of dirs) {
    if (lstatOrNull(dir).isSymbolicLink()) {
      fs.rmSync(dir);
      continue;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.name.startsWith(".") || LINKED_DOT_ENTRIES.has(entry.name) || entry.name === MARKER) {
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
  throw new Error("pnpm install is blocked in a worktree linked by scripts/agent/worktree-setup");
}
module.exports = { hooks: { preResolution: blocked, readPackage: blocked } };
`;

function writeGuard(worktree) {
  const file = path.join(worktree, GUARD_FILE);
  const tracked = spawnSync("git", ["-C", worktree, "ls-files", "--error-unmatch", GUARD_FILE], { stdio: "ignore" }).status === 0;
  if (tracked) return `the worktree tracks its own ${GUARD_FILE}; pnpm install is NOT blocked there`;
  fs.writeFileSync(file, GUARD_SOURCE);
  return null;
}

function excludeFromGit(worktree, names) {
  const result = spawnSync("git", ["-C", worktree, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const file = path.resolve(worktree, result.stdout.trim());
  const current = readIfExists(file) ?? "";
  const lines = new Set(current.split(/\r?\n/));
  const missing = names.map((name) => `/${name}`).filter((line) => !lines.has(line));
  if (missing.length === 0) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
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

export function defaultShared() {
  const result = spawnSync("git", ["-C", here, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const common = result.stdout.trim();
  return path.basename(common) === ".git" ? path.dirname(common) : null;
}

export function defaultCacheRoot() {
  return process.env.ARDIA_DEPS_CACHE || path.join(os.homedir(), "ardia-scratch", "deps.noindex");
}

function nodeModulesDirsOf(root) {
  return [path.join(root, "node_modules"), ...listDirs(root).flatMap((top) => listDirs(path.join(root, top)).map((name) => path.join(root, top, name, "node_modules")))].filter((dir) => fs.existsSync(dir));
}

export function installWithPnpm({ staging, final }) {
  const log = path.join(staging, "install.log");
  const script = `[ -e "$1/${CACHE_STAMP}" ] && exit 0; cd "$2" && exec pnpm install --frozen-lockfile --prefer-offline --package-import-method=clone-or-copy --reporter=append-only >"$3" 2>&1`;
  const result = spawnSync(lockedScript, ["pod", "--wait", "500", "--", "sh", "-c", script, "sh", final, staging, log], { stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) {
    const tail = (readIfExists(log) ?? "").split("\n").slice(-20).join("\n");
    throw new Error(`pnpm install for the dependency cache failed (exit ${result.status}); the end of ${log}:\n${tail}`);
  }
}

function copyInputs(worktree, staging, projects) {
  const files = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ...projects.filter(Boolean).map((p) => `${p}/package.json`)];
  for (const file of files) {
    const from = path.join(worktree, file);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(path.join(staging, file)), { recursive: true });
    fs.copyFileSync(from, path.join(staging, file));
  }
  const patches = path.join(worktree, "patches");
  if (fs.existsSync(patches)) fs.cpSync(patches, path.join(staging, "patches"), { recursive: true });
}

function setWritable(dirs, writable) {
  if (dirs.length === 0) return;
  execFileSync("chmod", ["-R", writable ? "u+w" : "a-w", ...dirs]);
}

export function removeTree(dir) {
  if (!fs.existsSync(dir)) return;
  spawnSync("chmod", ["-R", "u+w", dir]);
  fs.rmSync(dir, { recursive: true, force: true });
}

export function ensureCache({ worktree, key, cacheRoot, projects, install = installWithPnpm, log = () => {} }) {
  const final = path.join(cacheRoot, key);
  const stamp = path.join(final, CACHE_STAMP);
  if (fs.existsSync(stamp)) {
    fs.utimesSync(stamp, new Date(), new Date());
    return { dir: final, created: false };
  }
  fs.mkdirSync(cacheRoot, { recursive: true });
  dropNeverIndex(cacheRoot);
  const staging = path.join(cacheRoot, `.staging-${key}-${process.pid}`);
  removeTree(staging);
  fs.mkdirSync(staging, { recursive: true });
  try {
    copyInputs(worktree, staging, projects);
    log(`installing ${key} into ${cacheRoot} (once per lockfile, under scripts/agent/locked pod)`);
    install({ staging, final });
    if (fs.existsSync(stamp)) {
      removeTree(staging);
      return { dir: final, created: false };
    }
    const installed = readIfExists(path.join(staging, "node_modules", ".pnpm", "lock.yaml"));
    const wanted = normalizeLockfile(fs.readFileSync(path.join(worktree, "pnpm-lock.yaml"), "utf8"));
    if (installed === null || normalizeLockfile(installed) !== wanted) throw new Error("the cache install's lockfile doesn't match the worktree's");
    setWritable(nodeModulesDirsOf(staging), false);
    fs.writeFileSync(path.join(staging, CACHE_STAMP), `${JSON.stringify({ key, created: new Date().toISOString(), from: worktree }, null, 2)}\n`);
    try {
      fs.renameSync(staging, final);
    } catch (error) {
      if (!fs.existsSync(stamp)) throw error;
      removeTree(staging);
    }
    return { dir: final, created: true };
  } catch (error) {
    removeTree(staging);
    throw error;
  }
}

export function setupWorktree(worktreeArg, options = {}) {
  const started = Date.now();
  const log = options.log ?? console.log;
  const worktree = fs.realpathSync(worktreeArg);
  const mode = options.deps ?? "cache";
  if (!["shared", "cache"].includes(mode)) throw new Error(`--deps takes cache or shared, not ${mode}`);
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot();
  const sharedArg = options.shared === undefined ? defaultShared() : options.shared;
  const shared = sharedArg && fs.existsSync(sharedArg) ? fs.realpathSync(sharedArg) : null;
  if (shared && shared === worktree) throw new Error(`${worktree} is the shared checkout itself; it keeps its own pnpm install`);

  const inputs = worktreeInputs(worktree);
  const key = dependencyKey(inputs);
  const sharedInputs = mode === "shared" && shared ? installedInputs(shared) : null;
  const sharedKey = sharedInputs ? dependencyKey(sharedInputs) : null;
  const kind = chooseSource({ mode, worktreeKey: key, sharedKey });
  const projects = workspaceProjects(worktree, inputs.workspace);

  let sourceRoot = shared;
  let createdCache = false;
  if (kind === "cache") {
    const cache = ensureCache({ worktree, key, cacheRoot, projects, install: options.install, log });
    sourceRoot = fs.realpathSync(cache.dir);
    createdCache = cache.created;
  }

  prepareTarget(worktree, projects, options.replace ?? false);
  const rootModules = path.join(worktree, "node_modules");
  fs.mkdirSync(rootModules, { recursive: true });
  const marker = { version: MARKER_VERSION, key, source: kind, root: sourceRoot, nodeModules: [], projects: [], state: "linking", created: new Date().toISOString() };
  const markerFile = path.join(rootModules, MARKER);
  fs.writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`);

  let links = 0;
  const warnings = [];
  for (const project of projects) {
    const sourceDir = path.join(sourceRoot, project, "node_modules");
    if (!fs.existsSync(sourceDir)) continue;
    const plan = planLinks({ sourceRoot, worktreeRoot: worktree, project, entries: readEntries(sourceDir) });
    links += applyOps(plan.ops);
    warnings.push(...plan.warnings);
    marker.nodeModules.push(sourceDir);
    marker.projects.push(project);
  }
  marker.state = "linked";
  fs.writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`);

  const guardWarning = writeGuard(worktree);
  if (guardWarning) warnings.push(guardWarning);
  const neverIndexed = [worktree, cacheRoot, path.join(os.homedir(), "ardia-scratch"), path.join(os.homedir(), "ardia-wt")].filter(dropNeverIndex);
  const exclude = excludeFromGit(worktree, [GUARD_FILE, NEVER_INDEX]);

  const ms = Date.now() - started;
  log(`worktree-setup: ${worktree}`);
  log(`  dependencies: ${kind === "shared" ? "the shared checkout" : createdCache ? "a new cached install" : "the cached install"} ${sourceRoot} (key ${key})`);
  log(`  linked ${links} entries in ${marker.projects.length} node_modules folders (${marker.projects.map((p) => p || ".").join(", ")}) in ${ms} ms`);
  log(`  pnpm install is blocked by ${GUARD_FILE}; marker ${markerFile}`);
  if (neverIndexed.length) log(`  added ${NEVER_INDEX} to ${neverIndexed.join(", ")}`);
  if (exclude) log(`  ${GUARD_FILE} and ${NEVER_INDEX} are listed in ${exclude}`);
  for (const warning of warnings) log(`  warning: ${warning}`);
  log(`  undo: scripts/agent/worktree-setup --undo ${worktree}`);
  return { worktree, key, kind, sourceRoot, links, projects: marker.projects, warnings, ms, createdCache };
}

export function undoWorktree(worktreeArg, { log = console.log } = {}) {
  const worktree = fs.realpathSync(worktreeArg);
  const marker = markerOf(worktree);
  if (!marker) throw new Error(`${worktree} isn't linked by worktree-setup (no node_modules/${MARKER})`);
  const projects = new Set(["", ...(marker.projects ?? [])]);
  for (const project of [...projects].sort().reverse()) fs.rmSync(path.join(worktree, project, "node_modules"), { recursive: true, force: true });
  const guard = path.join(worktree, GUARD_FILE);
  if (readIfExists(guard) === GUARD_SOURCE) fs.rmSync(guard);
  log(`worktree-setup: removed the links in ${worktree} (${[...projects].map((p) => p || ".").join(", ")}) and its pnpm guard; ${marker.root} is untouched`);
}

export function worktreeStatus(worktreeArg) {
  const worktree = fs.realpathSync(worktreeArg);
  const marker = markerOf(worktree);
  if (!marker) return { linked: false, worktree, problems: [`no node_modules/${MARKER}`] };
  const problems = [];
  const key = dependencyKey(worktreeInputs(worktree));
  if (key !== marker.key) problems.push(`the worktree's lockfile, workspace settings or patches changed (key ${key}, linked ${marker.key}); run worktree-setup again`);
  if (marker.source === "shared") {
    const inputs = installedInputs(marker.root);
    const now = inputs ? dependencyKey(inputs) : null;
    if (now !== marker.key) problems.push(`the shared checkout's install moved to ${now ?? "nothing"}; run worktree-setup again (--deps cache to stop following it)`);
  } else if (!fs.existsSync(path.join(marker.root, CACHE_STAMP))) {
    problems.push(`the cached install ${marker.root} is gone; run worktree-setup again`);
  }
  if (marker.state !== "linked") problems.push("setup didn't finish; run worktree-setup again");
  if (!fs.existsSync(path.join(worktree, GUARD_FILE))) problems.push(`${GUARD_FILE} is missing, so pnpm install isn't blocked`);
  return { linked: true, worktree, marker, key, problems };
}

function linkedWorktrees(shared) {
  if (!shared) return [];
  const result = spawnSync("git", ["-C", shared, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
}

export function pruneCaches({ cacheRoot = defaultCacheRoot(), shared = defaultShared(), olderThanDays = 7, extraWorktrees = [], now = Date.now(), log = console.log } = {}) {
  const used = new Set();
  for (const worktree of [...linkedWorktrees(shared), ...extraWorktrees]) {
    const marker = markerOf(worktree);
    if (marker?.source === "cache" && marker.root) used.add(path.basename(marker.root));
  }
  const removed = [];
  for (const name of listDirs(cacheRoot)) {
    const dir = path.join(cacheRoot, name);
    const stamp = lstatOrNull(path.join(dir, CACHE_STAMP));
    const stale = name.startsWith(".staging-") ? now - fs.statSync(dir).mtimeMs > DAY_MS : stamp && now - stamp.mtimeMs > olderThanDays * DAY_MS;
    if (!stale || used.has(name)) continue;
    removeTree(dir);
    removed.push(dir);
  }
  log(removed.length ? `worktree-setup: removed ${removed.join(", ")}` : `worktree-setup: nothing to prune in ${cacheRoot}`);
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
      case "--deps":
        options.deps = value();
        break;
      case "--shared":
        options.shared = value();
        break;
      case "--cache":
        options.cacheRoot = value();
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
  if (options.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.command === "prune") {
    pruneCaches({ cacheRoot: options.cacheRoot, olderThanDays: options.olderThanDays ?? 7, ...(options.shared ? { shared: options.shared } : {}) });
    return 0;
  }
  const [worktree, ...rest] = options.positional;
  if (!worktree || rest.length) {
    process.stderr.write(HELP);
    return 64;
  }
  if (options.command === "undo") {
    undoWorktree(worktree);
    return 0;
  }
  if (options.command === "status") {
    const status = worktreeStatus(worktree);
    if (!status.linked) console.log(`worktree-setup: ${status.worktree} isn't linked`);
    else console.log(`worktree-setup: ${status.worktree} uses ${status.marker.source === "shared" ? "the shared checkout" : "the cached install"} ${status.marker.root} (key ${status.marker.key})`);
    for (const problem of status.problems) console.log(`  ${problem}`);
    return status.linked && status.problems.length === 0 ? 0 : 1;
  }
  setupWorktree(worktree, options);
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`worktree-setup: ${error.message}\n`);
    process.exitCode = 1;
  }
}
