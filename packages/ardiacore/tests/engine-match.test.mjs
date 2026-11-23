import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const scripts = join(repoRoot, "packages/ardiacore/scripts");
const matchScript = join(scripts, "engine-match.sh");
const isMac = process.platform === "darwin";
const HEADER = "engine/ardiacore/src/ardia/core/public/api.h";

const scratch = () => fs.mkdtempSync(join(os.tmpdir(), "engine-match-"));
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", ...opts, env: { ...process.env, ARDIACORE_ALLOW_PUBLIC_MISMATCH: "", ARDIACORE_ENGINE_MATCH: "", ...opts.env } });
const write = (root, rel, text, mode) => {
  fs.mkdirSync(dirname(join(root, rel)), { recursive: true });
  fs.writeFileSync(join(root, rel), text, mode ? { mode } : undefined);
};
const git = (root, ...args) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
const field = (line, name) => line.split(" ").find((pair) => pair.startsWith(`${name}=`))?.slice(name.length + 1);

const FAKE_KEY = `#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
[ "$1" = --platform ] && shift 2
if [ "\${1:-}" = --paths ]; then echo engine; exit 0; fi
git -C "$root" ls-tree -r "\${1:-HEAD}" engine | shasum -a 256 | cut -c1-64
`;

function checkout({ row = true } = {}) {
  const root = scratch();
  for (const name of ["fetch-engine.sh", "engine-match.sh", "stage-framework.sh"]) {
    write(root, `packages/ardiacore/scripts/${name}`, fs.readFileSync(join(scripts, name), "utf8"), 0o755);
  }
  write(root, "scripts/lib/paths.sh", fs.readFileSync(join(repoRoot, "scripts/lib/paths.sh"), "utf8"));
  write(root, "engine/engine-key.sh", FAKE_KEY, 0o755);
  write(root, HEADER, "int api(void);\n");
  write(root, "engine/patch.txt", "one\n");
  write(root, "bin/curl", `#!/bin/bash\necho called >> "${root}/curl-calls"\nexit 22\n`, 0o755);
  fs.writeFileSync(join(root, ".gitignore"), "curl-calls\nstage/\ncache/\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "engine one");
  const base = git(root, "rev-parse", "HEAD");
  const key = execFileSync(join(root, "engine/engine-key.sh"), ["--platform", "macos"], { encoding: "utf8" }).trim();
  const tag = `engine-${key.slice(0, 12)}`;
  write(root, "packages/ardiacore/prebuilt-engines.tsv", row ? `${key}\t${tag}\t${"0".repeat(64)}\n` : "# none\n");
  const store = join(root, "apps/browser/build-ardiacore/prebuilt", key.slice(0, 12));
  write(store, "Chromium Framework.framework/Versions/Current/Chromium Framework", "binary");
  write(store, ".complete", "");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "published from here");
  const published = git(root, "rev-parse", "HEAD");
  git(root, "tag", tag, published);
  return { root, key, tag, base, published, store, framework: join(store, "Chromium Framework.framework") };
}

const commitFile = (root, rel, text) => {
  write(root, rel, text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", `change ${rel}`);
};

const envFor = (root, extra = {}) => ({ PATH: `${join(root, "bin")}:${process.env.PATH}`, ARDIACORE_PREBUILT_REPO: "none/none", ARDIACORE_ENGINE_TAG_REMOTE: join(root, "no-remote"), ...extra });
const fetchEngine = (root, args = [], extra) => run(join(root, "packages/ardiacore/scripts/fetch-engine.sh"), args, { env: envFor(root, extra) });
const resolve = (root, line) => run(matchScript, ["resolve", root, line]);
const record = (store) => fs.readFileSync(join(store, "engine-match"), "utf8").trim();
const publicHashAt = (root, commit) => run(matchScript, ["public-hash", root, commit]).stdout.trim();

test("an exact engine is recorded with its key, release, the commit it was published from and its public headers' hash", () => {
  const { root, key, tag, base, published, store, framework } = checkout();
  const r = fetchEngine(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), framework);
  assert.notEqual(published, base, "the release tag sits on a later commit than the last engine change");
  assert.equal(record(store), `match=exact key=${key} version=${tag} source=${published} public_hash=${publicHashAt(root, base)}`);
  assert.match(field(record(store), "public_hash"), /^[0-9a-f]{64}$/);
});

