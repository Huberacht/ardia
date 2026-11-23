import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { clearlyOverflows, DOCK_SLACK, dockedAfter, pageLayout, rowPitch } = await import("./pageLayout.ts");

const ROW = 41;
const gridHeight = (count) => Math.ceil(count / 3) * ROW;
const at = (overrides) =>
  pageLayout({ tiles: 3, previewed: 3, dockRoom: 300, gridHeight, dragging: false, fixedBeforeDrag: true, ...overrides });

test("tiles that fit 40 % of the sidebar stay fixed above the list; a taller dock scrolls with it", () => {
  assert.equal(at({ tiles: 3 }).dockFixed, true);
  assert.equal(at({ tiles: 21, dockRoom: 287 }).dockFixed, true);
  assert.equal(at({ tiles: 24, dockRoom: 287 }).dockFixed, false);
  assert.equal(at({ tiles: 0, dockRoom: -10 }).dockFixed, true);
  assert.equal(at({ tiles: 3, dockRoom: Infinity }).dockFixed, true);
});

test("the fixed or scrolling choice is frozen for a drag", () => {
  assert.equal(at({ tiles: 24, dockRoom: 287, dragging: true, fixedBeforeDrag: true }).dockFixed, true);
  assert.equal(at({ tiles: 3, dragging: true, fixedBeforeDrag: false }).dockFixed, false);
});

test("a drag that previews more tiles than fit caps the dock at its room", () => {
  assert.equal(at({ tiles: 3, previewed: 23, dragging: true, fixedBeforeDrag: true }).capped, true);
  assert.equal(at({ tiles: 3, previewed: 21, dragging: true, fixedBeforeDrag: true }).capped, false);
  assert.equal(at({ tiles: 3, previewed: 23, dragging: false }).capped, false);
  assert.equal(at({ tiles: 30, previewed: 40, dragging: true, fixedBeforeDrag: false }).capped, false);
});

test("New Tab docks when less than its slack is left under it, and comes back once the docked list leaves any room", () => {
  assert.equal(dockedAfter(false, DOCK_SLACK - 1), true);
  assert.equal(dockedAfter(false, DOCK_SLACK), false);
  assert.equal(dockedAfter(false, 0), true);
  assert.equal(dockedAfter(true, 0), true);
  assert.equal(dockedAfter(true, 0.5), true);
  assert.equal(dockedAfter(true, 1), false);
  assert.equal(dockedAfter(true, 400), false);
});

test("an expanded Playing now card's growth counts as room, and an expansion that fills the room leaves the dock as it was", () => {
  assert.equal(dockedAfter(true, 0, 54), true);
  assert.equal(dockedAfter(false, 0, 54), false);
  assert.equal(dockedAfter(true, 10, 54), false);
  assert.equal(dockedAfter(false, 10, 54), false);
});

test("a page starts with New Tab docked only when its rows clearly overflow it, so a short or borderline list never flips at launch", () => {
  const height = 600;
  const rowsFor = (px) => Math.ceil(px / rowPitch());
  assert.equal(clearlyOverflows(200, height), true, "a 200-tab list starts docked");
  assert.equal(clearlyOverflows(rowsFor(height * 2) + 1, height), true);
  assert.equal(clearlyOverflows(rowsFor(height), height), false, "a list about one page tall waits for its layout");
  assert.equal(clearlyOverflows(rowsFor(height * 2) - 1, height), false);
  assert.equal(clearlyOverflows(0, height), false);
  assert.equal(clearlyOverflows(500, 0), false, "no height yet means no guess");
});

test("the sidebar page makes its first dock guess from the entries once, without subscribing to them", () => {
  const page = readFileSync(new URL("./SidebarPage.tsx", import.meta.url), "utf8");
  assert.match(page, /if \(!dockGuessed && canDock && height > 0\) \{/);
  assert.match(page, /clearlyOverflows\(sidebarListLengthNow\(windowId, profileId\), height\)/);
});

test("the dock reads its free space from the filler's child, whose frame moves only when that space changes, not with every row added", () => {
  const page = readFileSync(new URL("./SidebarPage.tsx", import.meta.url), "utf8");
  assert.match(page, /<ContextMenuArea style=\{\{ flex: 1 \}\} onLayout=\{onSlack\}/);
  assert.doesNotMatch(page, /<View key=\{[^}]*\}[^>]*onLayout=\{onSlack\}/);
});

test("a free-space reading that arrives before the sidebar has a height is kept and applied once it does", () => {
  const page = readFileSync(new URL("./SidebarPage.tsx", import.meta.url), "utf8");
  assert.match(page, /slack\.current = e\.nativeEvent\.layout\.height;\n\s*applySlack\(\);/);
  assert.match(page, /useEffect\(applySlack, \[height > 0, canDock, resting\]\);/);
});

test("a page's row cap keeps its peak only while the pager holds: the page that rests drops back to its warm cap, the shown page has none", async () => {
  const { pageRowsCap } = await import("./pageLayout.ts");
  const peaks = new Map();
  const base = { shown: "a", current: "b", visited: false, capRows: 12, screen: 400, throughActive: () => ({ entries: 19, height: 19 * 34 }), holding: true, peaks };
  assert.equal(pageRowsCap({ ...base, profileId: "a" }), undefined, "the shown page has every row");
  assert.equal(pageRowsCap({ ...base, profileId: "b" }), 20, "the arriving page mounts down to its selected tab");
  assert.equal(pageRowsCap({ ...base, current: "c", profileId: "b" }), 20, "a second swipe in the same hold keeps the page that is still sliding out");
  assert.equal(pageRowsCap({ ...base, current: "c", profileId: "b", holding: false }), 12, "once the pages rest an unvisited page goes back to its warm cap");
  assert.equal(pageRowsCap({ ...base, profileId: "b", visited: true }), 20, "a visited page held in the same hold keeps its peak");
  peaks.clear();
  assert.equal(pageRowsCap({ ...base, profileId: "d", current: "c" }), 12, "a page that never arrived never grows");
  assert.equal(peaks.size, 0);
});

test("the arriving page pre-mounts at most two screens: a deeper selected tab waits for the rows to grow at rest", async () => {
  const { pageRowsCap, PREMOUNT_SCREENS } = await import("./pageLayout.ts");
  const screen = 12 * 34;
  const at = (entries, height = entries * 34) => pageRowsCap({ profileId: "b", shown: "a", current: "b", visited: false, capRows: 12, screen, throughActive: () => ({ entries, height }), holding: true, peaks: new Map() });
  assert.equal(at(5), 12, "a selected tab on the first screen needs nothing extra");
  assert.equal(at(12 * PREMOUNT_SCREENS - 1), 12 * PREMOUNT_SCREENS, "within two screens: mounted down to it");
  assert.equal(at(12 * PREMOUNT_SCREENS + 1), 12, "past two screens: the first screen only");
  assert.equal(at(499), 12, "a 500th row never mounts 500 rows during the slide");
  assert.equal(at(16, 15 * 34 + 300 * 34), 12, "an open group of 300 tabs before it counts as the 300 rows it draws, not one entry");
});
