import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { cardMotionFor, dockSlides, DOCKED_LAYOUT_DEADLINE_MS } = await import("./dockMotion.ts");

function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    later: (run, ms) => (timers.set(next, { at: now + ms, run }), next++),
    cancel: (handle) => void timers.delete(handle),
    advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) return;
        timers.delete(due[0]);
        due[1].run();
      }
    },
  };
}

test("the card slides on the compositor only where nothing on it has to follow its edge: macOS, beside a sidebar, no toolbar row on the card, outside split view", () => {
  const at = (o) => cardMotionFor({ compositor: true, topTabs: false, split: false, cardToolbar: false, ...o });
  assert.equal(at({}), "compositor", "the address bar in the sidebar");
  assert.equal(at({ cardToolbar: true }), "frames", "#3732: the card's toolbar buttons would sit under the clip mid-slide");
  assert.equal(at({ topTabs: true }), "frames", "#3732: tabs across the top moved the page off its frame, so clicks missed");
  assert.equal(at({ split: true }), "frames");
  assert.equal(at({ compositor: false }), "frames", "#3732: Windows and Linux draw the page outside the card's layer");
});

test("a show's final layout ends the motion once it lands, a tick later", () => {
  const clock = fakeClock();
  let still = 0;
  const slides = dockSlides(clock, () => still++);
  const id = slides.begin();
  assert.equal(slides.awaitLayout(id, () => assert.fail("not overdue")), true);
  slides.laidOut();
  assert.equal(still, 0);
  clock.advance(0);
  assert.equal(still, 1);
  clock.advance(DOCKED_LAYOUT_DEADLINE_MS);
  assert.equal(still, 1);
});

test("a show whose layout never reports ends the motion at the deadline and counts it overdue", () => {
  const clock = fakeClock();
  let still = 0;
  let overdue = 0;
  const slides = dockSlides(clock, () => still++);
  slides.awaitLayout(slides.begin(), () => overdue++);
  clock.advance(DOCKED_LAYOUT_DEADLINE_MS);
  assert.deepEqual([still, overdue], [1, 1]);
});

test("a hide that starts between a show's landing and its tick keeps the motion (#3732: it released the deferred measure mid-slide)", () => {
  const clock = fakeClock();
  let still = 0;
  const slides = dockSlides(clock, () => still++);
  const show = slides.begin();
  slides.awaitLayout(show, () => {});
  slides.laidOut();
  const hide = slides.begin();
  clock.advance(DOCKED_LAYOUT_DEADLINE_MS * 2);
  assert.equal(still, 0);
  assert.equal(slides.isCurrent(show), false);
  assert.equal(slides.isCurrent(hide), true);
  assert.equal(slides.awaitLayout(show, () => {}), false, "a stale completion can't wait for a layout");
});

test("unmounting drops a pending landing", () => {
  const clock = fakeClock();
  let still = 0;
  const slides = dockSlides(clock, () => still++);
  slides.awaitLayout(slides.begin(), () => {});
  slides.end();
  slides.laidOut();
  clock.advance(DOCKED_LAYOUT_DEADLINE_MS);
  assert.equal(still, 0);
});
