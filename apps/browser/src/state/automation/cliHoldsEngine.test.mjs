import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const { cliHoldsClockForTests, releaseAllCliHolds } = await import("../tabs/cliHolds.ts");
const { pushCliHoldsToEngine } = await import("./cliHoldsEngine.ts");
const { engineVeto } = await import("../tabs/sleepPolicy.ts");
const { onlyAutomaticProtections } = await import("../tabs/sleepRefusals.ts");
const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "cli-holds-engine-test");

let leaseClock = 0;
cliHoldsClockForTests(() => leaseClock);
const pushed = [];
const seconds = [];
let kept = 0;
globalThis.acTestCliHeld = (tabs) => {
  pushed.push(tabs.map((t) => t.tabId).sort());
  seconds.push(Object.fromEntries(tabs.map((t) => [t.tabId, t.seconds])));
  const answer = { kept };
  kept = 0;
  return answer;
};

after(() => {
  releaseAllCliHolds();
  cliHoldsClockForTests(() => performance.now());
  delete globalThis.acTestCliHeld;
  S().updateSettings({ cliControl: false });
});

const { ok } = socketClient(312);

const { consentToken } = await import("../telemetry/client.ts");
const settled = () => pushCliHoldsToEngine(consentToken());

test("every hold change hands the engine the tabs held right now, and the socket stopping hands it none", async () => {
  releaseAllCliHolds();
  const { windowId } = await freshWindow("https://shown.example/");
  const ids = ["https://one.example/", "https://two.example/"].map((url) => S().newTab(windowId, { url, background: true }));
  await settled();
  pushed.length = 0;
  await ok("tabs.hold", { session: "a", tabs: [ids[0]], seconds: 60 });
  assert.deepEqual(pushed.at(-1), [ids[0]], "tabs.hold answers only once the engine has the tab");
  assert.deepEqual(seconds.at(-1), { [ids[0]]: 60 }, "with the seconds its hold has left, so the engine ends it even if the app forgets");
  await ok("tabs.hold", { session: "b", tabs: [ids[1], ids[0]], seconds: 30 });
  assert.deepEqual(pushed.at(-1), [...ids].sort(), "both sessions' tabs");
  assert.deepEqual(seconds.at(-1), { [ids[0]]: 60, [ids[1]]: 30 }, "a tab two sessions hold lasts as long as the longer hold");
  await ok("tabs.release", { session: "a" });
  await settled();
  assert.deepEqual(seconds.at(-1), { [ids[0]]: 30, [ids[1]]: 30 }, "one session's release leaves the other's hold, now the shorter one");
  leaseClock += 61_000;
  await settled();
  assert.deepEqual(pushed.at(-1), [], "a hold that ran out is gone from the engine too");
  await ok("tabs.hold", { session: "a", tabs: [ids[0]], seconds: 60 });
  releaseAllCliHolds();
  await settled();
  assert.deepEqual(pushed.at(-1), [], "stopping the socket releases every hold, and the engine hears it");
});

test("the discards Chromium asked for on held tabs are counted for the sharing period they happened in", async () => {
  await settled();
  takeTabSleepCounts();
  kept = 2;
  await settled();
  assert.equal(takeTabSleepCounts().chrome_discards_kept_for_cli, 2, "counted since the last push, which sharing covered");
  setConsentPeriod(false, "cli-holds-engine-test");
  await settled();
  kept = 3;
  setConsentPeriod(true, "cli-holds-engine-test");
  await settled();
  assert.equal(takeTabSleepCounts().chrome_discards_kept_for_cli, 0, "what the engine counted while sharing was off isn't sent once it's back on");
  kept = 1;
  await settled();
  assert.equal(takeTabSleepCounts().chrome_discards_kept_for_cli, 1, "the next period, all under sharing, counts again");
});

test("the engine's kept-by code 103 is a CLI session, and a person's own Sleep Tab still wins over it", () => {
  assert.equal(engineVeto([103]), "cliSession");
  assert.equal(engineVeto([103, 100]), "postedDocument", "a form post outranks it");
  assert.equal(onlyAutomaticProtections([103]), true, "Sleep Tab from the menu goes past it");
  assert.equal(onlyAutomaticProtections([103, 5]), false, "but not past audio");
});
