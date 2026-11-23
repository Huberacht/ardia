import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { changedIds, linkChanges, linkedChangedIds, scannedChangedIds, withEntry, LINKS_KEPT } = await import("./changes.ts");
const { without } = await import("./model.ts");

function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sorted = (ids) => [...ids].sort();

function assertSameAsScan(next, prev, where) {
  const scanned = scannedChangedIds(next, prev);
  assert.equal(new Set(scanned).size, scanned.length, `${where}: the scan lists each id once`);
  const linked = linkedChangedIds(next, prev);
  if (linked) {
    assert.equal(new Set(linked).size, linked.length, `${where}: the linked answer lists each id once`);
    assert.deepEqual(sorted(linked), sorted(scanned), `${where}: linked`);
  }
  assert.deepEqual(sorted(changedIds(next, prev)), sorted(scanned), `${where}: changedIds`);
  return !!linked;
}

function mutate(rand, prev, ids) {
  const pick = () => ids[Math.floor(rand() * ids.length)];
  const roll = rand();
  if (roll < 0.35) return withEntry(prev, pick(), rand() < 0.15 && prev[ids[0]] ? prev[ids[0]] : { v: rand() });
  if (roll < 0.45) {
    const id = pick();
    return prev[id] ? withEntry(prev, id, prev[id]) : withEntry(prev, id, { v: rand() });
  }
  if (roll < 0.6) return without(prev, Array.from({ length: 1 + Math.floor(rand() * 3) }, pick));
  if (roll < 0.68) return without(prev, new Set([pick(), "never-there"]));
  if (roll < 0.8) {
    const draft = { ...prev };
    const touched = [];
    for (let k = Math.floor(rand() * 4); k >= 0; k--) {
      const id = pick();
      if (rand() < 0.3) delete draft[id];
      else draft[id] = { v: rand() };
      touched.push(id);
    }
    if (rand() < 0.3) touched.push("never-there", touched[0]);
    return linkChanges(draft, prev, touched);
  }
  if (roll < 0.9) {
    const draft = { ...prev };
    draft[pick()] = { v: rand() };
    if (rand() < 0.5) delete draft[pick()];
    return draft;
  }
  if (roll < 0.95) return prev;
  return Object.fromEntries(Object.entries(prev).reverse());
}

test("on random edit sequences the linked answer always equals the full scan, for every pair of records", () => {
  let linkedPairs = 0;
  let pairs = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const rand = random(seed);
    const ids = Array.from({ length: 4 + Math.floor(rand() * 40) }, (_, i) => `t${i}`);
    const first = Object.fromEntries(ids.filter(() => rand() < 0.7).map((id) => [id, { v: rand() }]));
    const history = [first];
    for (let step = 0; step < 45; step++) {
      const from = rand() < 0.2 ? history[Math.floor(rand() * history.length)] : history.at(-1);
      history.push(mutate(rand, from, ids));
    }
    for (let j = 0; j < history.length; j++) {
      for (let i = 0; i < history.length; i++) {
        pairs++;
        if (assertSameAsScan(history[j], history[i], `seed ${seed} pair ${i}→${j}`)) linkedPairs++;
      }
    }
  }
  assert.ok(linkedPairs > pairs / 20, `the links answer a real share of pairs (${linkedPairs} of ${pairs})`);
});

test("a chain answers up to its kept length and falls back to the scan past it", () => {
  let record = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`t${i}`, { v: i }]));
  const history = [record];
  for (let i = 0; i < LINKS_KEPT + 3; i++) history.push((record = withEntry(record, `t${i % 5}`, { v: -i })));
  const newest = history.at(-1);
  for (let back = 1; back < history.length; back++) {
    const prev = history.at(-1 - back);
    const linked = linkedChangedIds(newest, prev);
    if (back <= LINKS_KEPT) assert.ok(linked, `${back} steps back is linked`);
    else assert.equal(linked, null, `${back} steps back is past the chain`);
    assertSameAsScan(newest, prev, `${back} back`);
  }
});

test("a record unlinked from its parent, or a parent edited in place, gets the full scan", () => {
  const prev = { a: { v: 1 }, b: { v: 2 } };
  const copy = { ...prev, c: { v: 3 } };
  assert.equal(linkedChangedIds(copy, prev), null);
  assert.deepEqual(changedIds(copy, prev), ["c"]);
  const next = withEntry(prev, "a", { v: 9 });
  const unrelated = { a: { v: 1 } };
  assert.equal(linkedChangedIds(next, unrelated), null);
  assertSameAsScan(next, unrelated, "unrelated");
});

