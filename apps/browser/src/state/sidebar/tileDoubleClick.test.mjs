import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { refreshShownTile } = await import("./actions.ts");
const { returnLiveTab } = await import("../live/engine.ts");
const { devTabPresses } = await import("../telemetry/tabPresses.ts");
const client = await import("../telemetry/client.ts");

const S = () => useBrowser.getState();
const go = (id, url, isLoading = false) => S().updateTab(id, { url, title: "" }, { isLoading, canGoBack: true, canGoForward: false });
const settle = () => new Promise((done) => setTimeout(done, 0));
const counts = () => {
  const t = devTabPresses();
  return { returns: t.tile_double_returns, reloads: t.tile_double_reloads, loading: t.tile_double_loading, missed: t.tile_double_missed };
};
const delta = (before) => {
  const after = counts();
  return Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v - before[k]]));
};

function pinnedTile(url = "https://x.com/home") {
  S().hydrate({});
  const w = S().createWindow({ url });
  const [tile] = S().windows[w].tabIds;
  const other = S().newTab(w, { url: "https://b.com/", background: true });
  S().pinTabs([tile], true);
  S().activate(tile);
  go(tile, url);
  const reloads = [];
  webviews.set(tile, { reload: () => (reloads.push(tile), Promise.resolve()) });
  webviews.set(other, { reload: () => (reloads.push(other), Promise.resolve()) });
  return { w, tile, other, reloads, done: () => (webviews.delete(tile), webviews.delete(other)) };
}

const navigatedTo = (id) => S().tabs[id].page.nav?.url ?? S().tabs[id].url;

test("a shown tile away from its pinned URL goes back there and doesn't reload", async () => {
  const { w, tile, reloads, done } = pinnedTile();
  try {
    go(tile, "https://x.com/someone/status/1");
    const before = counts();
    refreshShownTile(w, tile);
    await settle();
    assert.equal(navigatedTo(tile), "https://x.com/home");
    assert.deepEqual(reloads, []);
    assert.deepEqual(delta(before), { returns: 1, reloads: 0, loading: 0, missed: 0 });
  } finally {
    done();
  }
});

test("a shown tile already at its pinned URL reloads its page, the issue #3965 report", async () => {
  const { w, tile, reloads, done } = pinnedTile();
  try {
    const before = counts();
    refreshShownTile(w, tile);
    await settle();
    assert.deepEqual(reloads, [tile]);
    assert.equal(S().tabs[tile].url, "https://x.com/home", "no navigation");
    assert.deepEqual(delta(before), { returns: 0, reloads: 1, loading: 0, missed: 0 });
  } finally {
    done();
  }
});

test("a fragment or trailing slash still counts as the pinned page, so it reloads", async () => {
  const { w, tile, reloads, done } = pinnedTile("https://docs.com/guide");
  try {
    go(tile, "https://docs.com/guide/#install");
    refreshShownTile(w, tile);
    await settle();
    assert.deepEqual(reloads, [tile]);
    assert.equal(S().tabs[tile].url, "https://docs.com/guide/#install");
  } finally {
    done();
  }
});

test("a pinned tile with no pinned URL reloads its current page", async () => {
  const { w, tile, reloads, done } = pinnedTile();
  try {
    S().updateTab(tile, { pinnedUrl: null });
    refreshShownTile(w, tile);
    await settle();
    assert.deepEqual(reloads, [tile]);
  } finally {
    done();
  }
});

test("a tile still loading, as after the first click woke it from sleep, is left to finish", async () => {
  const { w, tile, reloads, done } = pinnedTile();
  try {
    go(tile, "https://x.com/home", true);
    const before = counts();
    refreshShownTile(w, tile);
    await settle();
    assert.deepEqual(reloads, []);
    assert.deepEqual(delta(before), { returns: 0, reloads: 0, loading: 1, missed: 0 });
  } finally {
    done();
  }
});

test("a tile woken from sleep whose page isn't mounted yet counts a miss while sharing stays on, and doesn't throw", async () => {
  const { w, tile, other, done } = pinnedTile();
  try {
    S().activate(other);
    S().closeTab(tile);
    assert.equal(S().tabs[tile].page.kind, "asleep");
    webviews.delete(tile);
    S().activate(tile);
    client.setSharing(true, "settings");
    let before = counts();
    refreshShownTile(w, tile);
    await settle();
    assert.deepEqual(delta(before), { returns: 0, reloads: 1, loading: 0, missed: 1 });
    refreshShownTile(w, tile);
    client.setSharing(false, "settings");
    before = counts();
    await settle();
    assert.deepEqual(delta(before), { returns: 0, reloads: 0, loading: 0, missed: 0 }, "a miss after sharing went off isn't counted");
  } finally {
    client.setSharing(false, "settings");
    done();
  }
});

test("a tile that isn't the shown tab does nothing: a ⌘- or ⇧-click pair never resets or reloads", async () => {
  const { w, tile, other, reloads, done } = pinnedTile();
  try {
    S().activate(other);
    go(tile, "https://x.com/elsewhere");
    const before = counts();
    refreshShownTile(w, tile);
    S().updateTab(tile, { url: "https://x.com/home" });
    refreshShownTile(w, tile);
    await settle();
    assert.deepEqual(reloads, []);
    assert.equal(S().tabs[tile].url, "https://x.com/home");
    assert.deepEqual(delta(before), { returns: 0, reloads: 0, loading: 0, missed: 0 });
  } finally {
    done();
  }
});

test("in a split, only the shown pane's tile reloads", async () => {
  const { w, tile, other, reloads, done } = pinnedTile();
  try {
    S().createSplit([tile, other]);
    S().activate(tile);
    assert.equal(model.activeTabId(S(), w), tile);
    refreshShownTile(w, tile);
    await settle();
    assert.deepEqual(reloads, [tile]);
    S().activate(other);
    refreshShownTile(w, tile);
    await settle();
    assert.deepEqual(reloads, [tile], "the other pane is shown now, so the tile's double-click is ignored");
  } finally {
    done();
  }
});

test("Back to Pinned URL from ⌘↩, menus, the socket and live folders still never reloads", async () => {
  const { tile, reloads, done } = pinnedTile();
  try {
    S().returnToPinnedUrl(tile);
    returnLiveTab(tile);
    await settle();
    assert.deepEqual(reloads, []);
    go(tile, "https://x.com/elsewhere");
    S().returnToPinnedUrl(tile);
    assert.equal(navigatedTo(tile), "https://x.com/home");
    assert.deepEqual(reloads, []);
  } finally {
    done();
  }
});

test("the sidebar's Top Apps and the top strip's pinned dock both send a double-click to refreshShownTile", () => {
  for (const file of ["../../components/sidebar/PinnedGrid.tsx", "../../components/tabstrip/PinnedDock.tsx"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(src, /onDoubleClick=\{\(\) => refreshShownTile\(windowId, tabId\)\}/, file);
  }
  const row = readFileSync(new URL("../../components/sidebar/TabRow.tsx", import.meta.url), "utf8");
  assert.match(row, /onDoubleClick=\{\(\) => void startRename\(/, "rows keep double-click to rename");
});
