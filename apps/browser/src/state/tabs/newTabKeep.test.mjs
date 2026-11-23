import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { watchPageDrawn } = await import("./newTabKeep.ts");

const S = () => useBrowser.getState();
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

function aTab() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com" });
  return S().windows[w].tabIds[0];
}

test("a kept New Tab page goes once its page has loaded, a moment after the load ends", async () => {
  const tab = aTab();
  const calls = [];
  watchPageDrawn(tab, (timedOut) => calls.push(timedOut), 1000, 20);
  S().updateLive(tab, { isLoading: true });
  await wait(30);
  assert.deepEqual(calls, [], "nothing while the page loads");
  S().updateLive(tab, { isLoading: false });
  assert.deepEqual(calls, [], "not at the very moment the load ends");
  await wait(40);
  assert.deepEqual(calls, [false]);
});

test("a load that starts again before the pause ends keeps the page until that load ends too", async () => {
  const tab = aTab();
  const calls = [];
  watchPageDrawn(tab, (timedOut) => calls.push(timedOut), 1000, 30);
  S().updateLive(tab, { isLoading: true });
  S().updateLive(tab, { isLoading: false });
  await wait(10);
  S().updateLive(tab, { isLoading: true });
  await wait(50);
  assert.deepEqual(calls, []);
  S().updateLive(tab, { isLoading: false });
  await wait(50);
  assert.deepEqual(calls, [false]);
});

test("a page that never reports a load lets the New Tab page go at the deadline, once", async () => {
  const tab = aTab();
  const calls = [];
  watchPageDrawn(tab, (timedOut) => calls.push(timedOut), 40, 10);
  S().updateLive(tab, { canGoBack: true });
  await wait(80);
  assert.deepEqual(calls, [true]);
  S().updateLive(tab, { isLoading: true });
  S().updateLive(tab, { isLoading: false });
  await wait(30);
  assert.deepEqual(calls, [true], "nothing after it went");
});

test("a stopped watch never calls back", async () => {
  const tab = aTab();
  const calls = [];
  const stop = watchPageDrawn(tab, (timedOut) => calls.push(timedOut), 30, 10);
  S().updateLive(tab, { isLoading: true });
  stop();
  S().updateLive(tab, { isLoading: false });
  await wait(60);
  assert.deepEqual(calls, []);
});
