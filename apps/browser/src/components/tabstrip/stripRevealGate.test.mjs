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

const { endSettling, isOwnScroll, NO_OWN_SCROLL, ownScroll, revealStillWanted } = await import("./stripRevealGate.ts");

test("a scroll the strip made is its own, and a wheel step during its window is the user's", () => {
  const jump = ownScroll(0, 4585, false, 1080);
  assert.equal(isOwnScroll(jump, 4585, 4585, 6000, 1010), true);
  assert.equal(isOwnScroll(jump, 4625, 4585, 6000, 1010), false, "a step past the target inside the 80 ms window");
  assert.equal(isOwnScroll(jump, 4545, 4585, 6000, 1010), false, "a step back inside the window");
  assert.equal(isOwnScroll(jump, 3200, 4585, 3200, 1010), true, "landing on the native end when the target was past it");
  const glide = ownScroll(100, 900, true, 1600);
  assert.equal(isOwnScroll(glide, 500, 400, 6000, 1300), true, "on the way of an animated reveal");
  assert.equal(isOwnScroll(glide, 1100, 900, 6000, 1300), false);
  assert.equal(isOwnScroll(glide, 500, 900, 6000, 1700), false, "back over the way once the glide is done");
  assert.equal(isOwnScroll(NO_OWN_SCROLL, 300, 0, 6000, 0), false);
  assert.equal(isOwnScroll(NO_OWN_SCROLL, 1800, 2400, 1800, 0), true, "AppKit clamping to a shorter strip's end");
});

test("a wheel step during the first reveal's own scroll cancels the measuring recheck", () => {
  const first = firstOverflowReveal(FIRST_REVEAL, at({ measuring: true, now: 1000 }));
  assert.equal(first.reveal, true);
  const jump = ownScroll(0, 4585, false, 1080);
  assert.equal(isOwnScroll(jump, 4625, 4585, 6000, 1020), false);
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
