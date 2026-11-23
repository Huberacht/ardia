import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { processTable, registerApp, registered, runningAs, stopApps, treeOf } from "./bench-registry.mjs";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function launchLikeOpen(dir, name, ignoreTerm = false) {
  const file = join(dir, `${name}.pid`);
  const body = ignoreTerm ? `$SIG{TERM} = "IGNORE"; my $kid = fork; if (!$kid) { exec "/bin/sleep", "600" } sleep 600;` : `exec "/bin/sleep", "600";`;
  spawnSync("perl", ["-e", `exit if fork; setpgrp(0, 0); open(my $f, ">", $ARGV[0]) or die; print $f $$; close $f; ${body}`, file], { stdio: "ignore" });
  for (let i = 0; i < 200 && !(existsSync(file) && readFileSync(file, "utf8")); i++) spawnSync("sleep", ["0.02"]);
  return +readFileSync(file, "utf8");
}

test("nothing is recorded without a registry folder; with one, each app is a file of its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-registry-"));
  try {
    assert.equal(registerApp({ pid: 123, exe: "/x" }, undefined), null);
    registerApp({ pid: 123, exe: "/x/Ardia", dataDir: "/d" }, dir);
    registerApp({ pid: 0, exe: "/x" }, dir);
    assert.deepEqual(registered(dir).map((e) => [e.pid, e.exe, e.dataDir]), [[123, "/x/Ardia", "/d"]]);
    assert.deepEqual(registered(join(dir, "none")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop quits an app launched like open (its own group, parent 1), kills what ignores the quit with its children, and confirms they're gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-registry-"));
  try {
    const plain = launchLikeOpen(dir, "plain");
    const stubborn = launchLikeOpen(dir, "stubborn", true);
    const table = processTable();
    const kids = treeOf(stubborn, table).filter((p) => p !== stubborn);
    assert.equal(kids.length, 1);
    assert.equal(table.find((p) => p.pid === plain).ppid, 1);
    registerApp({ pid: plain, exe: "/bin/sleep" }, dir);
    registerApp({ pid: stubborn, exe: table.find((p) => p.pid === stubborn).command.split(" ")[0] }, dir);
    assert.ok(registered(dir).every((e) => runningAs(e, table)));
    const r = await stopApps(dir, { quitSecs: 1, killSecs: 3 });
    assert.deepEqual(r.left, []);
    assert.ok(![plain, stubborn, ...kids].some(alive));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a recorded pid now running something else is left alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-registry-"));
  const other = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  try {
    registerApp({ pid: other.pid, exe: "/Applications/Ardia.app/Contents/MacOS/Ardia" }, dir);
    const r = await stopApps(dir, { quitSecs: 1, killSecs: 1 });
    assert.deepEqual(r.stopped, []);
    assert.ok(alive(other.pid));
  } finally {
    other.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
