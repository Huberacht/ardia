import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CACHE_STAMP,
  GUARD_FILE,
  GUARD_SOURCE,
  MARKER,
  USERS_DIR,
  buildCache,
  dependencyKey,
  installInputs,
  normalizeLockfile,
  planLinks,
  pruneCaches,
  claimCache,
  removeTree,
  runtimeOf,
  setupWorktree,
  undoWorktree,
  withKernelLock,
  workspacePatterns,
  workspaceProjects,
  worktreeStatus,
} from "./worktree-deps.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "worktree-deps-")));
test.after(() => removeTree(root));

const ENV_DOC = "---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    packageManagerDependencies:\n      pnpm:\n        version: 12.21.0\n\n";
const MAIN_DOC = "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: false\n";
const LOCKFILE = `${ENV_DOC}---\n${MAIN_DOC}`;
const WORKSPACE = 'packages:\n  - apps/*\n  - packages/*\n  - "!apps/docs"\n\nnodeLinker: hoisted\n';
const PROJECTS = ["apps/web", "apps/docs", "packages/base", "packages/kit"];
const RUNTIME = "darwin-arm64-node24";

const write = (file, text = "") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
let serial = 0;
const fresh = (name) => path.join(root, `${name}-${serial++}`);
const quiet = () => {};

function makeWorktree({ patch = "patch v1\n" } = {}) {
  const dir = fresh("worktree");
  write(path.join(dir, "package.json"), '{"name":"ardia","private":true}');
  write(path.join(dir, "pnpm-lock.yaml"), LOCKFILE);
  write(path.join(dir, "pnpm-workspace.yaml"), WORKSPACE);
  write(path.join(dir, "patches", "left-pad@1.0.0.patch"), patch);
  for (const project of PROJECTS) write(path.join(dir, project, "package.json"), `{"name":"@ardia/${path.basename(project)}"}`);
  return dir;
}

