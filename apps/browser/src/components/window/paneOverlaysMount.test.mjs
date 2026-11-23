import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
const { usePanelsPresence } = await import("../ui/Popover.tsx");
const { OVERLAY, overlayBits, overlayCount, pageOverlays, useKeptOverlays, useKeptWhile } = await import("./overlayGate.ts");
const { pageOf } = await import("../../state/tabs/pageState.ts");
const IDLE_PAGE = pageOf("no such tab");

const KINDS = ["siteControls", "zoom", "hiddenElements"];
const shownOf = (panel) => Object.fromEntries(KINDS.map((kind) => [kind, panel(kind)]).filter(([, presence]) => presence).map(([kind, presence]) => [kind, presence.closing ? "closing" : "open"]));

test("a pane shows no site panel until one opens, and a closing panel stays until its close animation ends", () => {
  const hook = mount(({ open }) => usePanelsPresence(open, KINDS), { props: { open: null } });
  assert.deepEqual(shownOf(hook.value), {});
  assert.deepEqual(shownOf(hook.rerender({ open: "popups" })), {}, "a popover that is not a site panel shows none");
  assert.deepEqual(shownOf(hook.rerender({ open: "zoom" })), { zoom: "open" });
  assert.deepEqual(shownOf(hook.rerender({ open: "siteControls" })), { zoom: "closing", siteControls: "open" });
  hook.value("zoom").onClosed();
  assert.deepEqual(shownOf(hook.value), { siteControls: "open" });
  assert.deepEqual(shownOf(hook.rerender({ open: null })), { siteControls: "closing" });
  assert.deepEqual(shownOf(hook.rerender({ open: "siteControls" })), { siteControls: "open" }, "reopening before the close ends keeps the same panel");
  hook.rerender({ open: null });
  hook.value("siteControls").onClosed();
  assert.deepEqual(shownOf(hook.value), {});
});

test("each pane mounts its rare overlays only while they show, with no wrapper component per pane", () => {
  const overlays = readFileSync(new URL("./PageOverlays.tsx", import.meta.url), "utf8");
  for (const wrapper of ["<SiteControls ", "<ZoomPopover", "<HiddenElementsPopover"]) assert.ok(!overlays.includes(wrapper), `${wrapper} is a per-pane wrapper`);
  assert.match(overlays, /\{verificationCodes && has\("verificationCode"\) && <VerificationCodePrompt /, "a pane mounts the verification code prompt only while a plugin that sets them up is on and a code is offered");
  const pane = readFileSync(new URL("./TabPane.tsx", import.meta.url), "utf8");
  assert.ok(!pane.includes("TabContentArea"), "the content area is marked by a prop, not a wrapper component per pane");
});

test("a pane shown with nothing over its page mounts none of its overlays, only the swipe area", () => {
  const overlays = readFileSync(new URL("./PageOverlays.tsx", import.meta.url), "utf8");
  const body = overlays.slice(overlays.indexOf("export function PageOverlays("), overlays.indexOf("function usePageOverlays("));
  const jsx = body.slice(body.indexOf("return ("));
  const ungated = jsx.split("\n").filter((line) => /^ {6}<[A-Z]/.test(line)).map((line) => line.trim().split(/[ />]/)[0]);
  assert.deepEqual(ungated, ["<SwipeOverlay"], "every other overlay waits for its state");
  for (const overlay of Object.keys(OVERLAY)) assert.ok(jsx.includes(`has("${overlay}")`), `${overlay} is gated`);
  const pane = readFileSync(new URL("./TabPane.tsx", import.meta.url), "utf8");
  assert.match(pane, /\{shareBar && <ShareBar /);
  assert.match(pane, /\{visible && own\.appPage && <InternalPage /);
});

test("each page state that shows an overlay turns on its own bit", () => {
  assert.equal(pageOverlays(IDLE_PAGE), 0);
  const cases = { status: { status: "https://a.test/" }, sadTab: { crashed: { reason: "crashed" } }, permission: { permission: { id: 1 } }, password: { passwordPrompt: {} }, autofill: { autofillPrompt: {} }, verificationCode: { verificationCode: {} }, externalApp: { externalApp: {} } };
  for (const [overlay, patch] of Object.entries(cases)) assert.equal(pageOverlays({ ...IDLE_PAGE, ...patch }), OVERLAY[overlay], overlay);
  assert.equal(pageOverlays({ ...IDLE_PAGE, unresponsive: true }), OVERLAY.sadTab);
  assert.equal(overlayBits({ find: true, selection: false, loading: true }), OVERLAY.find | OVERLAY.loading);
  assert.equal(overlayCount(OVERLAY.find | OVERLAY.loading | OVERLAY.control), 3);
});

test("an overlay stays mounted once it showed, so its close animation runs, and only one that turned on later animates in", () => {
  const hook = mount(({ on }) => useKeptOverlays(on), { props: { on: OVERLAY.status } });
  assert.equal(hook.value.has("status"), true);
  assert.equal(hook.value.has("find"), false);
  assert.equal(hook.value.entersLater("status"), false, "a link address already showing when the tab came into view shows at once, as before");
  hook.rerender({ on: OVERLAY.find });
  assert.equal(hook.value.has("find"), true);
  assert.equal(hook.value.has("status"), true, "the link address stays mounted to fade out");
  assert.equal(hook.value.entersLater("find"), true);
  hook.rerender({ on: 0 });
  assert.equal(hook.value.has("find") && hook.value.has("status"), true);
});

test("the share bar stays mounted while the pane shows, and is let go when it hides", () => {
  const hook = mount(({ on, alive }) => useKeptWhile(on, alive), { props: { on: false, alive: true } });
  assert.equal(hook.value, false);
  assert.equal(hook.rerender({ on: true, alive: true }), true);
  assert.equal(hook.rerender({ on: false, alive: true }), true);
  assert.equal(hook.rerender({ on: false, alive: false }), false);
  assert.equal(hook.rerender({ on: false, alive: true }), false);
});
