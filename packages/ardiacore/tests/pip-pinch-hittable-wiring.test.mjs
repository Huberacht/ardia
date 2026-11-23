import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const read = (name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const zoom = read("../ios/ArdiaPiPZoom.mm");
const math = read("../ios/ArdiaPiPZoomMath.h");

const body = (source, header) => {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `missing ${header}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end < 0 ? source.length : end);
};

test("while the stand-in shows a pinch or edge drag, the real window stays where the rest of the gesture lands", () => {
  const began = body(zoom, "- (void)pinchBegan {");
  assert.match(began, /_hiddenAlpha = window\.alphaValue;\s*window\.alphaValue = MIN\(_hiddenAlpha, ardia_pip_zoom::kHittableHiddenAlpha\);/);
  assert.doesNotMatch(began, /window\.alphaValue = 0;/);
  const alpha = Number(math.match(/constexpr double kHittableHiddenAlpha = ([\d.]+);/)?.[1]);
  assert.ok(alpha > 0 && alpha <= 0.02, `kHittableHiddenAlpha ${alpha}`);
});

test("the stand-in's own panel never takes the gesture, and the window gets its alpha back at the hand-off", () => {
  assert.match(body(zoom, "- (void)pinchBegan {"), /panel\.ignoresMouseEvents = YES;/);
  assert.match(body(zoom, "- (void)finishHandOff:(BOOL)timedOut {"), /_window\.alphaValue = _hiddenAlpha;/);
});

const pip = read("../ios/ArdiaPictureInPicture.mm");
const routing = read("../ios/ArdiaPiPZoom+Routing.mm");
const controller = read("../ios/ArdiaPiPController.mm");
const webView = read("../ios/ArdiaWebView+PictureInPicture.mm");

test("a pinch or a ⌘-scroll finds the Picture in Picture window under the pointer, not the window macOS handed the gesture to", () => {
  assert.doesNotMatch(zoom + routing, /if \(event\.window\) return event\.window;/);
  const under = body(routing, "+ (NSWindow *)windowUnder:(NSPoint)pointer {");
  assert.match(under, /if \(!ardia_pip_zoom::UsablePointer\(\{pointer\.x, pointer\.y\}\)\) return nil;/);
  assert.match(under, /\[NSWindow windowNumberAtPoint:pointer belowWindowWithWindowNumber:0\]/);
  assert.match(under, /ardia_pip_zoom::WindowUnder\(/);
  const pinch = body(routing, "+ (BOOL)routePinch:(NSEvent *)event fromOtherApp:(BOOL)fromOtherApp {");
  assert.match(pinch, /ardia_pip_zoom::StepPinch\(gPinchLock,/);
  assert.match(pinch, /if \(!ardia_pip_zoom::UsablePointer\(\{pointer\.x, pointer\.y\}\)\) return gPinchLock\.owned;/);
  assert.match(pinch, /\[self watchForStall\];/);
  assert.doesNotMatch(zoom + routing, /convertPointToScreen:event\.locationInWindow/);
});

test("a pinch whose end never arrives, or that a new pinch replaces, never leaves the stand-in up", () => {
  const apply = body(routing, "+ (void)apply:(ardia_pip_zoom::PinchStep)next");
  assert.match(apply, /next\.finish \? \[NSApp windowWithWindowNumber:next\.finish\] : nil\) \[\[self forWindow:finished\] pinchEnded\];/);
  assert.match(body(routing, "+ (void)watchForStall {"), /ardia_pip_zoom::StallPinch\(gPinchLock\)/);
  assert.match(body(zoom, "- (void)tick:(CADisplayLink *)link {"), /if \(!ardia_pip_zoom::KeepsStandIn\(window != nil, window\.visible, \[ArdiaPiPController forWindow:window\]\.stashedEdge != ArdiaPiPEdgeNone\)\)\s*return \[self cancelStandIn\];/);
});

test("pinches from other apps are followed only while Ardia is in the background with a zoomable Picture in Picture window, and never activate it", () => {
  const follow = body(pip, "void FollowPinchesFromOtherApps() {");
  assert.match(follow, /const BOOL wanted = ardia_pip_zoom::WantsOtherAppPinches\(NSApp\.isActive, \[ArdiaPiPZoom anyZoomable\]\);/);
  assert.match(follow, /addGlobalMonitorForEventsMatchingMask:NSEventMaskMagnify\b/);
  assert.match(follow, /\[NSEvent removeMonitor:gOtherAppPinchMonitor\];/);
  assert.match(body(routing, "+ (BOOL)anyZoomable {"), /if \(\[self zooms:window\]\) return YES;/);
  const fromOtherApp = body(pip, "void PinchFromOtherApp(NSEvent *event) {");
  assert.match(fromOtherApp, /if \(!ardia_pip_zoom::WantsOtherAppPinches\(NSApp\.isActive, \[ArdiaPiPZoom anyZoomable\]\)\) return FollowPinchesFromOtherApps\(\);/);
  assert.doesNotMatch(fromOtherApp + body(routing, "+ (BOOL)routePinch:(NSEvent *)event fromOtherApp:(BOOL)fromOtherApp {"), /Activate/);
  assert.match(body(routing, "+ (BOOL)handle:(NSEvent *)event fromOtherApp:(BOOL)fromOtherApp {"), /event\.timestamp == gLastPinchAt/);
});

test("the pinch monitor for other apps is looked at again when a Picture in Picture window closes, hides, tucks or comes back", () => {
  assert.match(body(pip, "void InstallZoomMonitor() {"), /NSWindowWillCloseNotification, NSWindowDidChangeOcclusionStateNotification[\s\S]*RefreshPinchesFromOtherApps\(\);/);
  assert.match(body(controller, "- (void)setStashedEdge:(ArdiaPiPEdge)edge {"), /RefreshPinchesFromOtherApps\(\);/);
  assert.match(body(controller, "- (void)detach {"), /RefreshPinchesFromOtherApps\(\);/);
  assert.match(body(webView, "- (void)tab:(ArdiaCoreTab *)tab didChangePictureInPicture:"), /if \(!active\) \{\s*ardia_pip::RefreshPinchesFromOtherApps\(\);/);
  assert.match(body(pip, "void DocumentEntered(ArdiaWebView *view, ArdiaConsentStamp *stamp) {"), /InstallZoomMonitor\(\);/);
});

test("the pointer of an event with no Core Graphics event behind it comes from the mouse, never a null CGEvent", () => {
  assert.match(body(controller, "NSPoint PointerOf(NSEvent *event) {"), /CGEventRef backing = event\.CGEvent;\s*if \(!backing\) return NSEvent\.mouseLocation;/);
});
