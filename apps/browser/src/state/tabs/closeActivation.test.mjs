import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { SETTING_SPECS } = await import("../settings/settings.ts");
const { isConfigSettingKey } = await import("../settings/configAllowlist.ts");
const { settingsSnapshot } = await import("../telemetry/settingsSnapshot.ts");
await import("../../test-native/index.ts");

let clock = Date.now();
Date.now = () => (clock += 1000);
const S = () => useBrowser.getState();
const { byUser } = await import("./closeActivation.ts");
const folders = await import("../pins/tileFolders.ts");
const close = (id) => S().closeTab(id, byUser());
const closeAll = (ids) => S().closeTabs(ids, byUser());
const host = (id) => (id ? S().tabs[id]?.url.replace(/^https:\/\/|\.com\/?$/g, "") : undefined);
const shown = (w) => host(activeTabId(S(), w));

function windowWith(mode, ...hosts) {
  S().hydrate({});
  S().updateSettings({ cmdClickCreatesTabGroup: false, newTabPosition: "bottom", afterClosingTab: mode });
  const w = S().createWindow({ url: `https://${hosts[0]}.com/` });
  const ids = [S().windows[w].tabIds[0], ...hosts.slice(1).map((h) => S().newTab(w, { url: `https://${h}.com/`, background: true }))];
  return { w, ids };
}

const BOTH = ["previouslyActive", "tabAbove"];

test("the setting defaults to the previously active tab, syncs, is in config.json and in the daily settings snapshot", () => {
  assert.equal(SETTING_SPECS.afterClosingTab.default, "previouslyActive");
  assert.deepEqual([...SETTING_SPECS.afterClosingTab.values], ["previouslyActive", "tabAbove"]);
  assert.equal(SETTING_SPECS.afterClosingTab.synced, true);
  assert.ok(isConfigSettingKey("afterClosingTab"));
  S().hydrate({});
  assert.equal(S().settings.afterClosingTab, "previouslyActive");
  S().updateSettings({ afterClosingTab: "tabAbove" });
  const snapshot = settingsSnapshot(S().settings);
  assert.equal(snapshot.setting_afterClosingTab, "tabAbove");
  assert.equal(snapshot.default_afterClosingTab, "previouslyActive");
});

test("Previously active tab keeps today's behaviour; Tab above shows the tab directly above", () => {
  for (const [mode, expected] of [["previouslyActive", "a"], ["tabAbove", "b"]]) {
    const { w, ids: [a, , c] } = windowWith(mode, "a", "b", "c", "d");
    S().activate(a);
    S().activate(c);
    close(c);
    assert.equal(shown(w), expected, mode);
  }
});

test("Tab above: closing the first tab shows the tab below it", () => {
  const { w, ids: [a, , c] } = windowWith("tabAbove", "a", "b", "c");
  S().activate(c);
  S().activate(a);
  close(a);
  assert.equal(shown(w), "b");
});

test("closing a background tab never changes the tab in front, in either mode", () => {
  for (const mode of BOTH) {
    const { w, ids: [a, b, c] } = windowWith(mode, "a", "b", "c");
    S().activate(c);
    S().activate(a);
    close(b);
    assert.equal(shown(w), "a", mode);
    closeAll([c]);
    assert.equal(shown(w), "a", mode);
  }
});

test("Tab above stays among the regular tabs: the first regular tab goes down, not up into the pinned tabs", () => {
  const { w, ids: [p, a] } = windowWith("tabAbove", "p", "a", "b");
  S().pinTabs([p], true, true);
  S().activate(p);
  S().activate(a);
  close(a);
  assert.equal(shown(w), "b");
});

test("Tab above among pinned rows shows the open pinned row above, and an unloaded one is skipped", () => {
  const { w, ids: [p1, p2, p3] } = windowWith("tabAbove", "p1", "p2", "p3", "x");
  S().pinTabs([p1, p2, p3], true, true);
  S().activate(p1);
  S().activate(p2);
  S().activate(p3);
  close(p3);
  assert.equal(shown(w), "p2");
  assert.equal(S().tabs[p3].page.kind, "asleep", "the pinned row unloads and stays");
  closeAll([p1]);
  S().activate(p3);
  close(p3);
  assert.equal(shown(w), "p2", "p1 is unloaded, so the open row is the nearest");
});

test("Tab above with no open pinned row left falls back to today's pick", () => {
  const { w, ids: [p1, p2, x] } = windowWith("tabAbove", "p1", "p2", "x");
  S().pinTabs([p1, p2], true, true);
  closeAll([p1]);
  assert.equal(S().tabs[p1].page.kind, "asleep");
  S().activate(x);
  S().activate(p2);
  close(p2);
  assert.equal(shown(w), "x");
  assert.equal(S().tabs[p1].page.kind, "asleep", "the unloaded pin isn't woken");
});

