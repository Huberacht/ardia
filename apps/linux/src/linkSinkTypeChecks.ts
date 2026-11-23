import { cleanUrl } from "@ardia/core";
import { mailtoLink, shareLink, shareLinkVia } from "./linkShare.ts";

const raw: string = "https://shop.example/item?id=7&utm_source=mail";

export function rawStringsAreRefusedAtLinuxShareSinks() {
  // @ts-expect-error
  void shareLink(raw, "Title", null);
  // @ts-expect-error
  void shareLinkVia("email", raw, "Title", null);
  // @ts-expect-error
  return mailtoLink(raw, "Title");
}

export function cleanedUrlsReachLinuxShareSinks() {
  void shareLink(cleanUrl(raw), "Title", null);
  void shareLinkVia("email", cleanUrl(raw), "Title", null);
  return mailtoLink(cleanUrl(raw), "Title");
}
