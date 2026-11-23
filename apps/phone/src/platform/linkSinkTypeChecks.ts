import { cleanUrl } from "@ardia/core/src/cleanUrl.ts";
import { copyLink, copyText, shareLink, sharePageWithPrint } from "./system";

const raw: string = "https://shop.example/item?id=7&utm_source=mail";

export function rawStringsAreRefusedAtLinkSinks() {
  // @ts-expect-error
  void copyLink(raw);
  // @ts-expect-error
  void shareLink(raw, "Title");
  // @ts-expect-error
  void sharePageWithPrint("page", raw, "Title");
}

export function cleanedUrlsReachLinkSinks() {
  void copyLink(cleanUrl(raw));
  void shareLink(cleanUrl(raw), "Title");
  void sharePageWithPrint("page", cleanUrl(raw), "Title");
  void copyText("42");
}
