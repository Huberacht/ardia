import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CACHE_STAMP,
  GUARD_FILE,
  MARKER,
  chooseSource,
  dependencyKey,
  normalizeLockfile,
  planLinks,
  pruneCaches,
  removeTree,
  setupWorktree,
  undoWorktree,
  workspacePatterns,
  workspaceProjects,
  worktreeStatus,
} from "./worktree-deps.mjs";

const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "worktree-deps-")));
test.after(() => removeTree(root));

const ENV_DOC = "---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    packageManagerDependencies:\n      pnpm:\n        version: 12.21.0\n\n";
const MAIN_DOC = "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: false\n\npatchedDependencies:\n  left-pad@1.0.0: abc\n";
const WORKSPACE = 'packages:\n  - apps/*\n  - packages/*\n  - "!apps/site"\n\nnodeLinker: hoisted\n';

const write = (file, text = "") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
let serial = 0;
const fresh = (name) => path.join(root, `${name}-${serial++}`);

function makeRepoFiles(dir, { lockfile = ENV_DOC + "---\n" + MAIN_DOC, patch = "patch v1\n" } = {}) {
  write(path.join(dir, "package.json"), '{"name":"ardia","private":true}');
  write(path.join(dir, "pnpm-lock.yaml"), lockfile);
  write(path.join(dir, "pnpm-workspace.yaml"), WORKSPACE);
  write(path.join(dir, "patches", "left-pad@1.0.0.patch"), patch);
  for (const project of ["apps/browser", "apps/site", "packages/core", "packages/shell"]) {
    write(path.join(dir, project, "package.json"), `{"name":"@ardia/${path.basename(project)}"}`);
  }
}