function fakeInstall(dir) {
  const nm = path.join(dir, "node_modules");
  write(path.join(nm, ".pnpm", "lock.yaml"), normalizeLockfile(fs.readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8")));
  write(path.join(nm, ".modules.yaml"), "layoutVersion: 5\n");
  write(path.join(nm, ".cache", "stale"), "x");
  write(path.join(nm, "react", "index.js"), "module.exports = 'react from the tree';\n");
  write(path.join(nm, "@babel", "core", "package.json"), '{"name":"@babel/core"}');
  write(path.join(nm, "typescript", "bin", "tsc"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(nm, ".bin"), { recursive: true });
  fs.symlinkSync("../typescript/bin/tsc", path.join(nm, ".bin", "tsc"));
  fs.mkdirSync(path.join(nm, "@ardia"), { recursive: true });
  for (const project of ["apps/web", "packages/base", "packages/kit"]) fs.symlinkSync(`../../${project}`, path.join(nm, "@ardia", path.basename(project)));
  write(path.join(dir, "apps", "web", "node_modules", "react-refresh", "package.json"), '{"name":"react-refresh"}');
  fs.mkdirSync(path.join(dir, "apps", "web", "node_modules", "@ardia"), { recursive: true });
  fs.symlinkSync("../../../../packages/base", path.join(dir, "apps", "web", "node_modules", "@ardia", "base"));
}

function harness() {
  const cacheRoot = fresh("cache");
  const installs = [];
  const install = (staging) => {
    installs.push(staging);
    fakeInstall(staging);
  };
  const build = ({ worktree, cacheRoot: cache, runtime }) => buildCache({ worktree, cacheRoot: cache, runtime, install });
  const setup = (worktree, extra = {}) => setupWorktree(worktree, { cacheRoot, build, runtime: RUNTIME, log: quiet, ...extra });
  return { cacheRoot, installs, setup };
}

const snapshot = (dir) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => `${path.relative(dir, path.join(e.parentPath, e.name))}:${e.isSymbolicLink() ? "l" : e.isDirectory() ? "d" : "f"}`)
    .sort()
    .join("\n");

test("pnpm's installed lockfile reads as the worktree's once the package-manager document is set aside", () => {
  assert.equal(normalizeLockfile(LOCKFILE), MAIN_DOC);
  assert.equal(normalizeLockfile(MAIN_DOC), MAIN_DOC);
});

test("the key covers every install input: lockfile, .npmrc, workspace settings, each manifest, patches and runtime", () => {
  const dir = makeWorktree();
  const key = () => dependencyKey(installInputs(dir, RUNTIME));
  const base = key();
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(dependencyKey({ ...installInputs(dir, RUNTIME), files: [...installInputs(dir, RUNTIME).files].reverse() }), base);
  write(path.join(dir, "apps", "docs", "package.json"), '{"name":"@ardia/docs","dependencies":{"astro":"5"}}');
  assert.equal(key(), base, "a project outside the workspace isn't an input");
  const changes = [
    [() => write(path.join(dir, "pnpm-lock.yaml"), `${ENV_DOC.replace("12.21.0", "12.22.0")}---\n${MAIN_DOC}`), "the package-manager document"],
    [() => write(path.join(dir, ".npmrc"), "node-linker=isolated\n"), ".npmrc"],
    [() => write(path.join(dir, "pnpm-workspace.yaml"), WORKSPACE.replace("hoisted", "isolated")), "workspace settings"],
    [() => write(path.join(dir, "package.json"), '{"name":"ardia","scripts":{"postinstall":"node x"}}'), "the root manifest"],
    [() => write(path.join(dir, "packages", "kit", "package.json"), '{"name":"@ardia/kit","dependencies":{"left-pad":"1"}}'), "a workspace manifest"],
    [() => write(path.join(dir, "patches", "left-pad@1.0.0.patch"), "patch v2\n"), "a patch"],
    [() => write(path.join(dir, "patches", "other@1.0.0.patch"), "new\n"), "a new patch"],
  ];
  let previous = base;
  for (const [change, what] of changes) {
    change();
    const next = key();
    assert.notEqual(next, previous, what);
    previous = next;
  }
  assert.notEqual(dependencyKey(installInputs(dir, "linux-x64-node24")), previous, "the platform and CPU");
  assert.notEqual(dependencyKey(installInputs(dir, "darwin-arm64-node26")), previous, "the Node major version");
  assert.equal(runtimeOf({ platform: "darwin", arch: "arm64", versions: { node: "24.22.2" } }), "darwin-arm64-node24");
});

test("workspace projects follow pnpm-workspace.yaml, negations included", () => {
  assert.deepEqual(workspacePatterns(WORKSPACE), ["apps/*", "packages/*", "!apps/docs"]);
  const dir = makeWorktree();
  fs.mkdirSync(path.join(dir, "packages", "no-manifest"), { recursive: true });
  assert.deepEqual(workspaceProjects(dir, WORKSPACE), ["", "apps/web", "packages/base", "packages/kit"]);
});

test("link plan: entries link to the tree, pnpm state and caches stay out, @ardia points into the worktree", () => {
  const entries = [
    { name: ".bin", kind: "dir" },
    { name: ".cache", kind: "dir" },
    { name: ".modules.yaml", kind: "file" },
    { name: ".pnpm", kind: "dir" },
    { name: "@ardia", kind: "workspace-scope", links: [{ name: "base", link: "../../../../packages/base" }, { name: "gone", link: "../../../../packages/gone" }, { name: "out", link: "../../../../../elsewhere" }] },
    { name: "@babel", kind: "dir" },
    { name: "react", kind: "dir" },
  ];
  const { ops, warnings } = planLinks({ sourceRoot: "/tree", worktreeRoot: "/wt", project: "apps/web", entries, exists: (p) => p === "/wt/packages/base" });
  assert.deepEqual(ops, [
    { type: "mkdir", path: "/wt/apps/web/node_modules" },
    { type: "symlink", path: "/wt/apps/web/node_modules/.bin", target: "/tree/apps/web/node_modules/.bin" },
    { type: "mkdir", path: "/wt/apps/web/node_modules/@ardia" },
    { type: "symlink", path: "/wt/apps/web/node_modules/@ardia/base", target: "../../../../packages/base" },
    { type: "symlink", path: "/wt/apps/web/node_modules/@babel", target: "/tree/apps/web/node_modules/@babel" },
    { type: "symlink", path: "/wt/apps/web/node_modules/react", target: "/tree/apps/web/node_modules/react" },
  ]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /no packages\/gone/);
  assert.match(warnings[1], /outside its tree/);
});

test("setup installs once per key into a read-only cache, links the worktree into it, and records the worktree", () => {
  const { cacheRoot, installs, setup } = harness();
  const first = makeWorktree();
  const result = setup(first);
  assert.equal(result.createdCache, true);
  assert.equal(installs.length, 1);
  assert.equal(result.sourceRoot, path.join(fs.realpathSync(cacheRoot), result.key));
  const stamp = JSON.parse(fs.readFileSync(path.join(result.sourceRoot, CACHE_STAMP), "utf8"));
  assert.equal(stamp.key, result.key);
  assert.equal(stamp.runtime, RUNTIME);
  assert.ok(stamp.files[".npmrc"] === undefined && stamp.files["packages/kit/package.json"], "the stamp records the inputs it was built from");
  assert.deepEqual(result.projects, ["", "apps/web"]);
  assert.equal(fs.readlinkSync(path.join(first, "node_modules", "react")), path.join(result.sourceRoot, "node_modules", "react"));
  assert.equal(fs.realpathSync(path.join(first, "node_modules", ".bin", "tsc")), path.join(result.sourceRoot, "node_modules", "typescript", "bin", "tsc"));
  assert.equal(fs.realpathSync(path.join(first, "node_modules", "@ardia", "base")), path.join(first, "packages", "base"));
  assert.equal(fs.realpathSync(path.join(first, "apps", "web", "node_modules", "@ardia", "base")), path.join(first, "packages", "base"));
  for (const local of [".cache", ".pnpm", ".modules.yaml"]) assert.ok(!fs.existsSync(path.join(first, "node_modules", local)), local);
  assert.ok(!fs.existsSync(path.join(first, "apps", "docs", "node_modules")), "apps/docs is outside the workspace");
  if (process.getuid?.() !== 0) {
    assert.throws(() => fs.writeFileSync(path.join(first, "node_modules", "react", "index.js"), "through the link"), { code: "EACCES" });
    assert.throws(() => fs.mkdirSync(path.join(first, "node_modules", "@babel", "new-package")), { code: "EACCES" });
  }
  assert.equal(fs.readFileSync(path.join(first, GUARD_FILE), "utf8"), GUARD_SOURCE);
  assert.ok(fs.existsSync(path.join(first, ".metadata_never_index")));
  assert.equal(fs.readdirSync(path.join(cacheRoot, USERS_DIR)).length, 1);
  assert.deepEqual(fs.readdirSync(cacheRoot).filter((n) => n.startsWith(".staging")), []);
  assert.deepEqual(worktreeStatus(first, { runtime: RUNTIME }).problems, []);

  const again = setup(makeWorktree());
  assert.equal(again.sourceRoot, result.sourceRoot);
  assert.equal(again.createdCache, false);
  assert.equal(installs.length, 1);
  assert.equal(setup(makeWorktree({ patch: "patch v2\n" })).createdCache, true);
  assert.equal(installs.length, 2);
});

test("a relative --cache works", () => {
  const { setup } = harness();
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const result = setup(makeWorktree(), { cacheRoot: "relative-cache" });
    assert.equal(result.sourceRoot, path.join(root, "relative-cache", result.key));
  } finally {
    process.chdir(cwd);
  }
});

test("setup refuses someone else's pnpmfile before changing anything, and undo keeps a pnpmfile it didn't write", () => {
  const { cacheRoot, installs, setup } = harness();
  const worktree = makeWorktree();
  write(path.join(worktree, GUARD_FILE), "module.exports = { hooks: {} };\n");
  assert.throws(() => setup(worktree), /someone else's pnpmfile/);
  assert.equal(installs.length, 0);
  assert.ok(!fs.existsSync(path.join(worktree, "node_modules")));
  assert.ok(!fs.existsSync(path.join(cacheRoot, USERS_DIR)));
  write(path.join(worktree, GUARD_FILE), 'function blocked() {\n  throw new Error("pnpm install is blocked in a worktree linked by scripts/agent/worktree-setup");\n}\n');
  setup(worktree);
  assert.equal(fs.readFileSync(path.join(worktree, GUARD_FILE), "utf8"), GUARD_SOURCE, "an older guard of ours is replaced");
  setup(worktree);
  write(path.join(worktree, GUARD_FILE), "edited by hand\n");
  undoWorktree(worktree, { log: quiet });
  assert.equal(fs.readFileSync(path.join(worktree, GUARD_FILE), "utf8"), "edited by hand\n");
});

test("setup refuses a worktree's own node_modules unless --replace, and reruns in place", () => {
  const { setup } = harness();
  const worktree = makeWorktree();
  write(path.join(worktree, "node_modules", "real-install", "index.js"), "x");
  assert.throws(() => setup(worktree), /its own install; pass --replace/);
  const elsewhere = fresh("whole-tree");
  write(path.join(elsewhere, "react", "index.js"), "x");
  const whole = makeWorktree();
  fs.symlinkSync(elsewhere, path.join(whole, "node_modules"));
  assert.throws(() => setup(whole), /link to a whole node_modules/);
  const before = snapshot(elsewhere);
  setup(whole, { replace: true });
  assert.equal(snapshot(elsewhere), before, "replacing a whole-folder link never deletes through it");
  assert.ok(fs.lstatSync(path.join(whole, "node_modules")).isDirectory());

  const result = setup(worktree, { replace: true });
  write(path.join(worktree, "apps", "web", "node_modules", ".cache", "ardia-test-tsx", "a.mjs"), "cached");
  write(path.join(worktree, "node_modules", "react_pacquet-stage_1", "index.js"), "left by a bypassed pnpm install");
  fs.rmSync(path.join(worktree, "node_modules", "@babel"));
  write(path.join(worktree, "node_modules", "@babel", "core", "index.js"), "a real copy");
  setup(worktree);
  assert.ok(fs.existsSync(path.join(worktree, "apps", "web", "node_modules", ".cache", "ardia-test-tsx", "a.mjs")), "local caches survive a rerun");
  assert.ok(!fs.existsSync(path.join(worktree, "node_modules", "react_pacquet-stage_1")));
  assert.ok(fs.lstatSync(path.join(worktree, "node_modules", "@babel")).isSymbolicLink());
  assert.equal(fs.readlinkSync(path.join(worktree, "node_modules", "react")), path.join(result.sourceRoot, "node_modules", "react"));
});

test("the marker names every managed folder before the first link, so undo cleans an interrupted setup", (t) => {
  const { setup } = harness();
  const worktree = makeWorktree();
  setup(makeWorktree());
  const realSymlink = fs.symlinkSync;
  let seen = null;
  t.mock.method(fs, "symlinkSync", (target, file) => {
    seen ??= JSON.parse(fs.readFileSync(path.join(worktree, "node_modules", MARKER), "utf8"));
    if (file.includes(`${path.sep}apps${path.sep}web${path.sep}`)) throw new Error("interrupted");
    return realSymlink(target, file);
  });
  assert.throws(() => setup(worktree), /interrupted/);
  t.mock.restoreAll();
  assert.deepEqual(seen.projects, ["", "apps/web"]);
  assert.equal(seen.state, "linking");
  assert.match(worktreeStatus(worktree, { runtime: RUNTIME }).problems.join("\n"), /didn't finish/);
  undoWorktree(worktree, { log: quiet });
  for (const gone of ["node_modules", "apps/web/node_modules", GUARD_FILE]) assert.ok(!fs.existsSync(path.join(worktree, gone)), gone);
});

test("re-setup removes the links of a project the workspace no longer lists", () => {
  const { setup } = harness();
  const worktree = makeWorktree();
  assert.deepEqual(setup(worktree).projects, ["", "apps/web"]);
  write(path.join(worktree, "pnpm-workspace.yaml"), WORKSPACE.replace('"!apps/docs"', '"!apps/docs"\n  - "!apps/web"'));
  const result = setup(worktree);
  assert.deepEqual(result.projects, [""]);
  assert.ok(!fs.existsSync(path.join(worktree, "apps", "web", "node_modules")));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(worktree, "node_modules", MARKER), "utf8")).projects, [""]);
});

