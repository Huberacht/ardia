import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { useBrowser } from "../browser/store.ts";
import { windows } from "../../test-native/shell.ts";
import { closeIntroWindowFor, coverOrReveal, coverScreenForIntro, handOffFromIntro, holdWindowHidden, uncoverScreen } from "./introCover.ts";
import { INTRO_WINDOW_ID } from "./introWindow.ts";
import { startOnboarding, useOnboarding } from "./onboarding.ts";

test("a cover opened again right after the last one was let go stays open past the old linger", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const id = useBrowser.getState().createWindow();
    coverScreenForIntro(id);
    assert.equal(windows.open.get(INTRO_WINDOW_ID)?.cover, id, "the cover names the browser window it covers");
    uncoverScreen(id);
    coverScreenForIntro(id);
    mock.timers.tick(5000);
    assert.ok(windows.open.has(INTRO_WINDOW_ID), "the new cover is still open");
    uncoverScreen(id);
    mock.timers.tick(5000);
    assert.ok(!windows.open.has(INTRO_WINDOW_ID), "the cover closes once it is let go for good");
  } finally {
    mock.timers.reset();
    useOnboarding.setState({ windowId: null, leaving: false, redo: false });
  }
});

test("the hand-off from one session's intro doesn't move a newer session past its intro", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const id = useBrowser.getState().createWindow();
    startOnboarding(id, "intro");
    handOffFromIntro(false);
    startOnboarding(id, "intro");
    mock.timers.tick(5000);
    assert.equal(useOnboarding.getState().step, "intro");
  } finally {
    mock.timers.reset();
    useOnboarding.setState({ windowId: null, leaving: false, redo: false });
  }
});

test("a new session's intro in the reused cover window isn't closed or handed off by the old session's intro", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const id = useBrowser.getState().createWindow();
    startOnboarding(id, "intro");
    const first = useOnboarding.getState().session;
    coverScreenForIntro(id);
    startOnboarding(id, "intro");
    const second = useOnboarding.getState().session;
    coverScreenForIntro(id);
    handOffFromIntro(false, first);
    closeIntroWindowFor(first);
    mock.timers.tick(5000);
    assert.ok(windows.open.has(INTRO_WINDOW_ID), "the new session's cover is still open");
    assert.equal(useOnboarding.getState().step, "intro", "the new session is still on its intro");
    closeIntroWindowFor(second);
    assert.ok(!windows.open.has(INTRO_WINDOW_ID), "the new session's own intro closes it");
  } finally {
    mock.timers.reset();
    useOnboarding.setState({ windowId: null, leaving: false, redo: false });
  }
});

test("an intro that doesn't cover the screen shows the browser window the intro hold hid", () => {
  const id = useBrowser.getState().createWindow();
  holdWindowHidden(id);
  assert.equal(windows.shown.get(id), false);
  const before = windows.open.has(INTRO_WINDOW_ID);
  assert.equal(coverOrReveal(id, false), undefined);
  assert.equal(windows.shown.get(id), true, "the held browser window is shown again");
  assert.equal(windows.open.has(INTRO_WINDOW_ID), before, "no cover opens");
});

test("an intro that covers the screen keeps the browser window hidden until the cover is let go", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const id = useBrowser.getState().createWindow();
    holdWindowHidden(id);
    const release = coverOrReveal(id, true);
    assert.equal(windows.shown.get(id), false);
    assert.ok(windows.open.has(INTRO_WINDOW_ID));
    release();
    assert.equal(windows.shown.get(id), true);
    mock.timers.tick(5000);
  } finally {
    mock.timers.reset();
  }
});
