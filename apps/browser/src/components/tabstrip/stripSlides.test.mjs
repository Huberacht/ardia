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
    assert.ok(slide.moving);
    own.apply({ moves: [{ key: "b", from: 154 }], appears: [], ghosts: [], at: Date.now() + 50 });
    assert.equal(own.motion.slide("b"), slide, "the live slide survives the second close");
    assert.ok(slide.moving, "and runs again");
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
      for (const k of ["c", "d"]) assert.ok(own.motion.slide(k)?.moving, `${k} after close ${i + 1}`);
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

test("a drag landing the strip puts every sliding chip in its final place at once and lets fades finish", () => {
  const own = createMotion();
  held(() => {
    own.apply({ moves: [{ key: "g", from: 104 }], appears: ["h"], ghosts: [], at: Date.now() });
    for (const k of ["g", "h"]) own.motion.mount(own.motion.slide(k));
    const g = own.motion.slide("g");
    const h = own.motion.slide("h");
    own.motion.land();
    assert.equal(own.motion.slide("g"), null);
    assert.equal(g.value.__getValue(), 0);
    assert.equal(h.value.__getValue(), 0, "nothing is left out of place");
  });
  animations.finish();
  assert.equal(own.slides.size, 0);
});

test("a second close leaves a chip whose place it doesn't change on its running slide, the + button too", () => {
  const own = createMotion();
  const at = Date.now();
  const first = shot(["a", "b", "c", "d"], { end: 420 });
  const second = shot(["b", "c", "d"], { end: 316 });
  delete second.state.tabs.a;
  held(() => {
    own.apply(plan(first, second, own.slides, [-48, 1000], at, false));
    for (const k of own.slides.keys()) own.motion.mount(own.motion.slide(k));
    const b = own.motion.slide("b");
    const plus = own.motion.slide("~new");
    const third = shot(["b", "d"], { end: 212 });
    delete third.state.tabs.a;
    delete third.state.tabs.c;
    third.x.set("b", second.x.get("b"));
    third.end = second.end;
    const p = plan(second, third, own.slides, [-48, 1000], at + 50, false);
    assert.deepEqual(p.moves.map((m) => m.key), ["d"]);
    own.apply(p);
    assert.equal(own.motion.slide("b"), b);
    assert.equal(b.from, 104, "b keeps the run it had");
    assert.equal(own.motion.slide("~new"), plus);
  });
  animations.running = [];
});

test("a tab closed while it fades in leaves a ghost that starts where its fade was", () => {
  const own = createMotion();
  const at = Date.now();
  const opened = shot(["a", "n", "b"]);
  const closed = shot(["a", "b"]);
  delete closed.state.tabs.n;
  held(() => {
    own.apply({ moves: [], appears: ["n"], ghosts: [], at });
    own.motion.mount(own.motion.slide("n"));
    const p = plan(opened, closed, own.slides, [-48, 1000], at + 30, false);
    assert.equal(p.ghosts.length, 1);
    const start = p.ghosts[0].opacity.__getValue();
    assert.ok(start > 0 && start < 1, `the ghost starts at ${start}, not opaque`);
  });
  animations.running = [];
});

test("only the close a strip press made steps; a close from elsewhere still slides, wherever the pointer is", () => {
  const before = shot(["a", "b", "c"], { end: 312 });
  const after = shot(["a", "c"], { end: 208 });
  delete after.state.tabs.b;
  const pressed = plan(before, after, new Map(), [-48, 1000], Date.now(), false, (closed) => closed.includes("b"));
  assert.equal(pressed.stepped, true);
  assert.deepEqual(pressed.moves, []);
  assert.equal(pressed.ghosts.length, 1);
  const elsewhere = plan(before, after, new Map(), [-48, 1000], Date.now(), false, (closed) => closed.includes("x"));
  assert.equal(elsewhere.stepped, false);
  assert.deepEqual(elsewhere.moves.map((m) => m.key), ["c", "~new"]);
});

test("a step lands translations but lets a fade-in finish", () => {
  const own = createMotion();
  held(() => {
    own.apply({ moves: [{ key: "m", from: 104 }], appears: ["n"], ghosts: [], at: Date.now(), stepped: false });
    for (const k of ["m", "n"]) own.motion.mount(own.motion.slide(k));
    const n = own.motion.slide("n");
    own.motion.land();
    assert.equal(own.motion.slide("m"), null, "the slide lands");
    assert.equal(own.motion.slide("n"), n, "the fade keeps running");
    assert.equal(n.fading, true);
    assert.equal(n.opacity.__getValue(), 0);
  });
  animations.finish();
  assert.equal(own.slides.size, 0);
});

test("a fading tab that slides keeps its fade's own clock, so its ghost starts where the fade is", () => {
  const own = createMotion();
  const at = Date.now();
  held(() => {
    own.apply({ moves: [], appears: ["n"], ghosts: [], at, stepped: false });
    const n = own.motion.slide("n");
    own.motion.mount(n);
    n.appearAt = at - 70;
    own.apply({ moves: [{ key: "n", from: 104 }], appears: [], ghosts: [], at: at + 10, stepped: false });
    assert.equal(n.appearAt, at - 70, "moving it doesn't restart its fade");
    assert.equal(n.fading, true);
    const opened = shot(["a", "n"]);
    const closed = shot(["a"]);
    delete closed.state.tabs.n;
    const ghost = plan(opened, closed, own.slides, [-48, 1000], at + 20, false).ghosts[0];
    assert.equal(ghost.opacity.__getValue(), 90 / 140);
  });
  animations.running = [];
});
