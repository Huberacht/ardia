import assert from "node:assert/strict";
import { test } from "node:test";
import { GATE_ROWS, gateVerdict, roundProblems, roundsProblems, rowVerdict } from "./gate-verdict.mjs";

const side = (values) => ({ values });
const round = (control, candidate) => ({ control: side(control), candidate: side(candidate) });

test("separated pooled ranges fail, even in one round", () => {
  const v = rowVerdict([round([80, 82, 83], [84, 85, 86])]);
  assert.equal(v.separate, true);
  assert.equal(v.fail, true);
  assert.equal(rowVerdict([round([80, 82, 85], [84, 85, 86])]).fail, false);
});

test("better and separated passes: only the worse direction fails", () => {
  assert.equal(rowVerdict([round([84, 85, 86], [80, 82, 83])]).fail, false);
});

test("worse in every round fails only when the pooled median moved more than the control's round-to-round spread", () => {
  const within = rowVerdict([round([340, 370, 391], [343, 382, 394]), round([313, 330, 350], [329, 345, 360]), round([320, 343, 360], [330, 347, 365])]);
  assert.equal(within.worseEveryRound, true);
  assert.ok(within.delta <= within.spread);
  assert.equal(within.fail, false);
  assert.match(within.why, /worse ×3 but Δ ≤ spread/);
  const beyond = rowVerdict([round([340, 350, 360], [345, 380, 400]), round([338, 352, 362], [349, 375, 401])]);
  assert.ok(beyond.spread < beyond.delta);
  assert.equal(beyond.fail, true);
  assert.match(beyond.why, /worse ×2, Δ > spread/);
});

test("a row better in one round never fails on the every-round clause", () => {
  const v = rowVerdict([round([0.2, 0.21], [0.4, 0.5]), round([0.3, 0.31], [0.2, 0.29])]);
  assert.equal(v.worseEveryRound, false);
  assert.equal(v.fail, false);
});

test("the gate reads every row by name, pooled, and calls a round with samples left out invalid", () => {
  const rows = (offset, left = 0) => [
    ...GATE_ROWS.map(([, name]) => ({ name, values: [10 + offset, 11 + offset, 12 + offset] })),
    { name: "samples left out: page couldn't paint (switch + new tab, per run)", values: [left, 0] },
  ];
  const pass = gateVerdict([{ control: rows(0), candidate: rows(0) }, { control: rows(0.5), candidate: rows(0.4) }]);
  assert.deepEqual(pass.fails, []);
  assert.deepEqual(pass.problems, []);
  assert.equal(pass.rows.length, GATE_ROWS.length);
  assert.equal(pass.rows[0].control.n, 6);
  const fail = gateVerdict([{ control: rows(0), candidate: rows(5) }]);
  assert.equal(fail.fails.length, GATE_ROWS.length);
  const invalid = gateVerdict([{ control: rows(0), candidate: rows(0, 3) }]);
  assert.match(invalid.problems.join(), /round 1, candidate: 3 samples left out/);
  const missing = gateVerdict([{ control: rows(0).slice(1), candidate: rows(0) }]);
  assert.match(missing.problems.join(), /no samples for "launch → window shown"/);
  assert.equal(missing.rows[0].missing, true);
});

const idle = { total: { cpu: 0.3, wakeups: 6 }, kinds: { browser: { cpu: 0.1, wakeups: 1.5 } } };
const win = { window: 50, firstPaint: 100, firstFrame: 80 };
const complete = (app = "/dist/0.2.48/export/Ardia.app") => ({
  meta: { only: ["launch", "session", "windows"], app },
  launch: Array.from({ length: 6 }, () => ({ window: 1, withContent: 1, js: 1, firstPaint: 1, firstFrame: 1 })),
  session: Array.from({ length: 2 }, () => ({ tabSwitch: Array(16).fill(7), newTab: Array(5).fill(80), newTabFrame: Array(5).fill(60), newWindow: Array(3).fill(win), idle: { tabs1: idle, tabs20: idle } })),
  windows: Array.from({ length: 2 }, () => ({ newWindow: Array(8).fill(win) })),
});

test("a complete round has no problems", () => {
  assert.deepEqual(roundProblems(complete()), []);
});

test("a row with one surviving sample makes the round invalid, it doesn't pass", () => {
  const r = complete();
  r.session[0].tabSwitch = r.session[0].tabSwitch.map((x, i) => (i ? NaN : x));
  assert.deepEqual(roundProblems(r), ["session 0: 1 of 16 tab switches"]);
});

test("a missing phase, run or idle window, a part-only session, or too few launches makes the round invalid", () => {
  const r = complete();
  r.meta.only = ["launch", "session"];
  r.windows = [];
  assert.deepEqual(roundProblems(r), ["it didn't run the windows phase", "0 windows runs, wanted 2"]);
  const s = complete();
  s.session.pop();
  s.session[0].idle.tabs20 = undefined;
  s.launch.pop();
  s.meta.parts = ["switch"];
  assert.deepEqual(roundProblems(s), ["its session runs measured only some parts", "5 launches, wanted 6", "1 session runs, wanted 2", "session 0: no tabs20 idle window"]);
  const w = complete();
  w.windows[1].newWindow[3] = { ...win, firstFrame: NaN };
  w.session[1].newWindow = [win, win];
  assert.deepEqual(roundProblems(w), ["session 1: 2 of 3 new windows", "windows 1: 7 of 8 new windows"]);
});

test("every round must have measured the same two apps, so a retry can't score an earlier build", () => {
  const ok = { control: complete("/dist/0.2.47/export/Ardia.app"), candidate: complete() };
  assert.deepEqual(roundsProblems([ok, ok]), []);
  const other = { control: ok.control, candidate: complete("/dist/0.2.49-rc/export/Ardia.app") };
  assert.match(roundsProblems([ok, other]).join(), /the candidate's app differs between rounds/);
  const prepared = (from) => ({ ...complete("/out/rc/app/Ardia.app"), meta: { ...complete().meta, app: "/out/rc/app/Ardia.app", preparedFrom: { app: from } } });
  assert.match(roundsProblems([{ control: ok.control, candidate: prepared("/dist/a") }, { control: ok.control, candidate: prepared("/dist/b") }]).join(), /differs between rounds/);
});

test("the judged rows are exactly the 19 the 0.2.47 and 0.2.48 gates' pooled tables judged; memory is reported beside them", () => {
  assert.deepEqual(GATE_ROWS.map(([label]) => label), [
    "launch → window shown", "launch → with content", "launch → JS running", "launch → first page painted", "launch → first frame",
    "new tab → first paint", "new tab → first frame", "tab switch → shown",
    "new window → on screen", "new window → first paint", "new window → first frame",
    "idle CPU 1 tab, all", "idle CPU 1 tab, browser", "idle wakeups 1 tab, all", "idle wakeups 1 tab, browser",
    "idle CPU 20 tab, all", "idle CPU 20 tab, browser", "idle wakeups 20 tab, all", "idle wakeups 20 tab, browser",
  ]);
  const memory = (mb) => [...GATE_ROWS.map(([, name]) => ({ name, values: [1, 2] })), { name: "memory (phys_footprint), 20 tab(s)", values: [mb, mb] }];
  const v = gateVerdict([{ control: memory(700), candidate: memory(900) }]);
  assert.deepEqual(v.fails, []);
  assert.equal(v.reported.find((r) => r.name === "memory (phys_footprint), 20 tab(s)").candidate, 900);
});
