import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

globalThis.__DEV__ = false;

const performance = import.meta.resolve("../../platform/performance.ts");
globalThis.busyTest = { tasks: [], lookups: 0, toasts: [], managed: 0 };
const stubs = {
  "../../platform/performance": `export * from ${JSON.stringify(performance)};
    export const listTasks = async () => (globalThis.busyTest.lookups++, globalThis.busyTest.tasks);
    export const isKeepActiveSiteValid = async () => true;
    export const childProcessCpu = async () => [];`,
  "../app/toasts": `export const useToasts = { getState: () => ({ toasts: {} }) };
    export const showToast = (windowId, title, message, options) => globalThis.busyTest.toasts.push({ windowId, title, message, ...options });`,
  "../extensions/actions": "export const openManageExtensions = () => void globalThis.busyTest.managed++;",
};
registerHooks({
  resolve(specifier, context, next) {
    if (!/\/state\/tabs\/(?:busyTabWatch|memorySaver)\.ts$/.test(context.parentURL ?? "") || !(specifier in stubs)) return next(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  },
});

const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { readHeat, sustainedBusy, busyFor, keptActive, siteToKeepActive, SUSTAINED_MS } = await import("./busyProcesses.ts");
const { watchBusyTabs, startBusyTabWatch } = await import("./busyTabWatch.ts");
const { takeBusyTabCounts } = await import("../telemetry/busyTabCounts.ts");
const { slowTimersForTests } = await import("../../platform/slowTimers.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "busy-tab-watch-test");

const S = () => useBrowser.getState();
const SECOND = 1000;
const MINUTE = 60 * SECOND;

test("a process counts as busy once its last two minutes of readings average 0.7 of a core or more", () => {
  const reading = (pid, cpuMs, started = 1, kind = "renderer") => ({ pid, started, kind, cpuMs });
  const at = 1_000_000;
  const run = (perTick, { from = 0, pid = 1, started = 1, heat = new Map(), base = 0 } = {}) => {
    let used = base;
    perTick.forEach((cores, i) => {
      used += i ? cores * 10_000 : 0;
      heat = readHeat(heat, [reading(pid, used, started)], at + (from + i) * 10 * SECOND);
    });
    return { heat, used };
  };
  const full = Array(13).fill(1);
  assert.deepEqual(sustainedBusy(run(full.slice(0, 12)).heat), [], "110 s at a full core isn't enough yet");
  let { heat } = run(full);
  assert.deepEqual(sustainedBusy(heat), [1], "120 s is");
  assert.equal(busyFor(heat.get(1), at + 120 * SECOND), SUSTAINED_MS);
  assert.deepEqual(sustainedBusy(run(Array(13).fill(0.6)).heat), [], "0.6 of a core never is");
  assert.deepEqual(sustainedBusy(run([1, 1, 1, 1, 1, 0.1, 1, 1, 1, 1, 1, 1, 1]).heat), [1], "one quiet reading in a busy run doesn't start the count again");
  assert.deepEqual(sustainedBusy(run([...full, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]).heat), [], "a run that has quietened down is no longer busy");
  heat = run(full).heat;
  heat = readHeat(heat, [], at + 130 * SECOND);
  assert.ok(!heat.has(1), "a process that ended is forgotten");
  heat = run(full).heat;
  heat = readHeat(heat, [reading(1, 0, 2)], at + 130 * SECOND);
  assert.deepEqual(sustainedBusy(heat), [], "a new process under a reused pid starts from its own first reading");
  const gapped = run(full.slice(0, 6)).heat;
  assert.deepEqual(sustainedBusy(run(full.slice(0, 7), { from: 8, heat: gapped, base: 60_000 }).heat), [], "readings too far apart (the watch was paused) don't continue a busy run");
});

test("kept-active sites match the tab's host and its subdomains, in Chrome's forms", () => {
  assert.ok(keptActive("https://music.youtube.com/watch", ["youtube.com"]));
  assert.ok(keptActive("https://youtube.com/", ["https://youtube.com/feed"]));
  assert.ok(keptActive("https://a.b.example.com/", ["[*.]example.com"]));
  assert.ok(!keptActive("https://notyoutube.com/", ["youtube.com"]));
  assert.ok(!keptActive("file:///tmp/x.html", ["tmp"]));
  assert.equal(siteToKeepActive("https://www.figma.com/file/1"), "figma.com");
  assert.equal(siteToKeepActive("about:blank"), null);
});

function windowWithHiddenTab(lastActiveAt) {
  S().hydrate({});
  const w = S().createWindow({ url: "https://front.example/" });
  const hidden = S().newTab(w, { url: "https://miner.example/page", background: true });
  S().updateTab(hidden, { title: "Busy Loop Page", lastActiveAt });
  const front = Object.keys(S().tabs).find((id) => id !== hidden);
  const slept = [];
  webviews.clear();
  for (const id of [front, hidden]) webviews.set(id, { sleepIfHidden: async () => (slept.push(id), []), discard: async () => "discarded" });
  return { w, hidden, front, slept };
}

async function burn(start, minutes, cores = { 41: 1 }, kinds = {}) {
  const used = {};
  for (let t = 0; t <= minutes * 6; t++) {
    const now = start + t * 10 * SECOND;
    await watchBusyTabs(now, async () => Object.entries(cores).map(([pid, c]) => ({ pid: +pid, started: 7, kind: kinds[pid] ?? "renderer", cpuMs: (used[pid] = (used[pid] ?? 0) + (t ? c * 10_000 : 0)) })));
  }
  return start + minutes * MINUTE;
}

test("a hidden tab that keeps a core busy for two minutes gets one warning; Sleep Tab puts it to sleep through the menu's path", async () => {
  const start = Date.now() + 1000 * MINUTE;
  const { w, hidden, slept } = windowWithHiddenTab(start - 10 * MINUTE);
  globalThis.busyTest.tasks = [{ id: 1, pid: 41, type: "renderer", title: "Tab: Busy Loop Page", tabIds: [hidden] }];
  globalThis.busyTest.toasts.length = 0;
  globalThis.busyTest.lookups = 0;
  takeBusyTabCounts();
  await burn(start, 1.5);
  assert.equal(globalThis.busyTest.toasts.length, 0, "90 seconds isn't enough");
  assert.equal(globalThis.busyTest.lookups, 0, "and nobody asked Chrome's task manager which tabs the process holds");
  const end = await burn(start, 2);
  assert.equal(globalThis.busyTest.toasts.length, 1);
  const warning = globalThis.busyTest.toasts[0];
  assert.equal(warning.windowId, w);
  assert.equal(warning.title, "“Busy Loop Page” is using a lot of energy");
  assert.equal(warning.message, "Busy in the background for 2 minutes.");
  assert.deepEqual([warning.secondary.title, warning.action.title], ["Keep Running", "Sleep Tab"]);
  assert.equal(globalThis.busyTest.lookups, 1);
  await burn(end, 3);
  assert.equal(globalThis.busyTest.toasts.length, 1, "a warning left unanswered isn't repeated right away");
  warning.action.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(slept, [hidden]);
  const counts = takeBusyTabCounts();
  assert.equal(counts.busy_tab_warnings, 1);
  assert.equal(counts.busy_tab_slept, 1);
  assert.ok(counts.busy_tab_watch_ticks >= 30);
  webviews.clear();
});

test("Keep Running keeps the site active from then on, so neither this tab nor the site is warned about again", async () => {
  const start = Date.now() + 2000 * MINUTE;
  const { hidden } = windowWithHiddenTab(start - 10 * MINUTE);
  globalThis.busyTest.tasks = [{ id: 1, pid: 41, type: "renderer", title: "Tab", tabIds: [hidden] }];
  globalThis.busyTest.toasts.length = 0;
  await burn(start, 2);
  globalThis.busyTest.toasts[0].secondary.run();
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(S().settings.keepActiveSites, ["miner.example"]);
  await burn(start + 200 * MINUTE, 3);
  assert.equal(globalThis.busyTest.toasts.length, 1);
  assert.equal(takeBusyTabCounts().busy_tab_kept_running, 1);
  webviews.clear();
});

test("no warning for a busy process that holds a shown tab, a tab seen in the last two minutes, or a playing tab", async () => {
  const start = Date.now() + 3000 * MINUTE;
  const { hidden, front } = windowWithHiddenTab(start - 10 * MINUTE);
  globalThis.busyTest.toasts.length = 0;
  globalThis.busyTest.tasks = [{ id: 1, pid: 41, type: "renderer", title: "Tab", tabIds: [hidden, front] }];
  await burn(start, 3);
  assert.equal(globalThis.busyTest.toasts.length, 0, "the busy process also draws the tab in front");
  windowWithHiddenTab(start - 10 * MINUTE);
  const { hidden: recent } = windowWithHiddenTab(start + 5 * MINUTE);
  globalThis.busyTest.tasks = [{ id: 1, pid: 42, type: "renderer", title: "Tab", tabIds: [recent] }];
  await burn(start + 4 * MINUTE, 2, { 42: 1 });
  assert.equal(globalThis.busyTest.toasts.length, 0, "it was in front a minute into the busy run, so it has been hidden for only one");
  const { hidden: playing } = windowWithHiddenTab(start - 10 * MINUTE);
  S().updateLive(playing, { playingAudio: true });
  globalThis.busyTest.tasks = [{ id: 1, pid: 43, type: "renderer", title: "Tab", tabIds: [playing] }];
  await burn(start + 10 * MINUTE, 3, { 43: 1 });
  assert.equal(globalThis.busyTest.toasts.length, 0, "a playing tab is meant to be working");
  webviews.clear();
});

test("a looping extension gets its own warning, with Manage and Ignore", async () => {
  const start = Date.now() + 4000 * MINUTE;
  windowWithHiddenTab(start - 10 * MINUTE);
  globalThis.busyTest.toasts.length = 0;
  globalThis.busyTest.tasks = [{ id: 9, pid: 77, type: "extension", title: "Extension: Spinner", tabIds: [] }];
  await burn(start, 2, { 77: 0.9 }, { 77: "extension" });
  assert.equal(globalThis.busyTest.toasts.length, 1);
  const warning = globalThis.busyTest.toasts[0];
  assert.equal(warning.title, "“Spinner” is using a lot of energy");
  assert.deepEqual([warning.secondary.title, warning.action.title], ["Ignore", "Manage"]);
  warning.action.run();
  assert.equal(globalThis.busyTest.managed, 1);
  webviews.clear();
});

test("the watch has no timer while no loaded tab is hidden, and starts one when a tab goes to the background", () => {
  const timers = slowTimersForTests(() => Date.now());
  timers.clear();
  S().hydrate({});
  const w = S().createWindow({ url: "https://front.example/" });
  webviews.clear();
  for (const id of Object.keys(S().tabs)) webviews.set(id, {});
  startBusyTabWatch();
  assert.equal(timers.pending(), null, "only the tab in front is loaded");
  const hidden = S().newTab(w, { url: "https://other.example/", background: true });
  webviews.set(hidden, {});
  S().updateTab(hidden, { title: "Other" });
  assert.notEqual(timers.pending(), null);
  S().closeTabs([hidden]);
  webviews.delete(hidden);
  S().updateTab(Object.keys(S().tabs)[0], { title: "Front" });
  assert.equal(timers.pending(), null, "and stops it again once none is");
  timers.clear();
  webviews.clear();
});
