import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../../state/browser/store.ts");
const { revealTab } = await import("../../state/sidebar/reveal.ts");
const { registerRow } = await import("../../state/sidebar/sidebarUi.ts");
const { revealTargets } = await import("../../state/sidebar/revealTargets.ts");
const { revealScrollFor, startRevealTabs } = await import("./useRevealTabs.ts");

const S = () => useBrowser.getState();
const frames = [];
globalThis.requestAnimationFrame = (step) => frames.push(step);
globalThis.cancelAnimationFrame = () => {};
const runFrames = () => {
  while (frames.length) frames.shift()();
};

S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
const w = S().createWindow({ url: "https://0.example/" });
for (let i = 1; i < 60; i++) S().newTab(w, { url: `https://${i}.example/` });
S().activate(S().windows[w].tabIds[0]);

const scrolls = [];
const scroll = { current: { scrollTo: (move) => scrolls.push(move) } };
const scrollY = { current: 0 };
const geometry = { current: { viewport: 300, regions: { pinnedGroups: 0, list: 0 }, newTabAtTop: false, tilesFixed: false } };
const stop = startRevealTabs(w, scroll, scrollY, geometry);
runFrames();

test("opening a tab whose row is out of view scrolls the sidebar once, without animation", () => {
  scrollY.current = 0;
  scrolls.length = 0;
  S().newTab(w, { url: "https://new.example/" });
  runFrames();
  assert.equal(scrolls.length, 1, JSON.stringify(scrolls));
  assert.equal(scrolls[0].animated, false);
  assert.equal(frames.length, 0, "no per-frame glide follows");
});

test("switching to a tab whose row is out of view scrolls the sidebar once, without animation", () => {
  const ids = S().windows[w].tabIds;
  S().activate(ids[0]);
  runFrames();
  scrollY.current = 0;
  scrolls.length = 0;
  S().activate(ids[45]);
  runFrames();
  assert.equal(scrolls.length, 1, JSON.stringify(scrolls));
  assert.equal(scrolls[0].animated, false);
  assert.equal(frames.length, 0);
});

test("a tab whose row isn't mounted yet is revealed once the rows grow down to it, never into an empty spacer", () => {
  const ids = S().windows[w].tabIds;
  S().activate(ids[0]);
  runFrames();
  let shown = 20;
  geometry.current.entriesShown = () => shown;
  scrollY.current = 0;
  scrolls.length = 0;
  S().activate(ids[45]);
  runFrames();
  assert.equal(scrolls.length, 0, "rows mounted to 20 of 46: no scroll yet");
  shown = 52;
  geometry.current.laidOut?.();
  runFrames();
  assert.equal(scrolls.length, 1, "the rows reached it: one scroll");
  delete geometry.current.entriesShown;
});

const waitForRows = (shown) => {
  const box = { shown };
  geometry.current.entriesShown = () => box.shown;
  return box;
};
const grow = (box, shown) => {
  box.shown = shown;
  geometry.current.laidOut?.();
  runFrames();
};
const atTop = () => {
  delete geometry.current.entriesShown;
  S().activate(S().windows[w].tabIds[0]);
  runFrames();
  scrollY.current = 0;
  scrolls.length = 0;
};

test("a reveal waiting for its rows is dropped when the user scrolls that page meanwhile", async () => {
  atTop();
  const rows = waitForRows(20);
  S().activate(S().windows[w].tabIds[45]);
  runFrames();
  await new Promise((resolve) => setTimeout(resolve, 200));
  scrollY.current = 120;
  geometry.current.scrolled?.();
  grow(rows, 60);
  assert.equal(scrolls.length, 0, "the user's scroll wins over the late reveal");
  delete geometry.current.entriesShown;
});

test("the sidebar's own reveal scroll doesn't drop the next reveal that waits for its rows", () => {
  atTop();
  const ids = S().windows[w].tabIds;
  S().activate(ids[45]);
  runFrames();
  assert.equal(scrolls.length, 1);
  const rows = waitForRows(20);
  S().activate(ids[55]);
  runFrames();
  geometry.current.scrolled?.();
  grow(rows, 60);
  assert.equal(scrolls.length, 2, "the echo of its own scroll isn't the user's");
  delete geometry.current.entriesShown;
});

