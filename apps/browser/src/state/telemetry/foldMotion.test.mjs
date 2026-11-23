import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.requestAnimationFrame = (run) => setTimeout(run, 8);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
const { setConsentPeriod } = await import("./consentPeriod.ts");
const { noteFoldMotion, takeFoldMotionCounts } = await import("./foldMotion.ts");

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const block = (ms) => {
  for (const until = Date.now() + ms; Date.now() < until; );
};

test("a fold counts once it finishes, a frame more than 34 ms late is a stutter, one 50 ms past its plan an overrun", async () => {
  setConsentPeriod(true, "period-1");
  takeFoldMotionCounts();
  const smooth = noteFoldMotion(150);
  await wait(40);
  smooth.end(true);
  const stalled = noteFoldMotion(150);
  await wait(20);
  block(60);
  await wait(150);
  stalled.end(true);
  const stopped = noteFoldMotion(150);
  stopped.end(false);
  assert.deepEqual(takeFoldMotionCounts(), { sidebar_folds: 2, sidebar_fold_stutters: 1, sidebar_fold_overruns: 1 });
  assert.deepEqual(takeFoldMotionCounts(), { sidebar_folds: 0, sidebar_fold_stutters: 0, sidebar_fold_overruns: 0 });
});

test("a fold that starts with sharing off, or finishes after the sharing period changed, is not counted", async () => {
  setConsentPeriod(false, null);
  const unshared = noteFoldMotion(150);
  setConsentPeriod(true, "period-2");
  unshared.end(true);
  const crossed = noteFoldMotion(150);
  setConsentPeriod(true, "period-3");
  crossed.end(true);
  assert.deepEqual(takeFoldMotionCounts(), { sidebar_folds: 0, sidebar_fold_stutters: 0, sidebar_fold_overruns: 0 });
});