test("the published source comes from the remote's tag when this clone hasn't fetched it, and stays empty when nothing knows it", () => {
  const { root, tag, published, store } = checkout();
  const remote = join(scratch(), "remote.git");
  execFileSync("git", ["clone", "-q", "--bare", root, remote]);
  git(root, "tag", "-d", tag);
  assert.equal(fetchEngine(root, [], { ARDIACORE_ENGINE_TAG_REMOTE: remote }).status, 0);
  assert.equal(field(record(store), "source"), published);
  fs.rmSync(join(store, "engine-match"));
  assert.equal(fetchEngine(root).status, 0);
  assert.equal(field(record(store), "source"), "");
});

test("the hash of the public headers is the same from a commit and from the files on disk, and moves with their content", () => {
  const { root } = checkout();
  const atHead = publicHashAt(root, "HEAD");
  assert.equal(run(matchScript, ["public-hash", root]).stdout.trim(), atHead);
  write(root, HEADER, "int api(int);\n");
  assert.notEqual(run(matchScript, ["public-hash", root]).stdout.trim(), atHead);
  write(root, HEADER, "int api(void);\n");
  write(root, "engine/ardiacore/src/ardia/core/public/.DS_Store", "x");
  assert.equal(run(matchScript, ["public-hash", root]).stdout.trim(), atHead);
});

test("a nearest engine is judged by the tree: unchanged public headers build, changed ones stop the build", () => {
  const { root, key, store } = checkout();
  commitFile(root, "engine/patch.txt", "two\n");
  assert.notEqual(fetchEngine(root).status, 0, "without --nearest an older engine is refused");
  assert.equal(fetchEngine(root, ["--nearest"]).status, 0);
  const same = resolve(root, record(store)).stdout.trim();
  assert.match(same, new RegExp(`^match=nearest key=${key} .* public=same$`));
  assert.equal(run(matchScript, ["check", same]).status, 0);
  commitFile(root, HEADER, "int api(int);\n");
  const warned = fetchEngine(root, ["--nearest"]);
  assert.match(warned.stderr, /ARDIACORE_ALLOW_PUBLIC_MISMATCH/);
  assert.match(resolve(root, record(store)).stdout.trim(), /^match=nearest .* public=changed$/);
});

test("a record written for an exact engine can't vouch for a later committed public header change", { skip: !isMac }, () => {
  const { root, store, framework } = checkout();
  assert.equal(fetchEngine(root).status, 0);
  assert.match(record(store), /^match=exact /);
  commitFile(root, HEADER, "int api(int);\n");
  assert.match(resolve(root, record(store)).stdout.trim(), /^match=nearest .* public=changed$/);
  const stage = join(root, "packages/ardiacore/scripts/stage-framework.sh");
  const stopped = run(stage, [], { env: { ARDIACORE_FRAMEWORK: framework, ARDIACORE_STAGE_DIR: join(root, "stage"), ARDIACORE_STAGE_CACHE: join(root, "cache") } });
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /differs from that of/);
  assert.equal(fs.existsSync(join(root, "stage/Chromium Framework.framework")), false);
  const stale = run(stage, [], { env: { ARDIACORE_FRAMEWORK: framework, ARDIACORE_STAGE_DIR: join(root, "stage"), ARDIACORE_STAGE_CACHE: join(root, "cache"), ARDIACORE_ENGINE_MATCH: `${record(store)} public=same` } });
  assert.equal(stale.status, 1, "a resolved line passed in is judged again");
});

