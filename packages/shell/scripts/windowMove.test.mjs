import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const move = readFileSync(new URL("../ios/WindowMove.swift", import.meta.url), "utf8");

test("on macOS 27.2+ a window drag asks macOS first and only falls back to Ardia's own loop", () => {
  const swizzle = move.slice(move.indexOf("let block: @convention(block) (NSWindow, NSEvent) -> Void"), move.indexOf("method_setImplementation(method, imp_implementationWithBlock(block))"));
  const asks = swizzle.indexOf("WindowMove.asksWindowServer(window, from: event)");
  const follows = swizzle.indexOf("WindowMove.follow(window, from: event)");
  assert.ok(asks > 0 && asks < follows, "the press asks the window server before Ardia moves the window itself");
  assert.match(swizzle, /if WindowMove\.askingWindowServer \{ return original\(window, selector, event\) \}/);
});

test("Ardia takes the drag over only when macOS ended it before the button was released", () => {
  const asking = move.slice(move.indexOf("static func asksWindowServer"), move.indexOf("static func follow"));
  assert.match(move, /NSSelectorFromString\("performWindowDragWithEvent:completionHandler:"\)/);
  assert.match(asking, /dragWithCompletion\(window, dragWithCompletionSelector, event\)/);
  assert.match(asking, /let endedBeforeRelease = NSEvent\.pressedMouseButtons & 1 != 0/);
  assert.match(asking, /guard endedBeforeRelease else \{\s*ShellEvents\.send\(\.app, stamp\.onto\(\["type": "windowDragNative"\]\)\)/);
  assert.match(asking, /DispatchQueue\.main\.async \{\s*guard let window else \{ return \}\s*_ = follow\(window, from: event, stamp: stamp\)/);
  assert.ok(!/completed \{/.test(asking), "the handler's completed flag is true even for a drag macOS never began, so it decides nothing");
  assert.ok(!asking.includes("announceDrag"), "a press handed to macOS announces nothing: AppKit's willMove covers a real move, and a click must not stop Little Ardia's landing fit");
});

test("a drag Ardia moves counts once, on its first real placement", () => {
  const follow = move.slice(move.indexOf("static func follow"), move.indexOf("private static let gestureEvents"));
  assert.match(follow, /if !announced \{\s*announced = true\s*announceDrag\(of: window\)\s*ShellEvents\.send\(\.app, stamp\.onto\(\["type": "windowDragLoop"\]\)\)/);
  assert.equal(follow.match(/windowDragLoop/g).length, 1);
});
