import { cleanUrlReport } from "@ardia/core";
import { copyAddress } from "../../platform/clipboard";
import { onWebKitCopyAddress } from "../../platform/webkit";
import type { ConsentToken } from "../telemetry/consentPeriod";
import { nativeConsent } from "../telemetry/nativeConsent";
import { noteWebKitMenuLinkCopied } from "../telemetry/urlCopies";

export function copyLinkFromPageMenu(address: unknown, changeCount: unknown, consent: ConsentToken | null) {
  if (typeof address !== "string" || !address) return;
  const { url, removedTracker } = cleanUrlReport(address);
  copyAddress(url, typeof changeCount === "number" && Number.isInteger(changeCount) ? changeCount : null);
  noteWebKitMenuLinkCopied(removedTracker, consent);
}

export const startPageLinkCopies = () => onWebKitCopyAddress((copy) => copyLinkFromPageMenu(copy.url, copy.changeCount, nativeConsent(copy)));