test("Tab above never shows a tab hidden in a collapsed folder; it takes the nearest visible row", () => {
  const { w, ids: [a, g1, g2, c] } = windowWith("tabAbove", "a", "g1", "g2", "c");
  const g = S().createGroup([g1, g2], { name: "G" });
  S().updateGroup(g, { collapsed: true });
  S().activate(a);
  S().activate(c);
  close(c);
  assert.equal(shown(w), "a");
  assert.ok(![g1, g2].includes(activeTabId(S(), w)));
});

test("Tab above from a tab kept visible in a collapsed folder skips its hidden siblings", () => {
  const { w, ids: [a, g1, g2, g3, d] } = windowWith("tabAbove", "a", "g1", "g2", "g3", "d");
  const g = S().createGroup([g1, g2, g3], { name: "G" });
  S().activate(d);
  S().activate(g3);
  S().updateGroup(g, { collapsed: true });
  close(g3);
  assert.equal(shown(w), "a");
});

test("Tab above in an open folder shows the folder's last tab", () => {
  const { w, ids: [, g1, g2, c] } = windowWith("tabAbove", "a", "g1", "g2", "c");
  S().createGroup([g1, g2], { name: "G" });
  S().activate(c);
  close(c);
  assert.equal(shown(w), "g2");
});

test("closing one pane of a split shows its other pane in either mode; closing the whole split goes above it", () => {
  for (const mode of BOTH) {
    const { w, ids: [, b, c, d] } = windowWith(mode, "a", "b", "c", "d");
    S().createSplit([b, c]);
    S().activate(d);
    S().activate(c);
    close(c);
    assert.equal(shown(w), "b", mode);
  }
  const { w, ids: [, b, c, d] } = windowWith("tabAbove", "a", "b", "c", "d");
  S().createSplit([b, c]);
  S().activate(d);
  S().activate(b);
  closeAll([b, c]);
  assert.equal(shown(w), "a");
});

test("Tab above shows the split row above as that split", () => {
  const { w, ids: [, b, c, d] } = windowWith("tabAbove", "a", "b", "c", "d");
  S().createSplit([b, c]);
  S().activate(c);
  S().activate(b);
  S().activate(d);
  close(d);
  assert.equal(shown(w), "b", "the pane used last");
});

test("closing several tabs at once makes one pick: the first survivor above the topmost closed tab", () => {
  const { w, ids: [, b, , d, e] } = windowWith("tabAbove", "a", "b", "c", "d", "e");
  S().activate(e);
  S().activate(d);
  closeAll([b, d]);
  assert.equal(shown(w), "a");

  const top = windowWith("tabAbove", "a", "b", "c");
  S().activate(top.ids[2]);
  S().activate(top.ids[1]);
  closeAll([top.ids[0], top.ids[1]]);
  assert.equal(shown(top.w), "c", "nothing above, so the first survivor below");

  const behind = windowWith("tabAbove", "a", "b", "c", "d");
  S().activate(behind.ids[3]);
  closeAll([behind.ids[1], behind.ids[2]]);
  assert.equal(shown(behind.w), "d", "the tab in front wasn't closed");
});

test("Tab above never crosses into another profile's tabs in the same window", () => {
  const { w, ids: [a, b] } = windowWith("tabAbove", "a", "b");
  const other = S().createProfile({ name: "Other" });
  const x = S().newTab(w, { url: "https://x.com/", profileId: other, background: true });
  S().moveTab(x, 1);
  const c = S().newTab(w, { url: "https://c.com/", background: true });
  assert.equal(S().tabs[x].profileId, other);
  S().activate(a);
  S().activate(c);
  close(c);
  assert.equal(shown(w), "b");
  assert.ok(S().tabs[x]);
});

test("closing the last tab still closes the window in either mode", () => {
  for (const mode of BOTH) {
    const { w, ids: [a] } = windowWith(mode, "a");
    close(a);
    assert.equal(S().windows[w], undefined, mode);
  }
});

test("reopening a tab closed with Tab above puts it back in its place", () => {
  const { w, ids: [, , c] } = windowWith("tabAbove", "a", "b", "c", "d");
  S().activate(c);
  close(c);
  assert.equal(shown(w), "b");
  S().reopenClosedTab();
  const order = S().windows[w].tabIds.map(host);
  assert.deepEqual(order, ["a", "b", "c", "d"]);
  assert.equal(shown(w), "c");
});

