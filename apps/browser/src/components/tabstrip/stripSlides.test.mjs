import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const native = await import("../../test-native/reactNative.ts");
const client = await import("../../state/telemetry/client.ts");
const { takeTabMotionCounts } = await import("../../state/telemetry/tabMotionCounts.ts");
const { createMotion, plan } = await import("./stripSlides.ts");

const animations = native.animations;
after(() => {
  animations.held = false;
  animations.running = [];
  client.setSharing(false, "settings");
});

const shot = (keys, { width = 100, tabs = {}, end = null } = {}) => ({
  keys,
  x: new Map(keys.map((k, i) => [k, i * (width + 4)])),
  width: new Map(keys.map((k) => [k, width])),
  tabs: new Map(keys.map((k) => [k, [k]])),
  groups: new Set(),
  end,
  state: { tabs: Object.fromEntries([...keys, ...Object.keys(tabs)].map((k) => [k, { id: k, url: `https://e.test/${k}`, title: k, profileId: "default" }])) },
});

const held = (fn) => {
  animations.held = true;
  try {
    return fn();
  } finally {
    animations.held = false;
  }
};

test("a close while a chip still slides keeps the slide and restarts it from where it is drawn", () => {
  const own = createMotion();
  held(() => {
    own.apply({ moves: [{ key: "b", from: 104 }], appears: [], ghosts: [], at: Date.now() });
    const slide = own.motion.slide("b");
    assert.ok(slide);
    own.motion.mount(slide);
    assert.equal(slide.runs, 1);
    own.apply({ moves: [{ key: "b", from: 154 }], appears: [], ghosts: [], at: Date.now() + 50 });
    assert.equal(own.motion.slide("b"), slide, "the live slide survives the second close");
    assert.equal(slide.runs, 1, "and runs again");
    assert.equal(slide.value.__getValue(), 154);
  });
  animations.finish();
  assert.equal(own.motion.slide("b"), null, "it lands once the restarted run ends");
});

test("three closes in a row each restart the same chips without dropping one", () => {
  const own = createMotion();
  held(() => {
    const at = Date.now();
    own.apply({ moves: [{ key: "c", from: 104 }, { key: "d", from: 104 }], appears: [], ghosts: [], at });
    for (const k of ["c", "d"]) own.motion.mount(own.motion.slide(k));
    for (let i = 1; i < 3; i++) {
      own.apply({ moves: [{ key: "c", from: 104 * (i + 1) }, { key: "d", from: 104 * (i + 1) }], appears: [], ghosts: [], at: at + 120 * i });
      for (const k of ["c", "d"]) assert.equal(own.motion.slide(k)?.runs, 1, `${k} after close ${i + 1}`);
    }
  });
  animations.finish();
  assert.equal(own.slides.size, 0);
});

test("the planner slides what moved, fades what opened and leaves a ghost for what closed, only in view", () => {
  const before = shot(["a", "b", "c", "far"], { tabs: {} });
  const after = shot(["a", "c", "far"]);
  delete after.state.tabs.b;
  after.x.set("far", 5000);
  before.x.set("far", 5104);
  const p = plan(before, after, new Map(), [-48, 1000], Date.now(), false);
  assert.deepEqual(p.moves.map((m) => [m.key, m.from]), [["c", 104]]);
  assert.deepEqual(p.ghosts.map((g) => g.x), [104]);
  assert.equal(plan(before, before, new Map(), [-48, 1000], Date.now(), false), null);
});

test("an overrun counts in the consent period its run started in, not the one it was found in", () => {
  client.loadChoice();
  client.setSharing(false, "settings");
  takeTabMotionCounts();
  const own = createMotion();
  const at = Date.now() - 10_000;
  held(() => {
    own.apply({ moves: [{ key: "e", from: 104 }], appears: [], ghosts: [], at });
    own.motion.mount(own.motion.slide("e"));
  });
  client.setSharing(true, "settings");
  held(() => own.apply({ moves: [], appears: [], ghosts: [], at: Date.now() }));
  assert.equal(takeTabMotionCounts().tab_strip_motion_overruns, 0);

  const later = createMotion();
  held(() => {
    later.apply({ moves: [{ key: "f", from: 104 }], appears: [], ghosts: [], at });
    later.motion.mount(later.motion.slide("f"));
    later.apply({ moves: [], appears: [], ghosts: [], at: Date.now() });
  });
  assert.equal(takeTabMotionCounts().tab_strip_motion_overruns, 1);
  animations.running = [];
});

test("a drag landing the strip puts every sliding chip in its final place at once", () => {
  const own = createMotion();
  held(() => {
    own.apply({ moves: [{ key: "g", from: 104 }], appears: ["h"], ghosts: [], at: Date.now() });
    for (const k of ["g", "h"]) own.motion.mount(own.motion.slide(k));
    const g = own.motion.slide("g");
    const h = own.motion.slide("h");
    own.motion.land();
    assert.equal(own.slides.size, 0);
    assert.equal(g.value.__getValue(), 0);
    assert.equal(h.opacity.__getValue(), 1);
  });
  animations.running = [];
});
