import assert from "node:assert/strict";
import { test } from "node:test";
import { addressFieldCopy } from "./addressCopy.ts";

const field = (value, extra = {}) => ({ value, rowUrl: null, pageUrl: "", untouched: false, scoped: false, ...extra });
const copied = (value, extra) => addressFieldCopy(field(value, extra))?.url ?? null;

test("a page row's address, shown with or without its scheme, copies as the row's clean full address", () => {
  const rowUrl = "https://setu.atlassian.net/wiki/spaces/ENG/pages/1/TDD?utm_source=slack";
  assert.equal(copied("setu.atlassian.net/wiki/spaces/ENG/pages/1/TDD?utm_source=slack", { rowUrl }), "https://setu.atlassian.net/wiki/spaces/ENG/pages/1/TDD");
  assert.equal(copied(rowUrl, { rowUrl }), "https://setu.atlassian.net/wiki/spaces/ENG/pages/1/TDD");
  assert.equal(copied("example.com", { rowUrl: "http://www.example.com/" }), "http://www.example.com/");
});

test("a typed address the omnibox would open, with www. or a trailing space, is copied clean when it carries trackers", () => {
  assert.equal(copied("www.example.com/item?utm_source=x"), "https://www.example.com/item");
  assert.equal(copied("www.example.com/item?utm_source=x "), "https://www.example.com/item");
  assert.equal(copied("https://e.example/a?id=7&fbclid=1"), "https://e.example/a?id=7");
  assert.deepEqual(addressFieldCopy(field("www.example.com/item?utm_source=x")), { url: "https://www.example.com/item", removedTracker: true });
});

test("typed text without trackers, a search, or a non-web address is copied exactly as typed", () => {
  assert.equal(copied("www.example.com/item"), null);
  assert.equal(copied("hello world"), null);
  assert.equal(copied("foo"), null);
  assert.equal(copied(""), null);
  assert.equal(copied("example.com/doc", { rowUrl: "https://example.com/docs" }), null);
});

test("the address ⌘L preselects counts as the page's address only while the field is untouched", () => {
  const pageUrl = "https://shop.example/item?id=7&utm_source=mail";
  assert.equal(copied("shop.example/item?id=7&utm_source=mail", { pageUrl, untouched: true }), "https://shop.example/item?id=7");
  assert.equal(copied(pageUrl, { pageUrl, untouched: true }), "https://shop.example/item?id=7");
  assert.equal(copied("shop.example/item", { pageUrl, untouched: true }), null);
});

test("in a scoped search the text is a query, so it is copied verbatim even when it is the page's address", () => {
  const pageUrl = "https://shop.example/item?id=7&utm_source=mail";
  for (const value of [pageUrl, "shop.example/item?id=7&utm_source=mail", "www.example.com/item?utm_source=x"]) {
    assert.equal(copied(value, { pageUrl, scoped: true }), null, value);
    assert.equal(copied(value, { pageUrl, rowUrl: pageUrl, scoped: true }), null, value);
  }
});
