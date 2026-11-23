import { cleanUrl, cleanUrlReport, linkLines, markdownLink, type CleanedUrl, type LinkText } from "@ardia/core";
import { copyAddress, copyLink, copyText, copyUncleanedUrl } from "./clipboard";
import { sharePage, sharePageVia } from "./share";
import { copyFieldAs } from "./text";

const raw: string = "https://shop.example/item?id=7&utm_source=mail";

export function rawStringsAreRefusedAtLinkSinks() {
  // @ts-expect-error
  copyLink(raw);
  // @ts-expect-error
  copyAddress(raw);
  // @ts-expect-error
  copyAddress(markdownLink("Title", raw));
  // @ts-expect-error
  sharePage(raw, null, null, null);
  // @ts-expect-error
  sharePageVia("com.apple.share.Mail.compose", raw, null, null);
  // @ts-expect-error
  copyFieldAs(raw, raw);
  // @ts-expect-error
  const forged: CleanedUrl = raw;
  // @ts-expect-error
  const forgedText: LinkText = raw;
  // @ts-expect-error
  linkLines([raw], false);
  // @ts-expect-error
  sharePage(markdownLink("Title", raw), null, null, null);
  return [forged, forgedText];
}

export function cleanedUrlsReachLinkSinks() {
  copyLink(cleanUrl(raw));
  copyLink(cleanUrlReport(raw).url);
  copyLink(markdownLink("Title", raw));
  copyAddress(cleanUrl(raw));
  copyLink(linkLines([cleanUrl(raw), markdownLink("Title", raw)], true));
  void sharePage(cleanUrl(raw), "Title", null, null);
  void sharePageVia("com.apple.share.Mail.compose", cleanUrl(raw), null, null);
  void copyFieldAs("shop.example/item", cleanUrl(raw));
  void copyFieldAs(null, null);
  copyText("123456");
  copyUncleanedUrl(raw);
}
