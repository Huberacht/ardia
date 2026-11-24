import assert from "node:assert/strict";
import test from "node:test";
import { forgetWarmPictures, noteSettledScroll, noteWarmPicture, warmPicture } from "./warmPictures.ts";

const viewport = { width: 393, height: 873 };
const size = { width: 600, height: 1333 };
const tab = (id: string, url = "https://example.com/", snapshotFileName: string | null = `file:///${id}.jpg`) => ({ id, url, snapshotFileName });

test("a neighbour's picture is warm while its tab, document, viewport and scroll match the capture", () => {
  noteSettledScroll("a", 120);
  noteWarmPicture("a", "file:///a.jpg", "https://example.com/", viewport, size);
  assert.deepEqual(warmPicture(tab("a"), viewport), { uri: "file:///a.jpg", size });
  forgetWarmPictures(["a"]);
});

test("a scroll after the capture makes it cold, and the next capture warms it again", () => {
  noteSettledScroll("b", 0);
  noteWarmPicture("b", "file:///b.jpg", "https://example.com/", viewport, size);
  noteSettledScroll("b", 400);
  assert.equal(warmPicture(tab("b"), viewport), null);
  noteWarmPicture("b", "file:///b.jpg", "https://example.com/", viewport, size);
  assert.notEqual(warmPicture(tab("b"), viewport), null);
  forgetWarmPictures(["b"]);
});

test("a first settled scroll after a capture with no scroll yet known makes it cold", () => {
  noteWarmPicture("c", "file:///c.jpg", "https://example.com/", viewport, size);
  noteSettledScroll("c", 0);
  assert.equal(warmPicture(tab("c"), viewport), null);
  forgetWarmPictures(["c"]);
});

test("a new document, a rotated or resized window, or a different picture on the tab makes it cold", () => {
  noteWarmPicture("d", "file:///d.jpg", "https://example.com/", viewport, size);
  assert.equal(warmPicture(tab("d", "https://example.com/next"), viewport), null);
  assert.equal(warmPicture(tab("d"), { width: viewport.height, height: viewport.width }), null);
  assert.equal(warmPicture(tab("d", "https://example.com/", "file:///other.jpg"), viewport), null);
  assert.notEqual(warmPicture(tab("d"), viewport), null);
  forgetWarmPictures(["d"]);
});

test("a closed tab forgets its picture key", () => {
  noteWarmPicture("e", "file:///e.jpg", "https://example.com/", viewport, size);
  forgetWarmPictures(["e"]);
  assert.equal(warmPicture(tab("e"), viewport), null);
});
