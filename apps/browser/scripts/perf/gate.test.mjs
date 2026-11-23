import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const gate = join(dirname(fileURLToPath(import.meta.url)), "gate.sh");

const stub = (name) => `import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const kind = ${JSON.stringify(name)} === "native-bench" && args.includes("prepare") ? "prep" : ${JSON.stringify(name)};
appendFileSync(process.env.STUB_LOG, JSON.stringify([kind, args]) + "\\n");
writeFileSync(process.env.STUB_LOG + "." + kind + ".pid", String(process.pid));
const env = kind.replace("-", "_");
if (process.env["STUB_IGNORE_INT_" + env]) process.on("SIGINT", () => {});
if (kind === "prep") {
  const { mkdirSync } = await import("node:fs");
  const out = args[args.indexOf("--out") + 1];
  mkdirSync(out + "/rc/bundle", { recursive: true });
  writeFileSync(out + "/rc/bundle/main.jsbundle", "candidate bundle");
}
const wait = +(process.env["STUB_SLEEP_" + env] ?? 0);
setTimeout(() => {
  writeFileSync(process.env.STUB_LOG + "." + kind + ".finished", "");
  process.exit(+(process.env["STUB_EXIT_" + env] ?? 0));
}, wait);
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gate-sh-"));
  const perf = join(dir, "perf");
  mkdirSync(perf);
  for (const name of ["native-bench", "ratchet", "gate-verdict"]) writeFileSync(join(perf, `${name}.mjs`), stub(name));
  const smoke = join(dir, "smoke.sh");
  writeFileSync(smoke, `#!/bin/sh\necho '["smoke",[]]' >> "$STUB_LOG"\necho $$ > "$STUB_LOG.smoke.pid"\nsleep "\${STUB_SLEEP_smoke_SECS:-0}"\nexit "\${STUB_EXIT_smoke:-0}"\n`);
  chmodSync(smoke, 0o755);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const env = { ...process.env, GATE_LOCKED: "1", GATE_ROOT: dir, GATE_PERF: perf, GATE_SMOKE: smoke, STUB_LOG: log, PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { dir, env, log, calls, out: join(dir, "out"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const run = (s, extra = {}) => spawnSync("bash", [gate, "0.2.49", "0.2.48", "--out", s.out], { env: { ...s.env, ...extra }, encoding: "utf8", timeout: 60_000 });

test("every step passing runs two rounds in two new folders and exits with the verdict's 0", () => {
  const s = setup();
  try {
    const r = run(s);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const calls = s.calls();
    assert.deepEqual(calls.map(([k]) => k).sort(), ["gate-verdict", "native-bench", "native-bench", "prep", "ratchet", "smoke"]);
    const rounds = calls.filter(([k]) => k === "native-bench").map(([, a]) => a[a.indexOf("--out") + 1]);
    assert.equal(new Set(rounds).size, 2);
    assert.ok(calls.filter(([k]) => k === "native-bench").every(([, a]) => a.includes("launch,session,windows")));
    const verdict = calls.find(([k]) => k === "gate-verdict")[1];
    assert.deepEqual(verdict.slice(-2), rounds);
  } finally {
    s.done();
  }
});

test("a FAIL or INVALID verdict is the block's exit status, not cleanup's", () => {
  for (const code of ["1", "2"]) {
    const s = setup();
    try {
      assert.equal(run(s, { STUB_EXIT_gate_verdict: code }).status, +code);
    } finally {
      s.done();
    }
  }
});

test("a failed round stops the gate with its code (13 for round 1), before the second round and the verdict", () => {
  const s = setup();
  try {
    const r = run(s, { STUB_EXIT_native_bench: "3" });
    assert.equal(r.status, 13);
    assert.match(r.stdout, /round 1 failed \(status 3/);
    const kinds = s.calls().map(([k]) => k);
    assert.equal(kinds.filter((k) => k === "native-bench").length, 1);
    assert.ok(!kinds.includes("gate-verdict"));
  } finally {
    s.done();
  }
});

test("a failed prep job waits for the others, then exits with the first failed step's code (11 ratchet) and no round", () => {
  const s = setup();
  try {
    const r = run(s, { STUB_EXIT_ratchet: "5", STUB_EXIT_prep: "6" });
    assert.equal(r.status, 11);
    assert.ok(!s.calls().some(([k]) => k === "native-bench"));
    assert.match(r.stdout, /smoke 0, ratchet 5, prepare 6/);
  } finally {
    s.done();
  }
});

test("a TERM stops the prep jobs it started and waits for them, and exits 143", async () => {
  const s = setup();
  try {
    const child = spawn("bash", [gate, "0.2.49", "0.2.48", "--out", s.out], { env: { ...s.env, STUB_SLEEP_ratchet: "20000", STUB_SLEEP_prep: "20000", GATE_JOB_INT_SECS: "2" }, stdio: "ignore" });
    for (const end = Date.now() + 10_000; Date.now() < end && s.calls().length < 3; ) await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.calls().length, 3);
    const t0 = Date.now();
    child.kill("SIGTERM");
    const code = await new Promise((r) => child.on("exit", (c) => r(c)));
    assert.equal(code, 143);
    assert.ok(Date.now() - t0 < 10_000);
    assert.ok(!existsSync(`${s.log}.ratchet.finished`) && !existsSync(`${s.log}.prep.finished`));
  } finally {
    s.done();
  }
});

test("without the lock it fails at once with the lock's status", () => {
  const s = setup();
  try {
    mkdirSync(join(s.dir, "scripts", "agent"), { recursive: true });
    writeFileSync(join(s.dir, "scripts", "agent", "locked"), "#!/bin/sh\necho 'perflab is held' >&2\nexit 75\n");
    chmodSync(join(s.dir, "scripts", "agent", "locked"), 0o755);
    const r = run(s, { GATE_LOCKED: "" });
    assert.equal(r.status, 75);
    assert.deepEqual(s.calls(), []);
  } finally {
    s.done();
  }
});

test("a pass keeps the candidate's bench bundle in dist/<version>/bench for the next gate; a FAIL keeps nothing", () => {
  const s = setup();
  try {
    assert.equal(run(s).status, 0);
    assert.equal(readFileSync(join(s.dir, "dist", "0.2.49", "bench", "main.jsbundle"), "utf8"), "candidate bundle");
  } finally {
    s.done();
  }
  const f = setup();
  try {
    assert.equal(run(f, { STUB_EXIT_gate_verdict: "1" }).status, 1);
    assert.equal(existsSync(join(f.dir, "dist", "0.2.49", "bench")), false);
  } finally {
    f.done();
  }
});

test("a pass whose bundle can't be kept exits 70, not 0", () => {
  const s = setup();
  try {
    mkdirSync(join(s.dir, "dist", "0.2.49"), { recursive: true });
    writeFileSync(join(s.dir, "dist", "0.2.49", "bench"), "a file in the way");
    assert.equal(run(s).status, 70);
  } finally {
    s.done();
  }
});

const alive = (pid) => {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function withRealLock(s) {
  const real = join(dirname(gate), "../../../../scripts/agent/locked");
  mkdirSync(join(s.dir, "scripts", "agent"), { recursive: true });
  writeFileSync(join(s.dir, "scripts", "agent", "locked"), readFileSync(real));
  chmodSync(join(s.dir, "scripts", "agent", "locked"), 0o755);
  const locks = join(s.dir, "locks");
  mkdirSync(locks);
  return { ...s.env, GATE_LOCKED: "", GATE_LOCK_WAIT: "20", AC_LOCK_ROOT: locks, AC_LOCKED_AS: "", AC_LOCKED_HELD: "", GATE_JOB_INT_SECS: "1", GATE_JOB_TERM_SECS: "5", GATE_CHAIN_TERM_SECS: "60" };
}

for (const [how, signal, group, code] of [["TERM to its pid", "SIGTERM", false, 143], ["INT to its process group", "SIGINT", true, 130], ["TERM to its process group", "SIGTERM", true, 143]]) {
  test(`through the real lock, ${how} stops every job before the lock is free, and returns after`, async () => {
    const s = setup();
    try {
      const env = withRealLock(s);
      const child = spawn("bash", [gate, "0.2.49", "0.2.48", "--out", s.out], { env: { ...env, STUB_SLEEP_smoke_SECS: "60", STUB_SLEEP_ratchet: "60000", STUB_SLEEP_prep: "60000", STUB_IGNORE_INT_ratchet: "1" }, stdio: "ignore", detached: true });
      const exited = new Promise((r) => child.on("exit", (c, sig) => r(c ?? sig)));
      const pidFile = (k) => `${s.log}.${k}.pid`;
      for (const end = Date.now() + 20_000; Date.now() < end && !["smoke", "ratchet", "prep"].every((k) => existsSync(pidFile(k))); ) await new Promise((r) => setTimeout(r, 50));
      const pids = ["smoke", "ratchet", "prep"].map((k) => +readFileSync(pidFile(k), "utf8"));
      assert.ok(pids.every(alive));
      const held = () => existsSync(join(env.AC_LOCK_ROOT, "ac-perflab.lock"));
      assert.ok(held());
      if (group) process.kill(-child.pid, signal);
      else child.kill(signal);
      let done = false, unheldWhileRunning = 0;
      exited.then(() => (done = true));
      while (!done) {
        if (pids.some(alive) && !held()) unheldWhileRunning++;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(await exited, code);
      assert.equal(unheldWhileRunning, 0);
      assert.deepEqual(pids.filter(alive), []);
      assert.ok(!held());
      const again = spawnSync(join(s.dir, "scripts", "agent", "locked"), ["perflab", "--wait", "3", "--", "true"], { env, encoding: "utf8" });
      assert.equal(again.status, 0, again.stderr);
    } finally {
      s.done();
    }
  });
}

test("through the real lock, a step's 76 or 77 is the gate's own code, not the lock's 75 or a rerun", () => {
  for (const code of ["76", "77"]) {
    const s = setup();
    try {
      const r = spawnSync("bash", [gate, "0.2.49", "0.2.48", "--out", s.out], { env: { ...withRealLock(s), STUB_EXIT_ratchet: code }, encoding: "utf8", timeout: 60_000 });
      assert.equal(r.status, 11, r.stdout + r.stderr);
      assert.equal(s.calls().filter(([k]) => k === "ratchet").length, 1);
      assert.match(r.stdout, new RegExp(`the ratchet failed \\(status ${code}`));
    } finally {
      s.done();
    }
  }
});

test("through the real lock, a busy lock fails fast with 75 and starts nothing", () => {
  const s = setup();
  try {
    const env = { ...withRealLock(s), GATE_LOCK_WAIT: "2" };
    const holder = spawn(join(s.dir, "scripts", "agent", "locked"), ["perflab", "--wait", "5", "--", "sleep", "20"], { env, stdio: "ignore" });
    for (const end = Date.now() + 5000; Date.now() < end && !existsSync(join(env.AC_LOCK_ROOT, "ac-perflab.lock")); ) spawnSync("sleep", ["0.05"]);
    const r = spawnSync("bash", [gate, "0.2.49", "0.2.48", "--out", s.out], { env, encoding: "utf8", timeout: 60_000 });
    holder.kill("SIGTERM");
    assert.equal(r.status, 75, r.stdout + r.stderr);
    assert.deepEqual(s.calls(), []);
  } finally {
    s.done();
  }
});

test("through the real lock, a TERM while the jobs are still starting still stops every one of them", async () => {
  for (let i = 0; i < 3; i++) {
    const s = setup();
    try {
      const env = withRealLock(s);
      const child = spawn("bash", [gate, "0.2.49", "0.2.48", "--out", s.out], { env: { ...env, STUB_SLEEP_smoke_SECS: "60", STUB_SLEEP_ratchet: "60000", STUB_SLEEP_prep: "60000" }, stdio: "ignore", detached: true });
      const exited = new Promise((r) => child.on("exit", (c, sig) => r(c ?? sig)));
      for (const end = Date.now() + 20_000; Date.now() < end && !existsSync(`${s.log}.smoke.pid`); ) await new Promise((r) => setTimeout(r, 5));
      child.kill("SIGTERM");
      assert.equal(await exited, 143);
      await new Promise((r) => setTimeout(r, 500));
      const started = ["smoke", "ratchet", "prep"].filter((k) => existsSync(`${s.log}.${k}.pid`)).map((k) => +readFileSync(`${s.log}.${k}.pid`, "utf8")).filter((p) => p > 0);
      assert.deepEqual(started.filter(alive), []);
      assert.ok(!existsSync(join(env.AC_LOCK_ROOT, "ac-perflab.lock")));
    } finally {
      s.done();
    }
  }
});