function fakeInstall(dir, lockfile) {
  write(path.join(dir, "node_modules", ".pnpm", "lock.yaml"), normalizeLockfile(lockfile));
  write(path.join(dir, "node_modules", ".modules.yaml"), "layoutVersion: 5\n");
  write(path.join(dir, "node_modules", ".cache", "stale"), "x");
  write(path.join(dir, "node_modules", "react", "package.json"), '{"name":"react"}');
  write(path.join(dir, "node_modules", "react", "index.js"), "module.exports = 'react from the tree';\n");
  write(path.join(dir, "node_modules", "@babel", "core", "package.json"), '{"name":"@babel/core"}');
  write(path.join(dir, "node_modules", "typescript", "bin", "tsc"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
  fs.symlinkSync("../typescript/bin/tsc", path.join(dir, "node_modules", ".bin", "tsc"));
  fs.mkdirSync(path.join(dir, "node_modules", "@ardia"), { recursive: true });
  for (const project of ["apps/browser", "packages/core", "packages/shell"]) {
    fs.symlinkSync(`../../${project}`, path.join(dir, "node_modules", "@ardia", path.basename(project)));
  }
  write(path.join(dir, "apps", "browser", "node_modules", "react-refresh", "package.json"), '{"name":"react-refresh"}');
  fs.mkdirSync(path.join(dir, "apps", "browser", "node_modules", "@ardia"), { recursive: true });
  fs.symlinkSync("../../../../packages/core", path.join(dir, "apps", "browser", "node_modules", "@ardia", "core"));
  write(path.join(dir, "apps", "site", "node_modules", "astro", "package.json"), '{"name":"astro"}');
}

function makeShared(options) {
  const dir = fresh("shared");
  makeRepoFiles(dir, options);
  fakeInstall(dir, fs.readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8"));
  return dir;
}

function makeWorktree(options) {
  const dir = fresh("worktree");
  makeRepoFiles(dir, options);
  return dir;
}

function countingInstaller() {
  const calls = [];
  const install = ({ staging }) => {
    calls.push(staging);
    fakeInstall(staging, fs.readFileSync(path.join(staging, "pnpm-lock.yaml"), "utf8"));
  };
  return { calls, install };
}

const quiet = () => {};
const snapshot = (dir) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => `${path.relative(dir, path.join(e.parentPath, e.name))}:${e.isSymbolicLink() ? "l" : e.isDirectory() ? "d" : "f"}`)
    .sort()
    .join("\n");

test("the lockfile key ignores pnpm's package-manager document, so a checkout's lockfile matches its installed copy", () => {
  assert.equal(normalizeLockfile(ENV_DOC + "---\n" + MAIN_DOC), MAIN_DOC);
  assert.equal(normalizeLockfile(MAIN_DOC), MAIN_DOC);
  const patches = [["a.patch", "1"]];
  assert.equal(
    dependencyKey({ lockfile: ENV_DOC + "---\n" + MAIN_DOC, workspace: WORKSPACE, patches }),
    dependencyKey({ lockfile: MAIN_DOC, workspace: WORKSPACE, patches }),
  );
});

test("the key changes with the lockfile, the workspace settings and each patch's name or content, not patch order", () => {
  const base = { lockfile: MAIN_DOC, workspace: WORKSPACE, patches: [["a.patch", "1"], ["b.patch", "2"]] };
  const key = dependencyKey(base);
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.equal(dependencyKey({ ...base, patches: [...base.patches].reverse() }), key);
  for (const changed of [
    { ...base, lockfile: MAIN_DOC + "  other@1.0.0: def\n" },
    { ...base, workspace: WORKSPACE.replace("hoisted", "isolated") },
    { ...base, patches: [["a.patch", "1"], ["b.patch", "3"]] },
    { ...base, patches: [["a.patch", "1"], ["c.patch", "2"]] },
    { ...base, patches: [["a.patch", "1"]] },
  ]) {
    assert.notEqual(dependencyKey(changed), key);
  }
});

test("workspace projects follow pnpm-workspace.yaml, negations included", () => {
  assert.deepEqual(workspacePatterns(WORKSPACE), ["apps/*", "packages/*", "!apps/site"]);
  const dir = makeWorktree();
  fs.mkdirSync(path.join(dir, "packages", "no-manifest"), { recursive: true });
  assert.deepEqual(workspaceProjects(dir, WORKSPACE), ["", "apps/browser", "packages/core", "packages/shell"]);
});

test("the read-only cache is the default; the shared checkout only on request and only when its install matches", () => {
  assert.equal(chooseSource({ mode: "cache", worktreeKey: "k", sharedKey: "k" }), "cache");
  assert.equal(chooseSource({ mode: undefined, worktreeKey: "k", sharedKey: "k" }), "cache");
  assert.equal(chooseSource({ mode: "shared", worktreeKey: "k", sharedKey: "k" }), "shared");
  assert.throws(() => chooseSource({ mode: "shared", worktreeKey: "k", sharedKey: "j" }), /don't match/);
  assert.throws(() => chooseSource({ mode: "shared", worktreeKey: "k", sharedKey: null }), /don't match/);
});

test("link plan: entries link to the tree, pnpm state and caches stay out, @ardia points into the worktree", () => {
  const entries = [
    { name: ".bin", kind: "dir" },
    { name: ".cache", kind: "dir" },
    { name: ".modules.yaml", kind: "file" },
    { name: ".pnpm", kind: "dir" },
    { name: "@ardia", kind: "workspace-scope", links: [{ name: "core", link: "../../../../packages/core" }, { name: "gone", link: "../../../../packages/gone" }, { name: "out", link: "../../../../../elsewhere" }] },
    { name: "@babel", kind: "dir" },
    { name: "react", kind: "dir" },
  ];
  const { ops, warnings } = planLinks({ sourceRoot: "/tree", worktreeRoot: "/wt", project: "apps/browser", entries, exists: (p) => p === "/wt/packages/core" });
  assert.deepEqual(ops, [
    { type: "mkdir", path: "/wt/apps/browser/node_modules" },
    { type: "symlink", path: "/wt/apps/browser/node_modules/.bin", target: "/tree/apps/browser/node_modules/.bin" },
    { type: "mkdir", path: "/wt/apps/browser/node_modules/@ardia" },
    { type: "symlink", path: "/wt/apps/browser/node_modules/@ardia/core", target: "../../../../packages/core" },
    { type: "symlink", path: "/wt/apps/browser/node_modules/@babel", target: "/tree/apps/browser/node_modules/@babel" },
    { type: "symlink", path: "/wt/apps/browser/node_modules/react", target: "/tree/apps/browser/node_modules/react" },
  ]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /no packages\/gone/);
  assert.match(warnings[1], /outside its checkout/);
});

test("--deps shared links a worktree whose lockfile matches the shared install into the shared checkout", () => {
  const shared = makeShared();
  const worktree = makeWorktree();
  const { calls, install } = countingInstaller();
  const before = snapshot(shared);
  const result = setupWorktree(worktree, { shared, cacheRoot: fresh("cache"), install, deps: "shared", log: quiet });
  assert.equal(result.kind, "shared");
  assert.equal(calls.length, 0);
  assert.deepEqual(result.projects, ["", "apps/browser"]);
  assert.equal(fs.readlinkSync(path.join(worktree, "node_modules", "react")), path.join(shared, "node_modules", "react"));
  assert.equal(fs.realpathSync(path.join(worktree, "node_modules", ".bin", "tsc")), path.join(shared, "node_modules", "typescript", "bin", "tsc"));
  assert.equal(fs.realpathSync(path.join(worktree, "node_modules", "@ardia", "core")), path.join(worktree, "packages", "core"));
  assert.equal(fs.realpathSync(path.join(worktree, "apps", "browser", "node_modules", "@ardia", "core")), path.join(worktree, "packages", "core"));
  assert.ok(fs.lstatSync(path.join(worktree, "node_modules")).isDirectory());
  for (const local of [".cache", ".pnpm", ".modules.yaml"]) assert.ok(!fs.existsSync(path.join(worktree, "node_modules", local)), local);
  assert.ok(!fs.existsSync(path.join(worktree, "apps", "site", "node_modules")), "apps/site is outside the workspace");
  const marker = JSON.parse(fs.readFileSync(path.join(worktree, "node_modules", MARKER), "utf8"));
  assert.deepEqual(marker.nodeModules, [path.join(shared, "node_modules"), path.join(shared, "apps", "browser", "node_modules")]);
  assert.equal(marker.state, "linked");
  assert.ok(fs.existsSync(path.join(worktree, GUARD_FILE)));
  assert.ok(fs.existsSync(path.join(worktree, ".metadata_never_index")));
  assert.equal(snapshot(shared), before);
  assert.deepEqual(worktreeStatus(worktree).problems, []);
});

test("setup installs each lockfile once into a read-only cache that later worktrees reuse", () => {
  const shared = makeShared();
  const cacheRoot = fresh("cache");
  const { calls, install } = countingInstaller();
  const first = makeWorktree();
  const result = setupWorktree(first, { shared, cacheRoot, install, log: quiet });
  assert.equal(result.kind, "cache");
  assert.equal(result.createdCache, true);
  assert.equal(calls.length, 1);
  assert.equal(result.sourceRoot, path.join(fs.realpathSync(cacheRoot), result.key));
  assert.ok(fs.existsSync(path.join(result.sourceRoot, CACHE_STAMP)));
  assert.equal(fs.readlinkSync(path.join(first, "node_modules", "react")), path.join(result.sourceRoot, "node_modules", "react"));
  if (process.getuid?.() !== 0) {
    assert.throws(() => fs.writeFileSync(path.join(result.sourceRoot, "node_modules", "react", "index.js"), "overwritten"), { code: "EACCES" });
    assert.throws(() => fs.mkdirSync(path.join(result.sourceRoot, "node_modules", "new-package")), { code: "EACCES" });
  }
  assert.deepEqual(fs.readdirSync(cacheRoot).filter((n) => n.startsWith(".staging")), []);

  const second = makeWorktree();
  const again = setupWorktree(second, { shared, cacheRoot, install, log: quiet });
  assert.equal(again.sourceRoot, result.sourceRoot);
  assert.equal(again.createdCache, false);
  assert.equal(calls.length, 1);

  const patched = setupWorktree(makeWorktree({ patch: "patch v2\n" }), { shared, cacheRoot, install, log: quiet });
  assert.notEqual(patched.key, result.key);
  assert.equal(calls.length, 2);
  assert.throws(() => setupWorktree(makeWorktree({ patch: "patch v3\n" }), { shared, cacheRoot, install, deps: "shared", log: quiet }), /don't match/);
});

test("setup refuses a worktree's own node_modules unless --replace, and reruns in place", () => {
  const shared = makeShared();
  const worktree = makeWorktree();
  write(path.join(worktree, "node_modules", "real-install", "index.js"), "x");
  assert.throws(() => setupWorktree(worktree, { shared, cacheRoot: fresh("cache"), deps: "shared", log: quiet }), /its own install; pass --replace/);
  const whole = makeWorktree();
  fs.symlinkSync(path.join(shared, "node_modules"), path.join(whole, "node_modules"));
  assert.throws(() => setupWorktree(whole, { shared, cacheRoot: fresh("cache"), deps: "shared", log: quiet }), /link to a whole node_modules/);
  const before = snapshot(shared);
  setupWorktree(whole, { shared, cacheRoot: fresh("cache"), deps: "shared", replace: true, log: quiet });
  assert.equal(snapshot(shared), before, "replacing a whole-folder link never deletes through it");
  assert.ok(fs.lstatSync(path.join(whole, "node_modules")).isDirectory());

  setupWorktree(worktree, { shared, cacheRoot: fresh("cache"), deps: "shared", replace: true, log: quiet });
  write(path.join(worktree, "apps", "browser", "node_modules", ".cache", "ardia-test-tsx", "a.mjs"), "cached");
  write(path.join(worktree, "node_modules", "react_pacquet-stage_1", "index.js"), "left by a bypassed pnpm install");
  fs.rmSync(path.join(worktree, "node_modules", "@babel"));
  write(path.join(worktree, "node_modules", "@babel", "core", "index.js"), "a real copy");
  setupWorktree(worktree, { shared, cacheRoot: fresh("cache"), deps: "shared", log: quiet });
  assert.ok(fs.existsSync(path.join(worktree, "apps", "browser", "node_modules", ".cache", "ardia-test-tsx", "a.mjs")), "local caches survive a rerun");
  assert.ok(!fs.existsSync(path.join(worktree, "node_modules", "react_pacquet-stage_1")));
  assert.ok(fs.lstatSync(path.join(worktree, "node_modules", "@babel")).isSymbolicLink());
  assert.equal(snapshot(shared), before);
});

test("status notices a moved shared install, and undo removes only the worktree's links", () => {
  const shared = makeShared();
  const worktree = makeWorktree();
  setupWorktree(worktree, { shared, cacheRoot: fresh("cache"), deps: "shared", log: quiet });
  fs.writeFileSync(path.join(shared, "node_modules", ".pnpm", "lock.yaml"), MAIN_DOC + "  moved@1.0.0: x\n");
  assert.match(worktreeStatus(worktree).problems.join("\n"), /shared checkout's install moved/);
  const before = snapshot(shared);
  undoWorktree(worktree, { log: quiet });
  for (const gone of ["node_modules", "apps/browser/node_modules", GUARD_FILE]) assert.ok(!fs.existsSync(path.join(worktree, gone)), gone);
  assert.equal(snapshot(shared), before);
  assert.throws(() => undoWorktree(worktree, { log: quiet }), /isn't linked/);
});

test("prune keeps caches a worktree uses or used recently and deletes the rest", () => {
  const shared = makeShared();
  const cacheRoot = fresh("cache");
  const { install } = countingInstaller();
  const used = makeWorktree({ patch: "used\n" });
  const usedKey = setupWorktree(used, { shared, cacheRoot, install, log: quiet }).key;
  const idle = makeWorktree({ patch: "idle\n" });
  const idleKey = setupWorktree(idle, { shared, cacheRoot, install, log: quiet }).key;
  undoWorktree(idle, { log: quiet });
  const later = Date.now() + 10 * 24 * 60 * 60 * 1000;
  assert.deepEqual(pruneCaches({ cacheRoot, shared: null, extraWorktrees: [used], now: Date.now(), log: quiet }), []);
  const removed = pruneCaches({ cacheRoot, shared: null, extraWorktrees: [used], now: later, log: quiet });
  assert.deepEqual(removed, [path.join(cacheRoot, idleKey)]);
  assert.ok(fs.existsSync(path.join(cacheRoot, usedKey, CACHE_STAMP)));
});

test("pnpm install fails loudly in a linked worktree and leaves its links alone", { skip: spawnSync("pnpm", ["--version"]).status !== 0 && "pnpm isn't installed" }, () => {
  const shared = makeShared();
  const worktree = makeWorktree();
  fs.writeFileSync(path.join(worktree, "package.json"), '{"name":"ardia","private":true,"dependencies":{"react":"19.1.4"}}');
  setupWorktree(worktree, { shared, cacheRoot: fresh("cache"), deps: "shared", log: quiet });
  fs.rmSync(path.join(worktree, "pnpm-lock.yaml"));
  const before = snapshot(path.join(worktree, "node_modules"));
  const sharedBefore = snapshot(shared);
  const result = spawnSync("pnpm", ["install", "--offline"], { cwd: worktree, encoding: "utf8", env: { ...process.env, CI: "1" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /pnpm install is\s+blocked here/);
  assert.equal(snapshot(path.join(worktree, "node_modules")), before);
  assert.equal(snapshot(shared), sharedBefore);
});
