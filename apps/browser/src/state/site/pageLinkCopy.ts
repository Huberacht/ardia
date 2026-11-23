import { cleanUrlReport } from "@ardia/core";
import { copyLink } from "../../platform/clipboard";
import { noteLinkCopiedFrom } from "../telemetry/urlCopies";

export function copyLinkFromPageMenu(address: unknown) {
  if (typeof address !== "string" || !address) return;
  const { url, removedTracker } = cleanUrlReport(address);
  copyLink(url);
  noteLinkCopiedFrom("webKitMenu", removedTracker);
}
