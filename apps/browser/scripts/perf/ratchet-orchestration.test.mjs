import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allFinished, evaluate, JOURNEYS, laneLabel, portPlan, retryPlan, SMALL_JOURNEYS, spawnAsync, splitRuns, stopLanes, withRetry } from "./ratchet.mjs";
import { stopInstances } from "./js-bench.mjs";

const over = (key, tier = "exact") => ({ tier, key, ceiling: 1, value: 2, kind: "over" });

test("a run with nothing over retries nothing", () => {
  assert.deepEqual(retryPlan([{ tier: "exact", key: "hover.commits", ceiling: 25, value: 25, kind: "same" }]), { big: null, small: null });
});

test("the retry reruns the journeys in order up to the last one that went over, so each keeps the scenarios before it", () => {
  const plan = retryPlan([over("hover.renders.TabRow"), over("switchTabs.commits")]);
  assert.deepEqual(plan, { big: ["startup", "launch", "idle", "typing", "switchTabs", "scroll", "hover"], small: null });
});

test("a launch count over reruns only the launch", () => {
  assert.deepEqual(retryPlan([over("launch.renders", "noisy")]).big, ["startup", "launch"]);
});

test("open and close counts retry up to the openClose scenario, leaving out the churn after it", () => {
  assert.deepEqual(retryPlan([over("close.renders")]).big, JOURNEYS.slice(0, -1));
  assert.deepEqual(retryPlan([over("open.mounts.TabRow")]).big, JOURNEYS.slice(0, -1));
});

test("the one-tab launch reruns only when one of its own counts went over", () => {
  assert.deepEqual(retryPlan([over("small.launch.renders")]), { big: null, small: SMALL_JOURNEYS });
  assert.deepEqual(retryPlan([over("launch.renders"), over("small.launch.commits")]), { big: ["startup", "launch"], small: SMALL_JOURNEYS });
});

test("micro and instruction counts never trigger an app rerun: Node counts don't wobble", () => {
  assert.deepEqual(retryPlan([over("micro.sidebar500", "micro"), over("micro.instrPerRound", "instr")]), { big: null, small: null });
});

test("every journey a count can belong to is one the retry knows how to run", () => {
  for (const s of JOURNEYS.filter((j) => j !== "startup" && j !== "nodeChurn")) assert.deepEqual(retryPlan([over(`${s}.commits`)]).big, JOURNEYS.slice(0, JOURNEYS.indexOf(s) + 1));
});

test("nodes left behind are never rerun: the worst run decides them, so a second run can only cost time", () => {
  assert.deepEqual(retryPlan([over("nodeChurn.nativeNodesLeft")]), { big: null, small: null });
  assert.deepEqual(retryPlan([over("nodeChurn.nativeNodesLeft"), over("hover.commits")]).big, JOURNEYS.slice(0, JOURNEYS.indexOf("hover") + 1));
});

test("baseline splits the journeys' runs evenly over the lanes and keeps every run", () => {
  assert.deepEqual(splitRuns(8, 4), [2, 2, 2, 2]);
  assert.deepEqual(splitRuns(10, 4), [3, 3, 2, 2]);
  assert.deepEqual(splitRuns(8, 1), [8]);
  assert.deepEqual(splitRuns(2, 4), [1, 1]);
});

test("the one-tab session never shares a label, app copy or report with the big one, whatever the label", () => {
  for (const name of ["ratchet", "stable", "s", "x-again"]) assert.notEqual(laneLabel(name, "small"), laneLabel(name, "big"));
});

test("lanes never share a test-server port or a remote-debugging port, however many runs a lane has", () => {
  for (const runsPerLane of [1, 8, 21, 40]) {
    const plan = portPlan({ port: 47831, cdpPort: 9700, lanes: 4, runsPerLane });
    const used = new Set();
    for (const { port, cdpPort } of plan) {
      for (const p of [port, ...Array.from({ length: runsPerLane }, (_, r) => cdpPort + r)]) {
        assert.ok(!used.has(p), `port ${p} used twice with ${runsPerLane} runs a lane`);
        used.add(p);
      }
    }
  }
});

test("ports outside 1024..65535 or a test server inside the remote-debugging range fail before anything launches", () => {
  assert.doesNotThrow(() => portPlan({ port: 64000, cdpPort: 9700, lanes: 4, runsPerLane: 8 }));
  assert.throws(() => portPlan({ port: 65534, cdpPort: 9700, lanes: 4, runsPerLane: 1 }), /outside 1024..65535/);
  assert.throws(() => portPlan({ port: 47831, cdpPort: 65530, lanes: 4, runsPerLane: 8 }), /outside 1024..65535/);
  assert.throws(() => portPlan({ port: 9705, cdpPort: 9700, lanes: 2, runsPerLane: 8 }), /falls in the remote-debugging ports/);
});

const report = (dir, name, seed, results) => {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify({ label: name, seed, benchRevision: 5, results: results.map((r) => ({ probeRevision: 2, ...r })) }));
  return file;
};
const stats = (commits, renders = {}) => ({ stats: { commits, hostUpdates: 0, renders } });
const ceilings = { revisions: { probe: 2, bench: 5 }, exact: { "hover.commits": 25, "idle.commits": 0, "small.launch.commits": 10 }, noisy: {}, micro: {}, instr: {} };

