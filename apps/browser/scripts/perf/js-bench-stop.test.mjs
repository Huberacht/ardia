import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { killInstances } from "./js-bench.mjs";

const jsBench = new URL("./js-bench.mjs", import.meta.url).href;
const STUBBORN = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const gone = async (pid) => {
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
};

function harness(body, env = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", body], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...env } });
  const ready = new Promise((resolve) => {
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d) => {
      out += d;
      if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]));
    });
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve(code ?? signal)));
  return { child, ready, exited };
}

const startInstances = `
import { spawn } from "node:child_process";
import { hardStopOnSignals, trackInstance } from ${JSON.stringify(jsBench)};
const pids = [0, 1].map(() => spawn(process.execPath, ["-e", ${JSON.stringify(STUBBORN)}], { detached: true, stdio: "ignore" }).pid);
pids.forEach(trackInstance);
hardStopOnSignals();
console.log(JSON.stringify(pids));
setInterval(() => {}, 1000);
`;

test("a signal kills every instance at once, even ones that ignore SIGTERM, and exits with the first signal's code; a second one changes nothing", { timeout: 20_000 }, async () => {
  const { child, ready, exited } = harness(startInstances);
  const pids = await ready;
  child.kill("SIGINT");
  child.kill("SIGTERM");
  assert.equal(await exited, 130);
  for (const pid of pids) assert.ok(await gone(pid), `instance ${pid} survived`);
});

test("each run records its instances where the ratchet can find and kill them", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-instances-"));
  const { child, ready, exited } = harness(startInstances, { ARDIA_BENCH_INSTANCES: dir });
  const pids = await ready;
  const [file] = readdirSync(dir);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, file), "utf8")).pids, pids);
  child.kill("SIGKILL");
  await exited;
  killInstances(JSON.parse(readFileSync(join(dir, file), "utf8")));
  for (const pid of pids) assert.ok(await gone(pid), `instance ${pid} survived`);
});

test("an instance opened but not yet found by pid is killed through its binary", { timeout: 20_000 }, async () => {
  const pid = spawn(process.execPath, ["-e", STUBBORN], { detached: true, stdio: "ignore" }).pid;
  killInstances({ binaries: ["/x/Ardia"] }, (binary) => (binary === "/x/Ardia" ? [pid] : []));
  assert.ok(await gone(pid));
});
