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

const scratch = () => fs.mkdtempSync(join(os.tmpdir(), "engine-match-"));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts, env: { ...process.env, ARDIACORE_ALLOW_PUBLIC_MISMATCH: "", ARDIACORE_ENGINE_MATCH: "", ...opts.env } });
const write = (root, rel, text, mode) => {
  fs.mkdirSync(dirname(join(root, rel)), { recursive: true });
  fs.writeFileSync(join(root, rel), text, mode ? { mode } : undefined);
};
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const FAKE_KEY = `#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
[ "$1" = --platform ] && shift 2
if [ "\${1:-}" = --paths ]; then echo engine; exit 0; fi
git -C "$root" ls-tree -r "\${1:-HEAD}" engine | shasum -a 256 | cut -c1-64
`;

function checkout() {
  const root = scratch();
  for (const name of ["fetch-engine.sh", "engine-match.sh", "stage-framework.sh"]) {
    write(root, `packages/ardiacore/scripts/${name}`, fs.readFileSync(join(scripts, name), "utf8"), 0o755);
  }
  write(root, "scripts/lib/paths.sh", fs.readFileSync(join(repoRoot, "scripts/lib/paths.sh"), "utf8"));
  write(root, "engine/engine-key.sh", FAKE_KEY, 0o755);
  write(root, "engine/ardiacore/src/ardia/core/public/api.h", "int api(void);\n");
  write(root, "engine/patch.txt", "one\n");
  write(root, "bin/curl", "#!/bin/bash\nexit 22\n", 0o755);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "engine one");
  const published = git(root, "rev-parse", "HEAD");
  const key = execFileSync(join(root, "engine/engine-key.sh"), ["--platform", "macos"], { encoding: "utf8" }).trim();
  write(root, "packages/ardiacore/prebuilt-engines.tsv", `${key}\tengine-${key.slice(0, 12)}\t${"0".repeat(64)}\n`);
  const store = join(root, "apps/browser/build-ardiacore/prebuilt", key.slice(0, 12));
  write(store, "Chromium Framework.framework/Versions/Current/Chromium Framework", "binary");
  write(store, ".complete", "");
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "table");
  return { root, key, published, store };
}

const commitEngine = (root, rel, text) => {
  write(root, rel, text);
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `change ${rel}`);
};

const fetchEngine = (root, ...args) => run(join(root, "packages/ardiacore/scripts/fetch-engine.sh"), args, { env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, ARDIACORE_PREBUILT_REPO: "none/none" } });

test("an exact engine is recorded beside the framework with its key, release and source commit", () => {
  const { root, key, published, store } = checkout();
  const r = fetchEngine(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), join(store, "Chromium Framework.framework"));
  assert.equal(fs.readFileSync(join(store, "engine-match"), "utf8").trim(), `match=exact key=${key} version=engine-${key.slice(0, 12)} source=${published} public=same`);
});

test("a nearest engine whose public headers are unchanged is recorded as nearest and same", () => {
  const { root, key, published, store } = checkout();
  commitEngine(root, "engine/patch.txt", "two\n");
  assert.notEqual(fetchEngine(root).status, 0, "without --nearest an older engine is refused");
  const r = fetchEngine(root, "--nearest");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(join(store, "engine-match"), "utf8").trim(), `match=nearest key=${key} version=engine-${key.slice(0, 12)} source=${published} public=same`);
});

test("a nearest engine whose public headers changed since is recorded as changed and warned about", () => {
  const { root, store } = checkout();
  commitEngine(root, "engine/ardiacore/src/ardia/core/public/api.h", "int api(int);\n");
  const r = fetchEngine(root, "--nearest");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /ARDIACORE_ALLOW_PUBLIC_MISMATCH/);
  const line = fs.readFileSync(join(store, "engine-match"), "utf8").trim();
  assert.match(line, /^match=nearest .* public=changed$/);
  const describe = fetchEngine(root, "--nearest", "--describe");
  assert.equal(describe.status, 0, describe.stderr);
  assert.equal(describe.stdout.trim(), line);
});

test("--describe prints the line without needing the engine downloaded", () => {
  const { root, key, store } = checkout();
  fs.rmSync(store, { recursive: true });
  const r = fetchEngine(root, "--describe");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), new RegExp(`^match=exact key=${key} `));
  assert.equal(fs.existsSync(store), false);
});

test("check passes exact, local and unchanged nearest engines and stops a changed one unless overridden", () => {
  for (const line of ["match=exact key=k public=same", "match=local", "", "match=nearest key=k public=same"]) {
    assert.equal(run(matchScript, ["check", line]).status, 0, line);
  }
  const changed = "match=nearest key=k version=engine-abc source=0123456789abcdef public=changed";
  const stopped = run(matchScript, ["check", changed]);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /engine\/ardiacore\/src\/ardia\/core\/public differs from engine engine-abc's \(built from 0123456789\)/);
  assert.match(stopped.stderr, /ARDIACORE_ALLOW_PUBLIC_MISMATCH=1/);
  const allowed = run(matchScript, ["check", changed], { env: { ARDIACORE_ALLOW_PUBLIC_MISMATCH: "1" } });
  assert.equal(allowed.status, 0);
  assert.match(allowed.stderr, /warning/);
  assert.equal(run(matchScript, ["check", "match=nearest key=k"]).status, 1, "a nearest line without public is treated as changed");
  assert.equal(run(matchScript, ["check", "match=close"]).status, 1);
});

test("get reads one field and calls a line without a match local", () => {
  assert.equal(run(matchScript, ["get", "public", "match=nearest public=changed"]).stdout.trim(), "changed");
  assert.equal(run(matchScript, ["get", "match", ""]).stdout.trim(), "local");
  assert.equal(run(matchScript, ["get", "source", "match=local"]).stdout.trim(), "");
});

test("stage-framework stops before staging when a nearest engine's public headers changed", { skip: !isMac }, () => {
  const { root, store } = checkout();
  commitEngine(root, "engine/ardiacore/src/ardia/core/public/api.h", "int api(int);\n");
  assert.equal(fetchEngine(root, "--nearest").status, 0);
  const stageDir = join(root, "stage");
  const env = { ARDIACORE_FRAMEWORK: join(store, "Chromium Framework.framework"), ARDIACORE_STAGE_DIR: stageDir, ARDIACORE_STAGE_CACHE: join(root, "cache") };
  const stage = join(root, "packages/ardiacore/scripts/stage-framework.sh");
  const stopped = run(stage, [], { env });
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /differs from engine/);
  assert.equal(fs.existsSync(join(stageDir, "Chromium Framework.framework")), false);
  write(stageDir, "Chromium Framework.framework/Versions/Current/Chromium Framework", "binary");
  write(stageDir, ".stamp", run(stage, ["--key", env.ARDIACORE_FRAMEWORK]).stdout);
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
  const r = run(matchScript, ["plist", "match=nearest key=abc version=engine-abc source=0123 public=same", plist]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(read(), { CFBundleName: "Ardia", ArdiaEngineMatch: "nearest", ArdiaEngineKey: "abc", ArdiaEngineVersion: "engine-abc", ArdiaEngineSource: "0123" });
  assert.equal(run(matchScript, ["plist", "match=local", plist]).status, 0);
  assert.deepEqual(read(), { CFBundleName: "Ardia", ArdiaEngineMatch: "local" });
  const stopped = run(matchScript, ["plist", "match=nearest key=abc public=changed", plist]);
  assert.equal(stopped.status, 1);
  assert.deepEqual(read(), { CFBundleName: "Ardia", ArdiaEngineMatch: "local" });
});
