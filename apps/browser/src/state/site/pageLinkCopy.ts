import { cleanUrlReport } from "@ardia/core";
import { copyAddress } from "../../platform/clipboard";
import { noteLinkCopiedFrom } from "../telemetry/urlCopies";

export function copyLinkFromPageMenu(address: unknown) {
  if (typeof address !== "string" || !address) return;
  const { url, removedTracker } = cleanUrlReport(address);
  copyAddress(url);
  noteLinkCopiedFrom("webKitMenu", removedTracker);
}
