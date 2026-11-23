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
let kept = 0;
globalThis.acTestCliHeld = (tabIds) => {
  pushed.push([...tabIds].sort());
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
  await ok("tabs.hold", { session: "b", tabs: [ids[1]], seconds: 60 });
  await settled();
  assert.deepEqual(pushed.at(-1), [...ids].sort(), "both sessions' tabs");
  await ok("tabs.release", { session: "a" });
  await settled();
  assert.deepEqual(pushed.at(-1), [ids[1]]);
  leaseClock += 61_000;
  await settled();
  assert.deepEqual(pushed.at(-1), [], "a hold that ran out is gone from the engine too");
  await ok("tabs.hold", { session: "a", tabs: [ids[0]], seconds: 60 });
  releaseAllCliHolds();
  await settled();
  assert.deepEqual(pushed.at(-1), [], "stopping the socket releases every hold, and the engine hears it");
});

test("the discards Chromium wanted for a held tab are counted once each, and only while sharing is on", async () => {
  takeTabSleepCounts();
  kept = 2;
  await settled();
  assert.equal(takeTabSleepCounts().chrome_discards_kept_for_cli, 2);
  setConsentPeriod(false, "cli-holds-engine-test");
  kept = 3;
  const pushedWhileOff = settled();
  setConsentPeriod(true, "cli-holds-engine-test");
  await pushedWhileOff;
  assert.equal(takeTabSleepCounts().chrome_discards_kept_for_cli, 0, "nothing counted while sharing was off");
});

test("the engine's kept-by code 103 is a CLI session, and a person's own Sleep Tab still wins over it", () => {
  assert.equal(engineVeto([103]), "cliSession");
  assert.equal(engineVeto([103, 100]), "postedDocument", "a form post outranks it");
  assert.equal(onlyAutomaticProtections([103]), true, "Sleep Tab from the menu goes past it");
  assert.equal(onlyAutomaticProtections([103, 5]), false, "but not past audio");
});
