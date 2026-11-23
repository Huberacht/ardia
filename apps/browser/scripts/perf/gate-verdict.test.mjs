import assert from "node:assert/strict";
import { test } from "node:test";
import { GATE_ROWS, gateVerdict, rowVerdict } from "./gate-verdict.mjs";

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