test("a count over in the first run and back under in the retry passes, as with a full rerun", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-retry-"));
  const first = report(dir, "ratchet", "big", [{ hover: stats(26), idle: stats(0) }]);
  const small = report(dir, "satchet", "small", [{ launch: stats(10) }]);
  const again = report(dir, "ratchet-again", "big", [{ hover: stats(25) }]);
  assert.equal(evaluate(ceilings, { files: [first, small] }).rows.filter((r) => r.kind === "over").length, 1);
  const result = evaluate(ceilings, { files: [first, small], retryFiles: [again] });
  assert.deepEqual(result.rows.filter((r) => r.kind === "over"), []);
  assert.ok(result.ran.has("idle") && result.ran.has("hover") && result.ran.has("small.launch"));
});

test("a count over in both runs fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-retry-"));
  const first = report(dir, "ratchet", "big", [{ hover: stats(27), idle: stats(0) }]);
  const again = report(dir, "ratchet-again", "big", [{ hover: stats(26) }]);
  const result = evaluate(ceilings, { files: [first], retryFiles: [again] });
  assert.deepEqual(result.rows.filter((r) => r.kind === "over").map((r) => [r.key, r.value]), [["hover.commits", 26]]);
});

test("scenarios the retry didn't run keep their first-run verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-retry-"));
  const first = report(dir, "ratchet", "big", [{ hover: stats(26), idle: stats(1) }]);
  const again = report(dir, "ratchet-again", "big", [{ hover: stats(25) }]);
  const result = evaluate(ceilings, { files: [first], retryFiles: [again] });
  assert.deepEqual(result.rows.filter((r) => r.kind === "over").map((r) => r.key), ["idle.commits"]);
});

test("a named count seen only in one of the two runs counts as zero in the other", () => {
  const first = { values: { "hover.renders.Row": [3] }, runsBySeed: { big: 1, small: 0 }, ran: new Set(["hover"]) };
  const retry = { values: { "hover.renders.Other": [2] }, runsBySeed: { big: 1, small: 0 }, ran: new Set(["hover"]) };
  assert.deepEqual(withRetry(first, retry).values, { "hover.renders.Row": [3, 0], "hover.renders.Other": [0, 2] });
});

test("nodes left behind fail on either run, so a retry can't wash out a leak", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-retry-"));
  const leak = { ...ceilings, exact: { "nodeChurn.nativeNodesLeft": 0 } };
  const first = report(dir, "ratchet", "big", [{ nodeChurn: { left: 3 } }]);
  const again = report(dir, "ratchet-again", "big", [{ nodeChurn: { left: 0 } }]);
  assert.deepEqual(evaluate(leak, { files: [first], retryFiles: [again] }).rows.filter((r) => r.kind === "over").map((r) => r.key), ["nodeChurn.nativeNodesLeft"]);
});

test("lanes run at the same time", async () => {
  const started = Date.now();
  const nap = `setTimeout(() => {}, 600)`;
  await allFinished([spawnAsync(process.execPath, ["-e", nap]), spawnAsync(process.execPath, ["-e", nap]), spawnAsync(process.execPath, ["-e", nap])]);
  assert.ok(Date.now() - started < 1500, `three 600 ms lanes took ${Date.now() - started} ms`);
});

test("a failing lane fails the run only after the others have finished, so no instance is left running", async () => {
  const done = [];
  const slow = spawnAsync(process.execPath, ["-e", "setTimeout(() => {}, 400)"]).then(() => done.push("slow"));
  const fail = spawnAsync(process.execPath, ["-e", "process.exit(3)"]);
  await assert.rejects(allFinished([slow, fail]), /exited with 3/);
  assert.deepEqual(done, ["slow"]);
});

test("a lane's stdout is captured when asked", async () => {
  assert.equal(await spawnAsync(process.execPath, ["-e", "console.log('COUNTS {}')"], { capture: true }), "COUNTS {}\n");
});

test("stopping the ratchet stops its lanes and waits for each to clean up", async () => {
  const { mkdtempSync, existsSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "ratchet-stop-"));
  const marker = join(dir, "cleaned");
  const lane = `process.on("SIGTERM", () => setTimeout(() => { require("fs").writeFileSync(${JSON.stringify(marker)}, "1"); process.exit(0); }, 200)); setInterval(() => {}, 1000);`;
  const running = spawnAsync(process.execPath, ["-e", lane]).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await stopLanes();
  assert.ok(existsSync(marker), "stopLanes returned before the lane finished its cleanup");
  await running;
});

test("an instance opened but not yet found by pid is still quit when js-bench is stopped", async () => {
  const quit = [];
  let looks = 0;
  await stopInstances({ pids: new Set(), binaries: new Set(["/x/Ardia"]), find: () => (++looks < 3 ? [] : [42]), stop: async (pid) => quit.push(pid), waitMs: 2000 });
  assert.deepEqual(quit, [42]);
});
