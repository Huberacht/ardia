import assert from "node:assert/strict";
import { test } from "node:test";
const { FIRST_REVEAL, firstOverflowReveal, selectionReveal } = await import("./stripRevealGate.ts");

test("a tab selected while its profile's page is away waits, and is revealed once that page is back", () => {
  let revealed = "a";
  assert.equal(selectionReveal(revealed, "b", false, false, false), "wait");
  assert.equal(revealed, "a", "waiting leaves the reveal pending");
  assert.equal(selectionReveal(revealed, "b", false, true, false), "run");
  revealed = "b";
  assert.equal(selectionReveal(revealed, "b", false, true, false), "none");
});

test("a reveal scheduled and then cancelled by a profile switch runs again when the page comes back", () => {
  const revealed = "a";
  assert.equal(selectionReveal(revealed, "b", false, true, false), "run");
  assert.equal(selectionReveal(revealed, "b", false, false, false), "wait");
  assert.equal(selectionReveal(revealed, "b", false, true, false), "run");
});

test("a dragged or missing tab and a held close are never revealed", () => {
  assert.equal(selectionReveal("a", "b", false, true, true), "drop");
  assert.equal(selectionReveal("a", "", false, true, false), "drop");
  assert.equal(selectionReveal("a", "b", true, true, false), "none");
});

const at = (o) => ({ current: true, activeId: "t", dragging: false, overflows: true, measuring: false, userScrollAt: -Infinity, now: 1000, ...o });

test("the first reveal waits for the page to be current and the strip to overflow", () => {
  assert.equal(firstOverflowReveal(FIRST_REVEAL, at({ current: false })).reveal, false);
  assert.equal(firstOverflowReveal(FIRST_REVEAL, at({ current: false })).state, FIRST_REVEAL, "an inactive page doesn't use it up");
  assert.equal(firstOverflowReveal(FIRST_REVEAL, at({ overflows: false })).reveal, false);
  const first = firstOverflowReveal(FIRST_REVEAL, at({}));
  assert.equal(first.reveal, true);
  assert.equal(firstOverflowReveal(first.state, at({ now: 2000 })).reveal, false, "once is enough when nothing was still measuring");
});

test("a first reveal made while group chips were still measuring is made again once they are measured", () => {
  const first = firstOverflowReveal(FIRST_REVEAL, at({ measuring: true }));
  assert.equal(first.reveal, true);
  const still = firstOverflowReveal(first.state, at({ measuring: true, now: 1100 }));
  assert.equal(still.reveal, true, "each growth while measuring keeps the tab in view");
  const settled = firstOverflowReveal(still.state, at({ now: 1200 }));
  assert.equal(settled.reveal, true);
  assert.equal(firstOverflowReveal(settled.state, at({ now: 1300 })).reveal, false, "and then it stops");
});

test("a user scroll after the first reveal ends the rechecks", () => {
  const first = firstOverflowReveal(FIRST_REVEAL, at({ measuring: true }));
  const scrolled = firstOverflowReveal(first.state, at({ userScrollAt: 1050, now: 1200 }));
  assert.equal(scrolled.reveal, false);
  assert.equal(firstOverflowReveal(scrolled.state, at({ now: 1300 })).reveal, false);
});
