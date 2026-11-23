import assert from "node:assert/strict";
import { test } from "node:test";

const { Animated } = await import("react-native");
const { holdsDrawn, setAppearing, setSliding } = await import("./shiftMarks.ts");

test("a sliding row keeps its first drawn style only while the native driver moves it", () => {
  const shift = new Animated.Value(-37);
  assert.equal(holdsDrawn(shift), false);
  setSliding(shift, true);
  assert.equal(holdsDrawn(shift), false, "a JS-driven slide (Linux) lets every frame through");
  shift.__isNative = true;
  assert.equal(holdsDrawn(shift), true);
  setSliding(shift, false);
  assert.equal(holdsDrawn(shift), false);
});

test("an appearing row holds its style for a native fade and lets a JS-driven fade through", () => {
  const shift = new Animated.Value(0);
  const opacity = new Animated.Value(0);
  setAppearing(shift, opacity);
  setSliding(shift, true);
  assert.equal(holdsDrawn(shift), false);
  opacity.__isNative = true;
  assert.equal(holdsDrawn(shift), true);
});