test("the store's tab changes match the full scan through random actions, transactions included", async () => {
  const { useBrowser, storeTransaction } = await import("./store.ts");
  const { watchTab } = await import("../tabs/tabWatch.ts");
  const S = () => useBrowser.getState();
  let linked = 0;
  let notified = 0;
  let wakeMismatch = null;
  const woke = new Set();
  const watched = new Map();
  const expected = new Set();
  const off = useBrowser.subscribe((s, prev) => {
    if (s.tabs === prev.tabs) return;
    notified++;
    for (const id of watched.keys()) if (s.tabs[id] !== prev.tabs[id]) expected.add(id);
    if (assertSameAsScan(s.tabs, prev.tabs, `notification ${notified}`)) linked++;
  });
  const check = () => {
    if (!wakeMismatch && sorted(woke).join() !== sorted(expected).join()) wakeMismatch = { woke: sorted(woke), expected: sorted(expected) };
    woke.clear();
    expected.clear();
  };
  for (let seed = 1; seed <= 6; seed++) {
    const rand = random(1000 + seed);
    S().hydrate({});
    const w = S().createWindow({ url: "https://a.com" });
    for (let i = 0; i < 30; i++) S().newTab(w, { url: `https://site${i}.com/${i}`, background: rand() < 0.6 });
    for (const [, stop] of watched) stop();
    watched.clear();
    for (const id of Object.keys(S().tabs)) if (rand() < 0.5) watched.set(id, watchTab(id, () => woke.add(id)));
    woke.clear();
    expected.clear();
    const live = () => Object.keys(S().tabs);
    const pick = () => live()[Math.floor(rand() * live().length)];
    const action = () => {
      const roll = rand();
      const id = pick();
      if (!id) return;
      if (roll < 0.3) S().updateTab(id, { title: `T${rand()}` });
      else if (roll < 0.45) S().activate(id);
      else if (roll < 0.55) S().newTab(w, { url: `https://n${Math.floor(rand() * 1e6)}.com`, background: rand() < 0.5, openerId: rand() < 0.5 ? id : undefined });
      else if (roll < 0.65 && live().length > 3) S().closeTab(id);
      else if (roll < 0.75) S().navigate(id, `https://go${Math.floor(rand() * 1e6)}.com`);
      else if (roll < 0.82) S().togglePin(id);
      else if (roll < 0.88) S().duplicateTab(id);
      else if (roll < 0.92) S().updateTab(id, { muted: rand() < 0.5 });
      else S().closeTabs([id, pick()].filter(Boolean), { lastClosesWindow: false });
    };
    for (let step = 0; step < 120; step++) {
      if (rand() < 0.3) storeTransaction(() => {
        for (let k = 1 + Math.floor(rand() * 4); k > 0; k--) action();
      });
      else action();
      check();
    }
  }
  off();
  for (const [, stop] of watched) stop();
  assert.equal(wakeMismatch, null, "tab watchers wake for exactly the tabs that changed");
  assert.ok(notified > 300, `the actions changed tabs (${notified} notifications)`);
  assert.ok(linked > notified / 2, `most store notifications skip the scan (${linked} of ${notified})`);
});

test("the everyday tab actions on a big profile never compare every tab, and are counted only while sharing is on", async () => {
  const { useBrowser } = await import("./store.ts");
  const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
  const { changeDetection, takeChangeDetectionCounts } = await import("./changes.ts");
  const S = () => useBrowser.getState();
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com" });
  const ids = Array.from({ length: 300 }, (_, i) => S().newTab(w, { url: `https://site${i}.com`, background: true }));
  const heard = [];
  const off = useBrowser.subscribe((s, prev) => s.tabs !== prev.tabs && heard.push(changedIds(s.tabs, prev.tabs)));
  takeChangeDetectionCounts();
  S().updateTab(ids[7], { title: "unshared" });
  assert.deepEqual(takeChangeDetectionCounts(), { record_changes_linked: 0, record_changes_scanned: 0, record_changes_scanned_entries: 0 }, "nothing counted without consent");
  setConsentPeriod(true, "changes-linked-test");
  try {
    S().updateTab(ids[7], { title: "T7" });
    S().activate(ids[40]);
    S().newTab(w, { url: "https://new.com", background: true, openerId: ids[40] });
    S().newTab(w, { url: "https://front.com" });
    S().closeTab(ids[41]);
    S().navigate(ids[42], "https://elsewhere.com");
    S().togglePin(ids[43]);
    S().openPeek(ids[40], "https://peek.com");
    assert.ok(changeDetection.scannedEntries <= changeDetection.scanned * 5, `no scan compared the tabs, only the window record (${changeDetection.scannedEntries} entries in ${changeDetection.scanned} scans)`);
    assert.ok(changeDetection.linked >= 8, `each action was answered from its links (${changeDetection.linked})`);
    assert.ok(heard.every((ids) => ids.length < 10), "each notification names only the tabs it changed");
  } finally {
    setConsentPeriod(false, null);
    off();
  }
});
