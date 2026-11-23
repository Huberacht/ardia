import assert from "node:assert/strict";
import { test } from "node:test";

const { markStripPress, nameStripOpen, takeStripPress } = await import("./stripPress.ts");

test("a ✕ press marks only its own tab's close, once, in its own window", () => {
  markStripPress("w1", "close", "t1", 1000);
  assert.equal(takeStripPress("w2", ["t1"], [], 1010), false);
  assert.equal(takeStripPress("w1", ["t2"], [], 1010), false);
  assert.equal(takeStripPress("w1", ["t1"], [], 1010), true);
  assert.equal(takeStripPress("w1", ["t1"], [], 1020), false);
});

test("a + press marks the tab it opened, and a press that opened nothing runs out", () => {
  markStripPress("w1", "open", null, 2000);
  nameStripOpen("w1", "t9");
  assert.equal(takeStripPress("w1", [], ["t8"], 2010), false);
  assert.equal(takeStripPress("w1", [], ["t9"], 2010), true);
  markStripPress("w1", "open", null, 3000);
  assert.equal(takeStripPress("w1", [], ["t7"], 4500), false, "a link opening a tab later still slides");
});
