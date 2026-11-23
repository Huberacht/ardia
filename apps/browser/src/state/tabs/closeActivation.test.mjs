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

const { runCommand } = await import("../commands/commands.ts");
const { useLive } = await import("../live/store.ts");
const { deleteLiveFolder } = await import("../live/engine.ts");
const { visibleRows } = await import("./closeActivation.ts");

const liveTab = (w, folderId, itemId) => {
  const id = S().newTab(w, { url: `https://${itemId}.com/`, background: true });
  useBrowser.setState((s) => ({ tabs: { ...s.tabs, [id]: { ...s.tabs[id], liveItem: { folderId, itemId } } } }));
  return id;
};
const liveFolder = (profileId, items, patch = {}) => {
  useLive.setState({
    folders: { lf: { id: "lf", profileId, kind: "documents", name: "Docs", icon: null, collapsed: false, sources: [], filters: { authored: true, reviewRequests: true }, groupStacks: false, showCompleted: true, hiddenRepos: [], showNewRepos: true, shownRepos: [], createdAt: 1, ...patch } },
    folderOrder: ["lf"],
    items: { lf: items.map((id) => ({ id, source: "drive", url: `https://${id}.com/`, title: id, subtitle: "", icon: null, updatedAt: 1 })) },
    hidden: {},
    repoHidden: {},
    showAll: {},
    expandedStacks: {},
  });
};
const noLive = () => useLive.setState({ folders: {}, folderOrder: [], items: {}, hidden: {}, repoHidden: {} });
const rowsOf = (w) => visibleRows(S(), w, S().windows[w].profileId).map((r) => `${r.section}:${r.ids.map(host).join("|")}`);

test("a close from the socket, the CLI or launch actions never uses Tab above and counts nothing, even for a selection", async () => {
  const client = await import("../telemetry/client.ts");
  const { takeCloseActivationCounts } = await import("../telemetry/closeActivationCounts.ts");
  client.loadChoice();
  client.setSharing(true, "settings");
  takeCloseActivationCounts();
  for (const [user, expected] of [[false, "a"], [true, "b"]]) {
    const { w, ids: [a, , c] } = windowWith("tabAbove", "a", "b", "c", "d");
    S().activate(a);
    S().activate(c);
    runCommand({ command: "closeTab", arg: null, windowId: w }, user ? { user } : { mayWrite: () => true });
    assert.equal(shown(w), expected, user ? "user" : "socket");
  }
  assert.deepEqual(takeCloseActivationCounts(), { close_activated_tab_above: 1, close_tab_above_fallbacks: 0 }, "only the user close counts");
  const { w, ids: [a, b, c, d] } = windowWith("tabAbove", "a", "b", "c", "d", "e");
  S().activate(a);
  S().activate(d);
  S().setSelection(w, [c, d]);
  runCommand({ command: "closeTab", arg: null, windowId: w }, { mayWrite: () => true });
  assert.equal(shown(w), "a", "a socket selection close keeps today's pick");
  assert.deepEqual(takeCloseActivationCounts(), { close_activated_tab_above: 0, close_tab_above_fallbacks: 0 });
  void b;
  client.setSharing(false, "settings");
});

test("closing or deleting the group in front goes through Tab above and never shows a tab hidden in a collapsed group", () => {
  for (const [action, user, expected] of [["closeGroup", true, "x"], ["deleteGroup", true, "x"], ["closeGroup", false, "h"]]) {
    const { w, ids: [, h, g1] } = windowWith("tabAbove", "x", "h", "g1");
    const hidden = S().createGroup([h], { name: "H" });
    const g = S().createGroup([g1], { name: "G" });
    S().activate(h);
    S().activate(g1);
    S().updateGroup(hidden, { collapsed: true });
    S()[action](g, user ? byUser() : undefined);
    assert.equal(shown(w), expected, `${action} ${user ? "by you" : "by Ardia"}`);
  }
});

