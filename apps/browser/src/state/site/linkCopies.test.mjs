import assert from "node:assert/strict";
import { test } from "node:test";
const { shellNativeModules } = await import("../../test-native/index.ts");
const { copyLinkFromPageMenu, startPageLinkCopies } = await import("./pageLinkCopy.ts");
const { emitEvent } = await import("../../test-native/ardiacore.ts");
const { copyFieldSelection } = await import("../omnibox/paste.ts");
const { shareFromPage, shareTab } = await import("./share.ts");
const { takeUrlCopyCounts } = await import("../telemetry/urlCopies.ts");
const { useBrowser } = await import("../browser/store.ts");
const { copyUrls } = await import("../sidebar/actions.ts");
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
  copyLinkFromPageMenu(tracked, null, consentToken());
  copyLinkFromPageMenu("https://example.com/plain.png", null, consentToken());
  copyLinkFromPageMenu("blob:https://example.com/1234?utm_source=x", null, consentToken());
  assert.deepEqual(copied, [clean, "https://example.com/plain.png", "blob:https://example.com/1234?utm_source=x"]);
  const counts = takeUrlCopyCounts();
  assert.equal(counts.url_copies_from_webkit_menu, 3);
  assert.equal(counts.url_copies_cleaned, 1);
});

test("a WebKit menu copy with no address, or one that isn't text, copies nothing", () => {
  reset();
  for (const value of [undefined, null, "", 42, {}, ["https://a.example/?utm_source=x"]]) copyLinkFromPageMenu(value, null, consentToken());
  assert.deepEqual(copied, []);
  assert.equal(takeUrlCopyCounts().url_copies_from_webkit_menu, 0);
});

test("the address field copies what it shows, trackers included, as Chrome and Safari do (owner decision)", () => {
  reset();
  const shown = "shop.example/item?id=7&utm_source=mail&fbclid=abc#reviews";
  copyFieldSelection(shown, 0, shown.length, tracked);
  copyFieldSelection(shown, 18, 38, tracked);
  copyFieldSelection(shown, 0, 12, tracked);
  copyFieldSelection("typed?utm_source=x", 0, 18, null);
  assert.deepEqual(copied, [tracked, "id=7&utm_source=mail", "shop.example", "typed?utm_source=x"]);
  const counts = takeUrlCopyCounts();
  assert.equal(counts.url_copies_cleaned, 0);
  assert.equal(counts.url_copies_uncleaned, 0);
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
    copyLinkFromPageMenu(tracked, null, consentToken());
    copyFieldSelection("shop.example/item?id=7&utm_source=mail&fbclid=abc#reviews", 0, 4, tracked);
  } finally {
    delete shellNativeModules.ArdiaShell.copyURL;
  }
  assert.deepEqual(urls, [clean]);
  assert.deepEqual(copied, ["shop"]);
});

test("copying an untitled tab as Markdown from the sidebar labels it with the clean address, not the one with trackers", () => {
  reset();
  const S = () => useBrowser.getState();
  S().hydrate({});
  const w = S().createWindow({ url: "https://example.com/item?utm_source=mail" });
  const first = S().windows[w].tabIds[0];
  const second = S().newTab(w, { url: "https://shop.example/a?id=7&fbclid=1" });
  copyUrls([first], true);
  copyUrls([first, second], true);
  assert.deepEqual(copied, [
    "[https://example.com/item](https://example.com/item)",
    "- [https://example.com/item](https://example.com/item)\n- [https://shop.example/a?id=7](https://shop.example/a?id=7)",
  ]);
  assert.equal(takeUrlCopyCounts().url_copies_cleaned, 3);
});

test("a WebKit page menu copy arrives as an app-wide event, so it lands even after its page view is gone, and carries the pasteboard count it was asked at", () => {
  reset();
  const urls = [];
  shellNativeModules.ArdiaShell.copyURL = (address, unlessChangedSince) => void urls.push([address, unlessChangedSince]);
  const stop = startPageLinkCopies();
  try {
    emitEvent("webKit.copyAddress", { url: tracked, changeCount: 41, epoch: "link-copies" });
    emitEvent("webKit.copyAddress", { url: "https://example.com/plain.png", epoch: "link-copies" });
    emitEvent("webKit.copyAddress", { url: tracked, changeCount: 1.5 });
    emitEvent("webKit.copyAddress", { url: "" });
  } finally {
    stop?.remove?.();
    delete shellNativeModules.ArdiaShell.copyURL;
  }
  assert.deepEqual(urls, [[clean, 41], ["https://example.com/plain.png", null], [clean, null]]);
  assert.equal(takeUrlCopyCounts().url_copies_from_webkit_menu, 2);
});
