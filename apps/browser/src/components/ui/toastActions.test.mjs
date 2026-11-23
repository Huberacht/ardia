import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require("react-dom/server");
const { createElement } = require("react");
const { pressables } = await import("react-native");
const { Button } = await import("./Button.tsx");
const { SplitToast } = await import("../split/SplitChrome.tsx");
const { showToast, useToasts } = await import("../../state/app/toasts.ts");
const { TOAST_ACTION_MS } = await import("../split/tokens.ts");

test("a toast's chip buttons are buttons to VoiceOver, named by their titles, and an accessibility tap presses them", () => {
  const pressed = [];
  pressables.length = 0;
  for (const title of ["Keep Running", "Sleep"]) renderToStaticMarkup(createElement(Button, { variant: "pill", tone: "chip", title, onPress: () => pressed.push(title) }));
  assert.deepEqual(pressables.map((p) => [p.accessibilityRole, p.accessibilityLabel]), [["button", "Keep Running"], ["button", "Sleep"]]);
  for (const b of pressables) b.onAccessibilityTap();
  assert.deepEqual(pressed, ["Keep Running", "Sleep"]);
  const toast = readFileSync(new URL("./Toast.tsx", import.meta.url), "utf8");
  assert.match(toast, /title=\{secondary\} onPress=\{onSecondary\}/);
  assert.match(toast, /title=\{action\} onPress=\{onAction\}/);
});

function shownToast(t, options) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  useToasts.setState({ toasts: {} });
  showToast("w", "Title", undefined, options);
  const mounted = mount(() => SplitToast.type({ windowId: "w" }));
  t.after(() => mounted.unmount());
  return mounted;
}

test("a two-button toast waits while it is pointed at or one of its buttons has keyboard focus, then gets its full time again", (t) => {
  const mounted = shownToast(t, { holdMs: 20_000, action: { title: "Sleep", run() {} }, secondary: { title: "Keep Running", run() {} } });
  const held = (on) => mounted.value.props.onHeld(on);
  held(true);
  mounted.rerender();
  t.mock.timers.tick(60_000);
  assert.equal(mounted.value.props.closing, false, "never closes while held");
  held(false);
  mounted.rerender();
  t.mock.timers.tick(19_000);
  assert.equal(mounted.value.props.closing, false);
  t.mock.timers.tick(1_000);
  assert.equal(mounted.value.props.closing, true, "closes a full hold after it was let go");
});

test("a one-button toast keeps its old timing and isn't held", (t) => {
  const mounted = shownToast(t, { action: { title: "Undo", run() {} } });
  assert.equal(mounted.value.props.onHeld, undefined);
  t.mock.timers.tick(TOAST_ACTION_MS);
  assert.equal(mounted.value.props.closing, true);
});
