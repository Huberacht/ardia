import assert from "node:assert/strict";
import { test } from "node:test";

const { DragItems } = await import("./dragItems.ts");

function folded(away) {
  const listeners = new Set();
  return {
    away: () => away,
    set(next) {
      away = next;
      for (const changed of [...listeners]) changed();
    },
    subscribe(changed) {
      listeners.add(changed);
      return () => void listeners.delete(changed);
    },
  };
}

function controller() {
  const late = [];
  return { items: new Map(), late, active: true, measureLate: (item) => late.push(item.key) };
}

test("a row hidden in a closed folder is no drag target, and becomes one again when the folder opens", () => {
  const c = controller();
  const items = new DragItems(c, true);
  const row = { key: "tab:t1", gap: { stopAnimation() {}, setValue() {} } };
  const shown = folded(true);
  const stop = items.addWhileShown(row.key, row, shown);
  assert.equal(c.items.has(row.key), false, "a row mounted inside a closed folder isn't registered");
  shown.set(false);
  assert.equal(c.items.get(row.key), row, "opening the folder registers it");
  shown.set(true);
  assert.equal(c.items.has(row.key), false, "closing the folder takes it out again, so its last frame can't be targeted");
  shown.set(false);
  stop();
  assert.equal(c.items.has(row.key), false, "unmounting removes it");
});

test("a row that registers while a drag runs asks the controller to measure it", () => {
  const c = controller();
  const items = new DragItems(c, true);
  items.add("tab:t2", { key: "tab:t2" });
  assert.deepEqual(c.late, ["tab:t2"]);
});

test("a row hidden by its folder closing during a drag gives back the gap it had opened", () => {
  const c = controller();
  const items = new DragItems(c, true);
  let gap = 33;
  const row = { key: "tab:t3", gap: { stopAnimation() {}, setValue: (v) => (gap = v) } };
  const shown = folded(false);
  items.addWhileShown(row.key, row, shown);
  shown.set(true);
  assert.equal(gap, 0);
});

test("a row measured while gaps are open is stored where it rests", async () => {
  const { openGapsAbove } = await import("./dragModel.ts");
  const value = (v) => ({ __getValue: () => v });
  const above = { key: "a", kind: "row", gap: value(33), frame: { x: 0, y: 100, w: 200, h: 30 } };
  const below = { key: "b", kind: "row", gap: value(20), frame: { x: 0, y: 400, w: 200, h: 30 } };
  const tile = { key: "t", kind: "tile", gap: value(50), frame: { x: 0, y: 0, w: 40, h: 40 } };
  const late = { key: "late", kind: "row", gap: value(5), frame: null };
  assert.equal(openGapsAbove(late, 200 + 33 + 5, [above, below, tile, late]), 38);
});

test("two dragged rows above a row measured late both come off, even when the lower one starts below where the row now shows", async () => {
  const { sourcesClosedAbove } = await import("./dragModel.ts");
  const closed = (y) => ({ kind: "row", section: "list", size: { __getValue: () => 0 }, frame: { x: 0, y, w: 180, h: 30 } });
  const first = closed(100);
  const second = closed(140);
  const late = { key: "late", kind: "row", section: "list", frame: null };
  assert.equal(sourcesClosedAbove([second, first], late, 200 - 66, 3), 66);
  assert.equal(sourcesClosedAbove([second, first], late, 90, 3), 0);
});