test("closing a selected tab whose reveal waits for its rows reveals the tab that takes its place instead", async () => {
  atTop();
  const ids = S().windows[w].tabIds;
  S().activate(ids[49]);
  runFrames();
  await new Promise((resolve) => setTimeout(resolve, 5));
  scrollY.current = 0;
  scrolls.length = 0;
  const rows = waitForRows(20);
  S().activate(ids[50]);
  runFrames();
  S().closeTab(ids[50]);
  const replacement = S().windows[w].activeTabIds[S().windows[w].profileId];
  assert.ok(S().windows[w].tabIds.indexOf(replacement) >= 40, "the tab that takes its place is deep too");
  grow(rows, 60);
  assert.equal(scrolls.length, 1, "the replacement is revealed once its rows exist");
  assert.ok(scrolls[0].y > 300, JSON.stringify(scrolls));
  delete geometry.current.entriesShown;
});

test("closing the selected tab with no reveal waiting keeps the usual behaviour: nothing scrolls", () => {
  atTop();
  S().closeTab(S().windows[w].tabIds[0]);
  runFrames();
  assert.equal(scrolls.length, 0);
});

test("a measured tile's reveal still in flight never scrolls the page that took over the scroll", async () => {
  atTop();
  const ids = S().windows[w].tabIds;
  const tile = ids[3];
  S().pinTabs([tile], true);
  let measured = null;
  registerRow(w, tile, { measureInWindow: (done) => void (measured = done) });
  const scrolledB = [];
  const scrolledC = [];
  const before = scroll.current;
  scroll.current = { scrollTo: (move) => scrolledB.push(move), measureInWindow: (done) => done(0, 0) };
  S().activate(tile);
  runFrames();
  assert.ok(measured, "the tile's measurement is in flight");
  scroll.current = { scrollTo: (move) => scrolledC.push(move), measureInWindow: (done) => done(0, 0) };
  waitForRows(20);
  S().activate(ids[45]);
  runFrames();
  measured(0, 2000, 160, 40);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(scrolledC, [], "page C's scroll belongs to C's own reveal");
  scroll.current = before;
  registerRow(w, tile, null);
  delete geometry.current.entriesShown;
});

test("the selected-row pill's click is one native animated scroll", () => {
  const ids = S().windows[w].tabIds;
  scrollY.current = 0;
  scrolls.length = 0;
  revealTab(w, ids[45]);
  runFrames();
  assert.equal(scrolls.length, 1, JSON.stringify(scrolls));
  assert.equal(scrolls[0].animated, true);
  assert.equal(frames.length, 0);
  stop();
});

test("a row already in view needs no scroll", () => {
  assert.equal(revealScrollFor({ y: 120, height: 32 }, { top: 0, viewport: 300 }, false), null);
});

const browserState = (tabIds, active) => ({
  windows: { w: { profileId: "p", activeTabIds: { p: active }, tabIds } },
  tabs: Object.fromEntries(tabIds.map((id) => [id, { id, windowId: "w", page: { kind: "live" } }])),
});

test("a new selected tab and a switch to an existing tab both reveal the selected tab", () => {
  const before = browserState(["a", "b"], "a");
  assert.deepEqual(revealTargets(browserState(["a", "b", "c"], "c"), before, "w"), { switched: "c", opened: null });
  assert.deepEqual(revealTargets(browserState(["a", "b"], "b"), before, "w"), { switched: "b", opened: null });
});

test("with Reduce Motion on, the pill's click jumps to the row instead of scrolling smoothly", () => {
  const ids = S().windows[w].tabIds;
  const still = startRevealTabs(w, scroll, scrollY, geometry, () => true);
  scrollY.current = 0;
  scrolls.length = 0;
  revealTab(w, ids[45]);
  runFrames();
  assert.equal(scrolls.length, 1, JSON.stringify(scrolls));
  assert.equal(scrolls[0].animated, false);
  still();
});