test("an uncommitted public header edit makes an exact engine nearest and stops the build", { skip: !isMac }, () => {
  const { root, store, framework } = checkout();
  assert.equal(fetchEngine(root).status, 0);
  write(root, HEADER, "int api(int);\n");
  assert.match(resolve(root, record(store)).stdout.trim(), /^match=nearest .* public=changed$/);
  const stopped = run(join(root, "packages/ardiacore/scripts/stage-framework.sh"), [], {
    env: { ARDIACORE_FRAMEWORK: framework, ARDIACORE_STAGE_DIR: join(root, "stage"), ARDIACORE_STAGE_CACHE: join(root, "cache") },
  });
  assert.equal(stopped.status, 1);
  write(root, "engine/patch.txt", "dirty\n");
  write(root, HEADER, "int api(void);\n");
  assert.match(resolve(root, record(store)).stdout.trim(), /^match=nearest .* public=same$/, "other uncommitted engine edits keep it buildable but not exact");
});

test("in a build slot, a copy with no git, the stored match stands and the public headers are still compared", () => {
  const { root, store } = checkout();
  assert.equal(fetchEngine(root).status, 0);
  const slot = scratch();
  fs.cpSync(join(root, "engine"), join(slot, "engine"), { recursive: true });
  assert.match(resolve(slot, record(store)).stdout.trim(), /^match=exact .* public=same$/);
  write(slot, HEADER, "int api(int);\n");
  const changed = resolve(slot, record(store)).stdout.trim();
  assert.match(changed, /^match=nearest .* public=changed$/);
  assert.equal(run(matchScript, ["check", changed]).status, 1);
});

test("--describe prints the record without downloading, and --offline never reaches the network", () => {
  const { root, key, store } = checkout();
  fs.rmSync(store, { recursive: true });
  const r = fetchEngine(root, ["--describe"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), new RegExp(`^match=exact key=${key} `));
  assert.equal(fs.existsSync(store), false);
  const missing = checkout({ row: false });
  const offline = fetchEngine(missing.root, ["--describe", "--offline"]);
  assert.equal(offline.status, 0, offline.stderr);
  assert.equal(offline.stdout.trim(), `match=unknown key=${missing.key}`);
  assert.equal(fs.existsSync(join(missing.root, "curl-calls")), false);
  assert.notEqual(fetchEngine(root, ["--offline"]).status, 0);
});