test("an open Live Folder's tabs are rows, so closing one shows the one above it in the folder", () => {
  const { w, ids: [r] } = windowWith("tabAbove", "r");
  const p = S().windows[w].profileId;
  liveFolder(p, ["x", "y"]);
  const x = liveTab(w, "lf", "x");
  const y = liveTab(w, "lf", "y");
  S().activate(r);
  S().activate(y);
  assert.deepEqual(rowsOf(w), ["pinned:x", "pinned:y", "regular:r"]);
  close(y);
  assert.equal(shown(w), "x");
  void x;
  noLive();
});

test("deleting a Live Folder from the sidebar goes through Tab above; from the socket it keeps today's pick", () => {
  for (const [user, expected] of [[true, "q"], [false, "r"]]) {
    const { w, ids: [q, r] } = windowWith("tabAbove", "q", "r");
    const p = S().windows[w].profileId;
    S().pinTabs([q], true, true);
    liveFolder(p, ["x"]);
    const x = liveTab(w, "lf", "x");
    S().activate(q);
    S().activate(r);
    S().activate(x);
    deleteLiveFolder("lf", user ? byUser() : undefined);
    assert.equal(shown(w), expected, user ? "by you" : "by the socket");
    noLive();
  }
});

test("a batch closing two Top Apps, one split with a regular tab, goes above the topmost before the split pane", () => {
  const { w, ids: [a, b, c, d] } = windowWith("tabAbove", "a", "b", "c", "d");
  S().pinTabs([a, b, c], true);
  S().createSplit([c, d]);
  S().activate(a);
  S().activate(b);
  S().activate(c);
  closeAll([b, c]);
  assert.equal(shown(w), "a");
});

test("with Keep Top Apps running on, ⌘W on a Top App switches to a regular tab as before, so holding ⌘W never cycles through Top Apps", () => {
  const { w, ids: [a, b, c] } = windowWith("tabAbove", "a", "b", "c");
  S().pinTabs([a, b], true);
  S().updateSettings({ keepTopAppsRunning: true });
  S().activate(a);
  S().activate(c);
  S().activate(b);
  close(b);
  assert.equal(shown(w), "c");
  S().updateSettings({ keepTopAppsRunning: false });
});

test("the visible rows follow what the sidebar draws: Top Apps and their folder tiles, pinned rows and Live Folders, collapsed pinned tabs, groups and folders", () => {
  const { w, ids: [t1, t2, t3, p1, p2, a, g1, g2, n1] } = windowWith("tabAbove", "t1", "t2", "t3", "p1", "p2", "a", "g1", "g2", "n1");
  const profile = S().windows[w].profileId;
  S().pinTabs([t1, t2, t3], true);
  useBrowser.setState((s) => folders.addToTileFolder(s, [t3], t2), true);
  S().pinTabs([p1, p2], true, true);
  const g = S().createGroup([g1, g2], { name: "G" });
  const inner = S().groupTabs([n1], { pinned: false, name: "N" });
  liveFolder(profile, ["x"]);
  const x = liveTab(w, "lf", "x");
  S().activate(a);
  assert.deepEqual(rowsOf(w), ["topApps:t1", "pinned:p1", "pinned:p2", "pinned:x", "regular:a", "regular:g1", "regular:g2", "regular:n1"]);
  S().activate(t3);
  assert.deepEqual(rowsOf(w).slice(0, 2), ["topApps:t1", "topApps:t3"], "a folder tile counts as the Top App it shows");
  S().activate(a);
  S().updateGroup(g, { collapsed: true });
  assert.deepEqual(rowsOf(w).filter((r) => r.startsWith("regular")), ["regular:a", "regular:n1"], "a collapsed group hides its tabs");
  S().updateProfile(profile, { pinnedCollapsed: true });
  S().activate(p2);
  assert.deepEqual(rowsOf(w).filter((r) => r.startsWith("pinned")), ["pinned:p2"], "collapsed pinned tabs show only the one kept");
  S().activate(x);
  assert.deepEqual(rowsOf(w).filter((r) => r.startsWith("pinned")), ["pinned:x"], "or the Live Folder tab in front");
  S().updateProfile(profile, { pinnedCollapsed: false });
  useLive.setState((s) => ({ folders: { lf: { ...s.folders.lf, collapsed: true } } }));
  S().activate(a);
  assert.ok(!rowsOf(w).includes("pinned:x"), "a collapsed Live Folder hides its tabs");
  void inner;
  noLive();
});
