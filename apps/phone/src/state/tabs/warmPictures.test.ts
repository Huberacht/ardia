import assert from "node:assert/strict";
import test from "node:test";
import { forgetWarmPictures, noteViewMoved, noteWarmPicture, warmPicture } from "./warmPictures.ts";

const window = { width: 393, height: 873 };
const frame = { x: 0, y: 0, width: 393, height: 873 };
const tab = (id: string, url = "https://example.com/", snapshotFileName: string | null = `file:///${id}.jpg`) => ({ id, url, snapshotFileName });
const capture = (id: string, settled = true) => ({ uri: `file:///${id}.jpg`, url: "https://example.com/", window, frame, settled });

test("a neighbour's picture is warm at its captured geometry while nothing about its view has moved", () => {
  noteWarmPicture("a", capture("a"));
  assert.deepEqual(warmPicture(tab("a"), window), { uri: "file:///a.jpg", frame });
  forgetWarmPictures(["a"]);
});

test("any move the WebView reports after the capture, a scroll, zoom, resize or new document, makes it cold until a new capture", () => {
  noteWarmPicture("b", capture("b"));
  noteViewMoved("b");
  assert.equal(warmPicture(tab("b"), window), null);
  noteWarmPicture("b", capture("b"));
  assert.notEqual(warmPicture(tab("b"), window), null);
  forgetWarmPictures(["b"]);
});

test("a capture whose view moved while it was taken, or that has no frame, is never warm", () => {
  noteWarmPicture("c", capture("c", false));
  assert.equal(warmPicture(tab("c"), window), null);
  noteWarmPicture("c", { ...capture("c"), frame: null });
  assert.equal(warmPicture(tab("c"), window), null);
  noteWarmPicture("c", { ...capture("c"), settled: undefined });
  assert.equal(warmPicture(tab("c"), window), null);
});

test("a picture taken while the page was moved or scaled by a gesture is never warm, so it can't sit offset over the live page", () => {
  noteWarmPicture("f", { ...capture("f"), frame: { x: 75, y: 19, width: 393, height: 873 } });
  assert.equal(warmPicture(tab("f"), window), null);
  noteWarmPicture("f", { ...capture("f"), frame: { x: 0, y: 10, width: 340, height: 760 } });
  assert.equal(warmPicture(tab("f"), window), null);
});

test("leaving for another address and coming back to the same one doesn't bring an old picture back", () => {
  noteWarmPicture("d", capture("d"));
  noteViewMoved("d");
  assert.equal(warmPicture(tab("d", "https://example.com/next"), window), null);
  assert.equal(warmPicture(tab("d"), window), null);
  forgetWarmPictures(["d"]);
});

test("a rotated window, a different picture on the tab, or a closed tab makes it cold", () => {
  noteWarmPicture("e", capture("e"));
  assert.equal(warmPicture(tab("e"), { width: window.height, height: window.width }), null);
  assert.equal(warmPicture(tab("e", "https://example.com/", "file:///other.jpg"), window), null);
  forgetWarmPictures(["e"]);
  assert.equal(warmPicture(tab("e"), window), null);
});