test("a cached engine with no record keeps its hit offline and is recorded as unknown, never failing the build", () => {
  const { root, key } = checkout({ row: false });
  const cache = scratch();
  const dir = join(cache, "engines", key.slice(0, 12));
  write(dir, "Chromium Framework.framework/Versions/Current/Chromium Framework", "binary");
  write(dir, ".complete", "");
  const r = run(process.execPath, [join(repoRoot, "scripts/agent/build-cache"), "engine", "--repo", root], { env: envFor(root, { AC_APP_CACHE: cache }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), join(dir, "Chromium Framework.framework"));
  assert.equal(fs.readFileSync(join(dir, "engine-match"), "utf8").trim(), `match=unknown key=${key}`);
  assert.equal(fs.existsSync(join(root, "curl-calls")), false);
  assert.equal(resolve(root, `match=unknown key=${key}`).stdout.trim(), `match=unknown key=${key} version= source= public_hash= public=unknown`);
  assert.equal(run(matchScript, ["check", "match=unknown key=k public=unknown"]).status, 0);
});

test("a cached engine whose row is in the local table gets its full record offline", () => {
  const { root, key, published } = checkout();
  const cache = scratch();
  const dir = join(cache, "engines", key.slice(0, 12));
  write(dir, "Chromium Framework.framework/Versions/Current/Chromium Framework", "binary");
  write(dir, ".complete", "");
  write(dir, "engine-match", `match=exact key=${key} version=engine-x source=old public=same\n`);
  const r = run(process.execPath, [join(repoRoot, "scripts/agent/build-cache"), "engine", "--repo", root], { env: envFor(root, { AC_APP_CACHE: cache }) });
  assert.equal(r.status, 0, r.stderr);
  const line = fs.readFileSync(join(dir, "engine-match"), "utf8").trim();
  assert.match(line, new RegExp(`^match=exact key=${key} .*source=${published} public_hash=[0-9a-f]{64}$`));
});

test("check passes exact, local, unknown and unchanged nearest engines and stops a changed one unless overridden", () => {
  for (const line of ["match=exact key=k public=same", "match=local", "", "match=nearest key=k public=same", "match=unknown key=k public=unknown"]) {
    assert.equal(run(matchScript, ["check", line]).status, 0, line);
  }
  const changed = "match=nearest key=k version=engine-abc source=0123456789abcdef public=changed";
  const stopped = run(matchScript, ["check", changed]);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /public differs from that of engine-abc's engine \(published from 0123456789\)/);
  assert.match(stopped.stderr, /ARDIACORE_ALLOW_PUBLIC_MISMATCH=1/);
  const allowed = run(matchScript, ["check", changed], { env: { ARDIACORE_ALLOW_PUBLIC_MISMATCH: "1" } });
  assert.equal(allowed.status, 0);
  assert.match(allowed.stderr, /warning/);
  assert.equal(run(matchScript, ["check", "match=nearest key=k"]).status, 1, "an unresolved nearest line is treated as changed");
  assert.equal(run(matchScript, ["check", "match=close"]).status, 1);
});

test("get reads one field and calls a line without a match local", () => {
  assert.equal(run(matchScript, ["get", "public", "match=nearest public=changed"]).stdout.trim(), "changed");
  assert.equal(run(matchScript, ["get", "match", ""]).stdout.trim(), "local");
  assert.equal(run(matchScript, ["get", "source", "match=local"]).stdout.trim(), "");
  assert.equal(resolve(scratch(), "match=local").stdout.trim(), "match=local");
});

test("stage-framework records the resolved line beside the staged framework", { skip: !isMac }, () => {
  const { root, framework } = checkout();
  assert.equal(fetchEngine(root).status, 0);
  const stageDir = join(root, "stage");
  const stage = join(root, "packages/ardiacore/scripts/stage-framework.sh");
  write(stageDir, "Chromium Framework.framework/Versions/Current/Chromium Framework", "binary");
  write(stageDir, ".stamp", run(stage, ["--key", framework]).stdout);
  const env = { ARDIACORE_FRAMEWORK: framework, ARDIACORE_STAGE_DIR: stageDir, ARDIACORE_STAGE_CACHE: join(root, "cache") };
  const ok = run(stage, [], { env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(fs.readFileSync(join(stageDir, "engine-match"), "utf8"), /^match=exact .* public=same$/m);
  commitFile(root, HEADER, "int api(int);\n");
  const allowed = run(stage, [], { env: { ...env, ARDIACORE_ALLOW_PUBLIC_MISMATCH: "1" } });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(fs.readFileSync(join(stageDir, "engine-match"), "utf8"), /^match=nearest .* public=changed$/m);
  const local = run(stage, [], { env: { ...env, ARDIACORE_ENGINE_MATCH: "match=local" } });
  assert.equal(local.status, 0, local.stderr);
  assert.equal(fs.readFileSync(join(stageDir, "engine-match"), "utf8").trim(), "match=local");
});

test("plist writes the engine keys into the app's Info.plist, and a local build keeps only its match", { skip: !isMac }, () => {
  const plist = join(scratch(), "Info.plist");
  write(dirname(plist), "Info.plist", '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleName</key><string>Ardia</string></dict></plist>\n');
  const read = () => JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" }));
  const r = run(matchScript, ["plist", "match=nearest key=abc version=engine-abc source=0123 public_hash=ff public=same", plist]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(read(), { CFBundleName: "Ardia", ArdiaEngineMatch: "nearest", ArdiaEngineKey: "abc", ArdiaEngineVersion: "engine-abc", ArdiaEngineSource: "0123" });
  assert.equal(run(matchScript, ["plist", "match=unknown key=abc version= source= public_hash= public=unknown", plist]).status, 0);
  assert.deepEqual(read(), { CFBundleName: "Ardia", ArdiaEngineMatch: "unknown", ArdiaEngineKey: "abc" });
  assert.equal(run(matchScript, ["plist", "match=local", plist]).status, 0);
  assert.deepEqual(read(), { CFBundleName: "Ardia", ArdiaEngineMatch: "local" });
  const stopped = run(matchScript, ["plist", "match=nearest key=abc public=changed", plist]);
  assert.equal(stopped.status, 1);
  assert.deepEqual(read(), { CFBundleName: "Ardia", ArdiaEngineMatch: "local" });
});