test("only a close from the tab in front counts toward Tab above telemetry, and only while sharing", async () => {
  const client = await import("../telemetry/client.ts");
  const { takeCloseActivationCounts } = await import("../telemetry/closeActivationCounts.ts");
  client.loadChoice();
  client.setSharing(true, "settings");
  takeCloseActivationCounts();
  const { w, ids: [t, a, b, c] } = windowWith("tabAbove", "t", "a", "b", "c");
  S().pinTabs([t], true);
  S().activate(c);
  close(b);
  close(c);
  assert.equal(shown(w), "a");
  close(a);
  assert.equal(shown(w), "t", "no regular tab left, so today's pick");
  assert.deepEqual(takeCloseActivationCounts(), { close_activated_tab_above: 1, close_tab_above_fallbacks: 1 });
  client.setSharing(false, "settings");
  const off = windowWith("tabAbove", "a", "b");
  S().activate(off.ids[1]);
  close(off.ids[1]);
  assert.deepEqual(takeCloseActivationCounts(), { close_activated_tab_above: 0, close_tab_above_fallbacks: 0 });
});

test("Tab above among open Top Apps shows the Top App beside the closed one, not the last regular tab", () => {
  for (const [mode, expected] of [["previouslyActive", "c"], ["tabAbove", "a"]]) {
    const { w, ids: [a, b, c] } = windowWith(mode, "a", "b", "c");
    S().pinTabs([a, b], true);
    S().activate(a);
    S().activate(c);
    S().activate(b);
    close(b);
    assert.equal(shown(w), expected, mode);
  }
});

test("across the top, a collapsed group shows only the tab in front, so Tab above skips a member the sidebar would keep", () => {
  for (const [layout, expected] of [["top", "a"], ["sidebar", "b"]]) {
    const { w, ids: [, b, c] } = windowWith("tabAbove", "a", "b", "c");
    S().updateSettings({ tabLayout: layout });
    const g = S().createGroup([b], { name: "G" });
    S().activate(b);
    S().updateGroup(g, { collapsed: true });
    S().activate(c);
    assert.ok(S().groups[g].shownTabIds?.includes(b), "the sidebar keeps b on screen");
    close(c);
    assert.equal(shown(w), expected, layout);
  }
  S().updateSettings({ tabLayout: "sidebar" });
});

test("with nothing visible next to the closed tab, Tab above takes the visible tab used last over a hidden one", () => {
  const { w, ids: [t, a, b, c] } = windowWith("tabAbove", "t", "a", "b", "c");
  S().pinTabs([t], true);
  const g = S().createGroup([a, b], { name: "G" });
  S().activate(t);
  S().activate(b);
  S().activate(c);
  S().updateGroup(g, { collapsed: true });
  close(c);
  assert.equal(shown(w), "t");

  const none = windowWith("tabAbove", "a", "b", "c");
  const g2 = S().createGroup([none.ids[0], none.ids[1]], { name: "G" });
  S().activate(none.ids[1]);
  S().activate(none.ids[2]);
  S().updateGroup(g2, { collapsed: true });
  close(none.ids[2]);
  assert.equal(shown(none.w), "b", "no visible tab left: today's pick, which the folder then keeps on screen");
});

test("moving the tab in front to another window keeps today's pick in either mode", () => {
  for (const mode of BOTH) {
    const { w, ids: [a, , c] } = windowWith(mode, "a", "b", "c", "d");
    const other = S().createWindow({ url: "https://o.com/" });
    S().activate(a);
    S().activate(c);
    S().moveTabsToWindow([c], other);
    assert.equal(shown(w), "a", mode);
  }
});

test("closing another profile's remembered tab counts nothing toward Tab above telemetry", async () => {
  const client = await import("../telemetry/client.ts");
  const { takeCloseActivationCounts } = await import("../telemetry/closeActivationCounts.ts");
  client.loadChoice();
  client.setSharing(true, "settings");
  const { w, ids: [a] } = windowWith("tabAbove", "a", "b");
  const other = S().createProfile({ name: "Other" });
  const x = S().newTab(w, { url: "https://x.com/", profileId: other, background: true });
  S().newTab(w, { url: "https://y.com/", profileId: other, background: true });
  S().activate(x);
  S().activate(a);
  assert.equal(S().windows[w].activeTabIds[other], x);
  takeCloseActivationCounts();
  closeAll([x]);
  assert.deepEqual(takeCloseActivationCounts(), { close_activated_tab_above: 0, close_tab_above_fallbacks: 0 });
  client.setSharing(false, "settings");
});