test("status notices changed inputs, and undo removes the worktree's links and record but not the tree", () => {
  const { cacheRoot, setup } = harness();
  const worktree = makeWorktree();
  const result = setup(worktree);
  write(path.join(worktree, ".npmrc"), "save-exact=true\n");
  assert.match(worktreeStatus(worktree, { runtime: RUNTIME }).problems.join("\n"), /install inputs changed/);
  const before = snapshot(result.sourceRoot);
  undoWorktree(worktree, { log: quiet });
  for (const gone of ["node_modules", "apps/web/node_modules", GUARD_FILE]) assert.ok(!fs.existsSync(path.join(worktree, gone)), gone);
  assert.equal(snapshot(result.sourceRoot), before);
  assert.deepEqual(fs.readdirSync(path.join(cacheRoot, USERS_DIR)), []);
  assert.throws(() => undoWorktree(worktree, { log: quiet }), /isn't linked/);
});

test("prune keeps a cache any recorded worktree or scratch export still links, git worktree or not", () => {
  const { cacheRoot, setup } = harness();
  const exported = makeWorktree({ patch: "export\n" });
  const exportKey = setup(exported).key;
  const idle = makeWorktree({ patch: "idle\n" });
  const idleKey = setup(idle).key;
  undoWorktree(idle, { log: quiet });
  const moved = makeWorktree({ patch: "moved\n" });
  const movedKey = setup(moved).key;
  undoWorktree(moved, { log: quiet });
  setup(moved, { replace: true });
  const later = Date.now() + 10 * 24 * 60 * 60 * 1000;
  assert.deepEqual(pruneCaches({ cacheRoot, now: Date.now(), log: quiet }), []);
  const removed = pruneCaches({ cacheRoot, now: later, log: quiet });
  assert.deepEqual(removed, [path.join(cacheRoot, idleKey)]);
  assert.ok(fs.existsSync(path.join(cacheRoot, exportKey, CACHE_STAMP)));
  assert.ok(fs.existsSync(path.join(cacheRoot, movedKey, CACHE_STAMP)));
  assert.equal(fs.readlinkSync(path.join(exported, "node_modules", "react")).startsWith(fs.realpathSync(cacheRoot)), true);
  assert.ok(fs.existsSync(path.join(exported, "node_modules", "react", "index.js")));
});

const childLock = (lockFile, holdMs) =>
  spawn(process.execPath, ["--input-type=module", "-e", `import { withKernelLock } from ${JSON.stringify(path.join(here, "worktree-deps.mjs"))}; withKernelLock(${JSON.stringify(lockFile)}, () => { process.stdout.write("held\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs}); });`], { stdio: ["ignore", "pipe", "inherit"] });
const once = (stream, text) => new Promise((resolve) => stream.on("data", (d) => String(d).includes(text) && resolve()));

test("the kernel lock admits one holder at a time and frees itself when its holder dies", async () => {
  const lockFile = path.join(fresh("lock"), "registry.lock");
  assert.equal(withKernelLock(lockFile, () => 7), 7);
  const holder = childLock(lockFile, 1500);
  await once(holder.stdout, "held");
  const started = Date.now();
  assert.throws(() => withKernelLock(lockFile, () => 1, { waitSeconds: 0 }), /still held/);
  assert.equal(withKernelLock(lockFile, () => 2), 2);
  assert.ok(Date.now() - started >= 900, "waited for the holder");
  const crashed = childLock(lockFile, 60000);
  await once(crashed.stdout, "held");
  crashed.kill("SIGKILL");
  await new Promise((resolve) => crashed.on("close", resolve));
  const again = Date.now();
  assert.equal(withKernelLock(lockFile, () => 3, { waitSeconds: 5 }), 3);
  assert.ok(Date.now() - again < 2000, "a dead holder's lock is free at once");
});

test("a failed re-setup keeps its old cache claimed, so prune never deletes what the worktree still links", () => {
  const { cacheRoot, setup } = harness();
  const worktree = makeWorktree();
  const first = setup(worktree);
  write(path.join(worktree, "patches", "left-pad@1.0.0.patch"), "patch v2\n");
  assert.throws(() => setup(worktree, { build: () => { throw new Error("build failed"); } }), /build failed/);
  const later = Date.now() + 10 * 24 * 60 * 60 * 1000;
  assert.deepEqual(pruneCaches({ cacheRoot, now: later, log: quiet }), []);
  assert.ok(fs.existsSync(path.join(worktree, "node_modules", "react", "index.js")));
  const second = setup(worktree);
  assert.notEqual(second.key, first.key);
  const record = JSON.parse(fs.readFileSync(path.join(cacheRoot, USERS_DIR, fs.readdirSync(path.join(cacheRoot, USERS_DIR))[0]), "utf8"));
  assert.deepEqual(record.keys, [second.key], "the old claim goes once the marker names the new cache");
  assert.deepEqual(pruneCaches({ cacheRoot, now: later, log: quiet }), [path.join(cacheRoot, first.key)]);
});

test("prune holds the registry lock throughout, a claim needs the cache to still be there, and a vanished record is skipped", (t) => {
  const { cacheRoot, setup } = harness();
  const kept = makeWorktree();
  const result = setup(kept);
  let probed = false;
  const realLstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (file, ...rest) => {
    if (!probed && String(file).endsWith(CACHE_STAMP)) {
      probed = true;
      assert.throws(() => withKernelLock(path.join(cacheRoot, ".registry.lock"), () => 0, { waitSeconds: 0 }), /still held/);
    }
    return realLstat(file, ...rest);
  });
  const realRead = fs.readFileSync;
  let vanished = false;
  t.mock.method(fs, "readFileSync", (file, ...rest) => {
    if (!vanished && String(file).includes(`${USERS_DIR}${path.sep}`)) {
      vanished = true;
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    }
    return realRead(file, ...rest);
  });
  write(path.join(cacheRoot, "0000000000000000", CACHE_STAMP), "{}");
  pruneCaches({ cacheRoot, log: quiet });
  t.mock.restoreAll();
  assert.ok(probed && vanished);
  removeTree(path.join(cacheRoot, result.key));
  assert.throws(() => claimCache(cacheRoot, kept, result.key), /isn't built \(or was just pruned\)/);
});

test("prune follows a git worktree that moved, and the record moves with it", () => {
  const { cacheRoot, setup } = harness();
  const repo = fresh("repo");
  fs.mkdirSync(repo);
  const git = (...args) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  git("init", "-q");
  const scratch = makeWorktree();
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "patches"]) fs.cpSync(path.join(scratch, name), path.join(repo, name), { recursive: true });
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const linked = path.join(fresh("wt"), "linked");
  git("worktree", "add", "-q", linked);
  const result = setup(linked);
  const moved = path.join(path.dirname(linked), "moved");
  assert.equal(git("worktree", "move", linked, moved).status, 0);
  const later = Date.now() + 10 * 24 * 60 * 60 * 1000;
  assert.deepEqual(pruneCaches({ cacheRoot, now: later, log: quiet }), []);
  const records = fs.readdirSync(path.join(cacheRoot, USERS_DIR)).map((name) => JSON.parse(fs.readFileSync(path.join(cacheRoot, USERS_DIR, name), "utf8")));
  assert.deepEqual(records.map((r) => r.worktree), [fs.realpathSync(moved)]);
  assert.ok(fs.existsSync(path.join(cacheRoot, result.key, CACHE_STAMP)));
});

