import assert from "node:assert/strict";
import { test } from "node:test";
const { shellNativeModules } = await import("../../test-native/index.ts");
const { copyLinkFromPageMenu } = await import("./pageLinkCopy.ts");
const { copyFieldSelection } = await import("../omnibox/paste.ts");
const { shareFromPage, shareTab } = await import("./share.ts");
const { takeUrlCopyCounts } = await import("../telemetry/urlCopies.ts");
const { consentToken, setConsentPeriod } = await import("../telemetry/consentPeriod.ts");

setConsentPeriod(true, "link-copies");

const copied = [];
const shared = [];
shellNativeModules.ArdiaShell.copyText = (text) => void copied.push(text);
shellNativeModules.ArdiaApp.share = (url, title) => void shared.push([url, title]);
shellNativeModules.ArdiaApp.shareVia = (service, url) => void shared.push([service, url]);
const tracked = "https://shop.example/item?id=7&utm_source=mail&fbclid=abc#reviews";
const clean = "https://shop.example/item?id=7#reviews";
const reset = () => {
  copied.length = 0;
  shared.length = 0;
  takeUrlCopyCounts();
};

test("Copy Link, Image or Media Address in a WebKit page copies the address without trackers", () => {
  reset();
  copyLinkFromPageMenu(tracked);
  copyLinkFromPageMenu("https://example.com/plain.png");
  copyLinkFromPageMenu("blob:https://example.com/1234?utm_source=x");
  assert.deepEqual(copied, [clean, "https://example.com/plain.png", "blob:https://example.com/1234?utm_source=x"]);
  const counts = takeUrlCopyCounts();
  assert.equal(counts.url_copies_from_webkit_menu, 3);
  assert.equal(counts.url_copies_cleaned, 1);
});

test("a WebKit menu copy with no address, or one that isn't text, copies nothing", () => {
  reset();
  for (const value of [undefined, null, "", 42, {}, ["https://a.example/?utm_source=x"]]) copyLinkFromPageMenu(value);
  assert.deepEqual(copied, []);
  assert.equal(takeUrlCopyCounts().url_copies_from_webkit_menu, 0);
});

test("copying the whole address from the address field copies it without trackers", () => {
  reset();
  const shown = "shop.example/item?id=7&utm_source=mail&fbclid=abc#reviews";
  copyFieldSelection(shown, 0, shown.length, tracked, consentToken());
  assert.deepEqual(copied, [clean]);
  const counts = takeUrlCopyCounts();
  assert.equal(counts.url_copies_from_address_field, 1);
  assert.equal(counts.url_copies_cleaned, 1);
});

test("copying part of the address field copies exactly what was selected", () => {
  reset();
  const shown = "shop.example/item?id=7&utm_source=mail";
  copyFieldSelection(shown, 18, shown.length, tracked, consentToken());
  copyFieldSelection(shown, 0, 12, tracked, consentToken());
  copyFieldSelection("typed?utm_source=x", 0, 18, null, consentToken());
  assert.deepEqual(copied, ["id=7&utm_source=mail", "shop.example", "typed?utm_source=x"]);
  assert.equal(takeUrlCopyCounts().url_copies_from_address_field, 0);
});

test("sharing a page, a link or a tab sends the address without trackers, and a shared image file as it is", async () => {
  reset();
  const tab = { url: tracked, title: "Item", customTitle: null, windowId: "w1" };
  await shareFromPage(tab, { kind: "page" });
  await shareFromPage(tab, { kind: "link", url: "https://news.example/a?gclid=1&page=2", title: "A" });
  await shareFromPage(tab, { kind: "image", url: "https://cdn.example/i.png?utm_medium=x", fileUrl: "file:///tmp/Ardia%20Shared%20Images/i.png?utm_source=x" });
  await shareTab(tab, "w1", "com.apple.share.Mail.compose");
  assert.deepEqual(shared, [
    [clean, "Item"],
    ["https://news.example/a?page=2", "A"],
    ["file:///tmp/Ardia%20Shared%20Images/i.png?utm_source=x", null],
    ["com.apple.share.Mail.compose", clean],
  ]);
});

test("a single cleaned address goes to the native URL writer when the build has one, so apps that read the URL flavour get it", () => {
  reset();
  const urls = [];
  shellNativeModules.ArdiaShell.copyURL = (address) => void urls.push(address);
  try {
    copyLinkFromPageMenu(tracked);
    const shown = "shop.example/item?id=7&utm_source=mail&fbclid=abc#reviews";
    copyFieldSelection(shown, 0, shown.length, tracked, consentToken());
    copyFieldSelection(shown, 0, 4, tracked, consentToken());
  } finally {
    delete shellNativeModules.ArdiaShell.copyURL;
  }
  assert.deepEqual(urls, [clean, clean]);
  assert.deepEqual(copied, ["shop"]);
});