test("a batch close whose topmost row is a split goes above that split before taking its surviving pane", () => {
  const { w, ids: [, b, c, d] } = windowWith("tabAbove", "a", "b", "c", "d");
  S().createSplit([b, c]);
  S().activate(d);
  closeAll([b, d]);
  assert.equal(shown(w), "a");

  const first = windowWith("tabAbove", "b", "c", "d");
  S().createSplit([first.ids[0], first.ids[1]]);
  S().activate(first.ids[2]);
  closeAll([first.ids[0], first.ids[2]]);
  assert.equal(shown(first.w), "c", "nothing above: the split's surviving pane");
});

test("closes Ardia makes by itself, like a finished sign-in tab, keep today's pick in Tab above mode", () => {
  const { w, ids: [a, , c] } = windowWith("tabAbove", "a", "b", "c", "d");
  S().activate(a);
  S().activate(c);
  S().closeTab(c);
  assert.equal(shown(w), "a");
});

test("closing a Top App split with a regular tab shows the surviving pane before an open Top App beside it", () => {
  const { w, ids: [x, a, b] } = windowWith("tabAbove", "x", "a", "b");
  S().pinTabs([x, a], true);
  S().createSplit([a, b]);
  S().activate(x);
  S().activate(a);
  close(a);
  assert.equal(shown(w), "b");
});

test("with pinned tabs collapsed, Tab above never picks a hidden pinned row; with none visible it keeps today's pick", () => {
  const { w, ids: [p1, p2, p3] } = windowWith("tabAbove", "p1", "p2", "p3");
  S().pinTabs([p1, p2, p3], true, true);
  S().activate(p2);
  S().activate(p1);
  S().activate(p3);
  S().updateProfile(S().windows[w].profileId, { pinnedCollapsed: true });
  close(p3);
  assert.equal(shown(w), "p1", "today's pick: the pinned row used last");
  S().updateProfile(S().windows[w].profileId, { pinnedCollapsed: false });
});

test("a Top App shown by its folder tile hands over to the open Top App beside the folder", () => {
  for (const layout of ["sidebar", "top"]) {
    const { w, ids: [x, a, b, r] } = windowWith("tabAbove", "x", "a", "b", "r");
    S().updateSettings({ tabLayout: layout });
    S().pinTabs([x, a, b], true);
    useBrowser.setState((s) => folders.addToTileFolder(s, [b], a), true);
    S().activate(x);
    S().activate(r);
    S().activate(a);
    close(a);
    assert.equal(shown(w), "x", layout);
  }
  S().updateSettings({ tabLayout: "sidebar" });
});

test("a batch that unloads a pinned row and closes the tab in front never wakes that pinned row", () => {
  const { w, ids: [p, h, c] } = windowWith("tabAbove", "p", "h", "c");
  S().pinTabs([p], true, true);
  const g = S().createGroup([h], { name: "G" });
  S().activate(p);
  S().activate(h);
  S().activate(c);
  S().updateGroup(g, { collapsed: true });
  closeAll([p, c]);
  assert.notEqual(shown(w), "p");
  assert.equal(S().tabs[p].page.kind, "asleep");
});

test("closing the only open pinned row or Top App shows a visible regular tab, not a hidden one used more recently", () => {
  for (const tile of [false, true]) {
    const { w, ids: [p, v, h] } = windowWith("tabAbove", "p", "v", "h");
    S().pinTabs([p], true, !tile);
    const g = S().createGroup([h], { name: "G" });
    S().activate(v);
    S().activate(h);
    S().activate(p);
    S().updateGroup(g, { collapsed: true });
    close(p);
    assert.equal(shown(w), "v", tile ? "Top App" : "pinned row");
  }
});

test("a pinned folder's tabs and regular tabs are separate parts across the top as in the sidebar", () => {
  for (const layout of ["sidebar", "top"]) {
    const { w, ids: [p, a] } = windowWith("tabAbove", "p", "a", "b");
    S().updateSettings({ tabLayout: layout });
    S().groupTabs([p], { name: "P" });
    S().activate(p);
    S().activate(a);
    close(a);
    assert.equal(shown(w), "b", layout);
  }
  S().updateSettings({ tabLayout: "sidebar" });
});

test("a batch reaching past the active split goes above its topmost closed tab; closing one pane alone still shows the other", () => {
  const { w, ids: [, b, c, d] } = windowWith("tabAbove", "a", "b", "c", "d");
  S().createSplit([c, d]);
  S().activate(d);
  closeAll([b, d]);
  assert.equal(shown(w), "a");

  const one = windowWith("tabAbove", "a", "b", "c", "d");
  S().createSplit([one.ids[2], one.ids[3]]);
  S().activate(one.ids[3]);
  close(one.ids[3]);
  assert.equal(shown(one.w), "c");
});
