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
  const row = { key: "tab:t1" };
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
