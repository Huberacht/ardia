import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const D = await import("./fixtures/dragScene.mjs");
const { world, regionsOf } = await import("./fixtures/dragWorld.mjs");
const { RowAwareDragController } = await import("./rowAwareDragController.ts");
const { entryKey, sceneLayout, mount } = D;

function listScene() {
  const W = world("a", "b", "c");
  const L = sceneLayout({ top: 60 });
  const listTop = L.y;
  L.row(W.id.a).row(W.id.b).row(W.id.c).tail("list");
  return { ...W, L, regions: regionsOf(L, { list: [listTop, L.y] }) };
}

const scene = () => {
  const m = listScene();
  return { m, ...mount({ entries: m.L.entries, regions: m.regions, Controller: RowAwareDragController }) };
};
const frameOf = (m, id) => m.L.entries.find((e) => e.key === entryKey("tab", id)).frame;
const settle = () => new Promise((r) => setTimeout(r, 0));

function countMeasures(c) {
  const counted = { n: 0 };
  const measureAll = c.measureAll.bind(c);
  c.measureAll = (...args) => {
    counted.n++;
    return measureAll(...args);
  };
  return counted;
}

test("a drag lets the launch's held rows in before it measures its targets, from inside the sidebar and from outside", async () => {
  const { m, c } = scene();
  const order = [];
  c.beforeMeasure = () => order.push(`release while ${c.root.held ? "held" : "free"}`);
  c.root.held = true;
  const b = frameOf(m, m.id.b);
  const internal = c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  assert.deepEqual(order, ["release while held"], "released before the measure resolves");
  c.root.release();
  await internal;
  await c.end(false);
  c.root.held = true;
  const external = c.beginExternal(1, 60, 300);
  assert.equal(order.length, 2);
  c.root.release();
  await external;
  c.finishExternal(false);
});

test("an external drop let go while arriving rows are measured keeps the drop it was over", async () => {
  const { m, c } = scene();
  await c.beginExternal(1, 60, 300);
  const b = frameOf(m, m.id.b);
  c.move(60, b.y + 2);
  c.root.held = true;
  c.rowsArrived();
  assert.equal(c.refreshingRows, true);
  assert.equal(c.session.measured, true, "the targets stay usable while the new rows are measured");
  const placed = c.finishExternal(true);
  assert.notEqual(placed, null);
  c.root.release();
  await settle();
});

test("a row that arrives during the drag's first measure is measured once that measure is done", async () => {
  const { c } = scene();
  const measures = countMeasures(c);
  c.root.held = true;
  const pending = c.beginExternal(1, 60, 300);
  c.rowsArrived();
  c.root.release();
  await pending;
  await settle();
  assert.equal(measures.n, 2);
  assert.equal(c.refreshingRows, false);
  c.finishExternal(false);
});

test("a refresh that finishes after its drag ended changes nothing", async () => {
  const { c } = scene();
  await c.beginExternal(1, 60, 300);
  let moves = 0;
  const move = c.move.bind(c);
  c.move = (...args) => {
    moves++;
    return move(...args);
  };
  c.root.held = true;
  c.rowsArrived();
  c.finishExternal(false);
  c.root.release();
  await settle();
  assert.equal(moves, 0);
});
