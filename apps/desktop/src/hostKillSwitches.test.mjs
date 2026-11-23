import assert from "node:assert/strict";
import test from "node:test";
import { hostSwitchesFetch } from "./hostKillSwitches.ts";

test("the kill-switch file comes through the native host and every other fetch is left alone", async () => {
  const calls = [];
  const host = { bootstrap: { capabilities: ["ArdiaShell.fetchKillSwitches"] }, invoke: async (method) => (calls.push(method), { status: 200, body: "{\"version\":1,\"switches\":{}}" }) };
  const original = async (input) => new Response(`original ${input}`);
  const fetchFn = hostSwitchesFetch(host, original);
  assert.equal(await (await fetchFn("https://ardia.dev/switches.json")).text(), "{\"version\":1,\"switches\":{}}");
  assert.equal(await (await fetchFn("https://example.com/")).text(), "original https://example.com/");
  assert.deepEqual(calls, ["ArdiaShell.fetchKillSwitches"]);
  const refused = hostSwitchesFetch({ ...host, invoke: async () => ({ status: 0, body: "" }) }, original);
  await assert.rejects(refused("https://ardia.dev/switches.json"), TypeError);
});

test("the switch refresh through the native host updates the cached switches", async () => {
  globalThis.__DEV__ = false;
  await import("../../browser/src/test-native/index.ts");
  const { refreshSwitches, resetRefreshForTests } = await import("../../browser/src/platform/killSwitches.ts");
  resetRefreshForTests();
  const host = { bootstrap: { capabilities: [] }, invoke: async () => ({ status: 200, body: JSON.stringify({ version: 1, switches: { newTabPrewarm: false } }) }) };
  assert.equal(await refreshSwitches(hostSwitchesFetch(host, async () => { throw new Error("the shell can't fetch"); })), "updated");
});
