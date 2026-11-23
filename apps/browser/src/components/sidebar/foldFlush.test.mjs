import assert from "node:assert/strict";
import { test } from "node:test";

const frames = [];
globalThis.requestAnimationFrame = (run) => frames.push(run);
const drain = async () => {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
    const due = frames.splice(0);
    for (const run of due) run(0);
  }
};
const { fillingFold, flushFolds, foldsFilling } = await import("./foldFlush.ts");

test("a flush keeps going until no fold in the window is pending, so a child that registers during it is flushed too", async () => {
  const ran = [];
  const parent = fillingFold("w1", () => {
    ran.push("parent");
    parent();
    const child = fillingFold("w1", () => {
      ran.push("child");
      child();
    });
  });
  const done = flushFolds("w1");
  await drain();
  await done;
  assert.deepEqual(ran, ["parent", "child"]);
  assert.equal(foldsFilling("w1"), false);
});

test("a flush stays in its own window", async () => {
  const ran = [];
  const other = fillingFold("w2", () => ran.push("w2"));
  const mine = fillingFold("w1", () => {
    ran.push("w1");
    mine();
  });
  const done = flushFolds("w1");
  await drain();
  await done;
  assert.deepEqual(ran, ["w1"]);
  assert.equal(foldsFilling("w2"), true);
  other();
});
