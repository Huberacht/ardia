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
const env = kind.replace("-", "_");
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
  writeFileSync(smoke, `#!/bin/sh\necho '["smoke",[]]' >> "$STUB_LOG"\nsleep "\${STUB_SLEEP_smoke_SECS:-0}"\nexit "\${STUB_EXIT_smoke:-0}"\n`);
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

test("a failed round stops the gate with its status, before the second round and the verdict", () => {
  const s = setup();
  try {
    const r = run(s, { STUB_EXIT_native_bench: "3" });
    assert.equal(r.status, 3);
    const kinds = s.calls().map(([k]) => k);
    assert.equal(kinds.filter((k) => k === "native-bench").length, 1);
    assert.ok(!kinds.includes("gate-verdict"));
  } finally {
    s.done();
  }
});

test("a failed prep job waits for the others, then exits with the first failure's status and no round", () => {
  const s = setup();
  try {
    const r = run(s, { STUB_EXIT_ratchet: "5", STUB_EXIT_prep: "6" });
    assert.equal(r.status, 5);
    assert.ok(!s.calls().some(([k]) => k === "native-bench"));
    assert.match(r.stdout, /smoke 0, ratchet 5, prepare 6/);
  } finally {
    s.done();
  }
});

test("a TERM stops the prep jobs it started and waits for them, and exits 143", async () => {
  const s = setup();
  try {
    const child = spawn("bash", [gate, "0.2.49", "0.2.48", "--out", s.out], { env: { ...s.env, STUB_SLEEP_ratchet: "20000", STUB_SLEEP_prep: "20000" }, stdio: "ignore" });
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
