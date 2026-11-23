import assert from "node:assert/strict";
import { after, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { pagerFor } = await import("./profilePager.ts");

const S = () => useBrowser.getState();

test("a window that exists keeps one pager; a missing window gets a throwaway that isn't kept", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  assert.equal(pagerFor(w), pagerFor(w));
  assert.notEqual(pagerFor("w-gone"), pagerFor("w-gone"));
});

const { pagerSnapshots } = await import("../../test-native/ardiacore.ts");
const { takePagerCounts } = await import("../telemetry/pagerCounts.ts");
globalThis.fetch = async () => ({ status: 200 });
const telemetry = await import("../telemetry/client.ts");
telemetry.setSharing(true, "onboarding");
after(() => telemetry.setSharing(false, "settings"));

let sequence = 100;
function threeProfiles() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const b = S().createProfile({ name: "B" });
  const c = S().createProfile({ name: "C" });
  const order = S().profileOrder;
  S().switchProfile(w, order[0]);
  takePagerCounts();
  const pager = pagerFor(w);
  const native = (phase, selected, event) => {
    const snapshot = { sequence: ++sequence, selectionSequence: sequence, position: selected, selected, phase, velocity: 0, count: order.length, profileId: order[selected] };
    pagerSnapshots.set(w, snapshot);
    if (event) pager.onNativeState({ phase: event, sequence: snapshot.sequence, position: selected, selected, velocity: 0, profileId: order[selected] });
  };
  return { w, order, pager, native, b, c, held: () => pager.state.getState().held, warm: () => pager.state.getState().pages.map((p) => p.id) };
}

test("a swipe holds the sidebar's page on the profile it started from until the pages come to rest", () => {
  const { w, order, native, held } = threeProfiles();
  native("tracking", 0, "began");
  assert.equal(held(), order[0]);
  native("settling", 1, "selected");
  assert.equal(S().windows[w].profileId, order[1], "the window switches when the swipe is let go");
  assert.equal(held(), order[0], "the sidebar keeps its page until the pages rest");
  native("idle", 1, "settled");
  assert.equal(held(), null);
  assert.equal(takePagerCounts().profile_pager_switches_after_rest, 1);
});

test("a rubber band at the edge holds and lets go without counting a held switch", () => {
  const { native, held } = threeProfiles();
  native("tracking", 0, "began");
  native("settling", 0);
  native("idle", 0, "settled");
  assert.equal(held(), null);
  assert.equal(takePagerCounts().profile_pager_switches_after_rest, 0);
});

test("a fast double swipe keeps holding the first profile and lands on the last one", () => {
  const { w, order, native, held, warm } = threeProfiles();
  assert.deepEqual(warm(), [order[0], order[1]]);
  native("tracking", 0, "began");
  native("settling", 1, "selected");
  native("tracking", 1, "began");
  native("settling", 2, "selected");
  assert.equal(S().windows[w].profileId, order[2]);
  assert.equal(held(), order[0]);
  assert.deepEqual(warm(), [order[0], order[1]], "far neighbours wait; the page sliding out stays warm");
  native("idle", 2, "settled");
  assert.equal(held(), null);
  assert.deepEqual(warm(), [order[1], order[2]], "the neighbours follow once the pages rest");
});

test("the page that slides out of a third quick swipe is kept warm while it moves", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  for (const name of ["B", "C", "D"]) S().createProfile({ name });
  const order = S().profileOrder;
  S().switchProfile(w, order[0]);
  const pager = pagerFor(w);
  const native = (phase, selected, event) => {
    pagerSnapshots.set(w, { sequence: ++sequence, selectionSequence: sequence, position: selected, selected, phase, velocity: 0, count: order.length, profileId: order[selected] });
    pager.onNativeState({ phase: event, sequence, position: selected, selected, velocity: 0, profileId: order[selected] });
  };
  native("tracking", 0, "began");
  native("settling", 1, "selected");
  native("settling", 2, "selected");
  native("settling", 3, "selected");
  assert.deepEqual(pager.state.getState().pages.map((p) => p.id), [order[0], order[1], order[2]]);
  native("idle", 3, "settled");
  assert.deepEqual(pager.state.getState().pages.map((p) => p.id), [order[2], order[3]]);
});

test("a hold the native pager never ends with an event is let go by the watch once it sees the pages resting twice", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { native, held } = threeProfiles();
  native("tracking", 0, "began");
  native("settling", 1, "selected");
  native("idle", 1);
  t.mock.timers.tick(250);
  assert.equal(held() !== null, true, "one resting look could be the settled event still on its way");
  t.mock.timers.tick(250);
  assert.equal(held(), null);
  const counts = takePagerCounts();
  assert.equal(counts.profile_pager_rests_seen_by_watch, 1);
  assert.equal(counts.profile_pager_switches_after_rest, 1);
});

test("a profile switch from elsewhere during a hold lets the sidebar follow at once", () => {
  const { w, order, native, held } = threeProfiles();
  native("tracking", 0, "began");
  assert.equal(held(), order[0]);
  S().switchProfile(w, order[2]);
  assert.equal(held(), null);
  assert.equal(takePagerCounts().profile_pager_switches_after_rest, 0, "a switch from elsewhere is not one the sidebar waited on");
});
