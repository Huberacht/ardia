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

const at = (o) => ({ current: true, activeId: "t", dragging: false, pressHeld: false, overflows: true, measuring: false, userScrollAt: -Infinity, now: 1000, ...o });

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

const { commandScroll, endSettling, observeScroll, revealStillWanted, scrollIntentAt } = await import("./stripRevealGate.ts");

const run = (intent, steps, max = 6000) => {
  let users = 0;
  for (const [x, now] of steps) {
    const step = observeScroll(intent, x, max, now);
    intent = step.intent;
    if (step.user) users++;
  }
  return { intent, users };
};

test("many sub-pixel wheel steps add up against a stable baseline and count as the user's", () => {
  const steps = Array.from({ length: 30 }, (_, i) => [500 + (i + 1) * 0.5, 1000 + i * 16]);
  assert.ok(run(scrollIntentAt(500), steps).users > 0);
  assert.equal(run(scrollIntentAt(500), [[500.5, 1000]]).users, 0, "half a point alone is not yet a scroll");
});

test("a scroll the strip asked for is its own, and it is retired once it lands", () => {
  const jump = commandScroll(0, 4585, false, 1080);
  const landed = run(jump, [[4585, 1010]]);
  assert.equal(landed.users, 0);
  assert.equal(landed.intent.command, null);
  assert.equal(run(landed.intent, [[4584.5, 1020], [4584, 1030]]).users, 1, "later movement either way is the user's, even inside the old window");
  assert.equal(run(jump, [[4625, 1010]]).users, 1, "a step past a jump's target");
  assert.equal(run(commandScroll(2400, 4585, false, 1080), [[3200, 1010]], 3200).users, 0, "landing on the native end when the target was past it");
  assert.equal(run(scrollIntentAt(2400), [[1800, 1000]], 1800).users, 0, "AppKit clamping to a shorter strip's end");
});

test("a reverse wheel step during an animated reveal counts as the user's", () => {
  const glide = commandScroll(100, 900, true, 1600);
  assert.equal(run(glide, [[300, 1100], [500, 1200]]).users, 0, "forward along the way");
  assert.equal(run(glide, [[300, 1100], [500, 1200], [460, 1210]]).users, 1, "back from 500 to 460");
  assert.equal(run(glide, [[300, 1100], [500, 1200], [499.6, 1210], [499.2, 1220], [498.8, 1230], [498.4, 1240]]).users, 1, "back in sub-pixel steps");
  const arrived = run(glide, [[500, 1200], [900, 1300]]);
  assert.equal(arrived.intent.command, null);
  assert.equal(run(arrived.intent, [[860, 1350]]).users, 1, "a reverse step after it arrived, with the window still open");
  assert.equal(run(glide, [[950, 1300]]).users, 1, "past the target");
  assert.equal(run(glide, [[500, 1700]]).users, 1, "still moving after the glide's time");
});

test("a wheel step during the first reveal's own scroll cancels the measuring recheck", () => {
  const first = firstOverflowReveal(FIRST_REVEAL, at({ measuring: true, now: 1000 }));
  assert.equal(first.reveal, true);
  const wheel = observeScroll(commandScroll(0, 4585, false, 1080), 4625, 6000, 1020);
  assert.equal(wheel.user, true);
  const taken = endSettling(first.state);
  assert.equal(firstOverflowReveal(taken, at({ measuring: false, userScrollAt: -Infinity, now: 1200 })).reveal, false, "the group finishing its measure doesn't undo the user's scroll");
});

test("a user scroll during a pending reveal leaves the strip where the user put it", () => {
  const pending = { tabId: "t9", scrolls: 3 };
  const still = { tabId: "t9", scrolls: 3, current: true, dragging: false };
  assert.equal(revealStillWanted(pending, still), true);
  assert.equal(revealStillWanted(pending, { ...still, scrolls: 4 }), false, "a newer user scroll cancels it, not delays it");
  assert.equal(revealStillWanted(pending, { ...still, tabId: "t2" }), false, "another selection");
  assert.equal(revealStillWanted(pending, { ...still, current: false }), false, "another profile in front");
  assert.equal(revealStillWanted(pending, { ...still, dragging: true }), false, "a drag started");
});

test("a strip that first overflows while a tab press is held reveals once the press ends, as later reveals do", () => {
  const held = firstOverflowReveal(FIRST_REVEAL, at({ pressHeld: true }));
  assert.equal(held.reveal, false);
  assert.equal(held.state, FIRST_REVEAL, "the first reveal stays pending");
  assert.equal(firstOverflowReveal(held.state, at({ now: 1400 })).reveal, true);
});