test("the cache is installed from the exact bytes its key was computed from", (t) => {
  const { setup } = harness();
  const worktree = makeWorktree();
  const realWrite = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (file, ...rest) => {
    if (String(file).includes(".staging-") && String(file).endsWith(".patch")) realWrite(path.join(worktree, "patches", "left-pad@1.0.0.patch"), "edited after hashing\n");
    return realWrite(file, ...rest);
  });
  const result = setup(worktree);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(path.join(result.sourceRoot, "patches", "left-pad@1.0.0.patch"), "utf8"), "patch v1\n");
  assert.equal(dependencyKey(installInputs(result.sourceRoot, RUNTIME)), result.key);
});

const hasLock = spawnSync("sh", ["-c", "command -v lockf || command -v flock"]).status === 0;

test("concurrent setups on one new key build it once under the pod lock, and exclude rules aren't duplicated", { skip: !hasLock && "no lockf or flock" }, async () => {
  const dir = fresh("concurrent");
  const bin = path.join(dir, "bin");
  write(path.join(bin, "pnpm"), `#!/bin/sh\necho install >> "${dir}/installs"\nmkdir -p node_modules/.pnpm node_modules/x && cp pnpm-lock.yaml node_modules/.pnpm/lock.yaml && echo 1 > node_modules/x/index.js\nsleep 1\n`);
  fs.chmodSync(path.join(bin, "pnpm"), 0o755);
  fs.mkdirSync(path.join(dir, "locks"));
  const repo = path.join(dir, "repo");
  spawnSync("git", ["init", "-q", repo]);
  const worktrees = [0, 1, 2].map((n) => {
    const worktree = path.join(repo, `w${n}`);
    for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) write(path.join(worktree, file), file === "pnpm-lock.yaml" ? LOCKFILE : file === "package.json" ? "{}" : "packages: []\n");
    return worktree;
  });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, AC_LOCK_ROOT: path.join(dir, "locks") };
  const cli = path.join(here, "..", "agent", "worktree-setup");
  const runs = worktrees.map(
    (worktree) =>
      new Promise((resolve) => {
        const child = spawn(cli, [worktree, "--cache", path.join(dir, "cache")], { env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("close", (code) => resolve({ code, out }));
      }),
  );
  const results = await Promise.all(runs);
  for (const { code, out } of results) assert.equal(code, 0, out);
  assert.equal(fs.readFileSync(path.join(dir, "installs"), "utf8").trim().split("\n").length, 1);
  const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8").split("\n");
  assert.equal(exclude.filter((line) => line === `/${GUARD_FILE}`).length, 1);
  for (const worktree of worktrees) assert.ok(fs.existsSync(path.join(worktree, "node_modules", "x", "index.js")));
});

test("pnpm install fails loudly in a linked worktree and leaves its links alone", { skip: spawnSync("pnpm", ["--version"]).status !== 0 && "pnpm isn't installed" }, () => {
  const { setup } = harness();
  const worktree = makeWorktree();
  const result = setup(worktree);
  fs.writeFileSync(path.join(worktree, "package.json"), '{"name":"ardia","private":true,"dependencies":{"react":"19.1.4"}}');
  fs.rmSync(path.join(worktree, "pnpm-lock.yaml"));
  const before = snapshot(path.join(worktree, "node_modules"));
  const treeBefore = snapshot(result.sourceRoot);
  const run = spawnSync("pnpm", ["install", "--offline"], { cwd: worktree, encoding: "utf8", env: { ...process.env, CI: "1" } });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /pnpm install is\s+blocked here/);
  assert.equal(snapshot(path.join(worktree, "node_modules")), before);
  assert.equal(snapshot(result.sourceRoot), treeBefore);
});
