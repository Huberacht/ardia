import { useEffect, useState } from "react";
import { useBrowser } from "../browser/store";
import { watchShownLive } from "../browser/hooks";
import { consentToken } from "../telemetry/client";
import { notePageOverlay } from "../telemetry/usage";
import { shownLiveOf } from "./tabLive";

export const NEW_TAB_KEPT_MAX_MS = 1500;
export const NEW_TAB_DROP_AFTER_LOAD_MS = 100;

export function watchPageDrawn(tabId: string, drawn: (timedOut: boolean) => void, maxMs = NEW_TAB_KEPT_MAX_MS, afterLoadMs = NEW_TAB_DROP_AFTER_LOAD_MS): () => void {
  let sawLoading = shownLiveOf(useBrowser.getState(), tabId).isLoading;
  let afterLoad: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const finish = (timedOut: boolean) => {
    if (done) return;
    done = true;
    stop();
    clearTimeout(cap);
    clearTimeout(afterLoad);
    drawn(timedOut);
  };
  const stop = watchShownLive(tabId, () => {
    if (shownLiveOf(useBrowser.getState(), tabId).isLoading) {
      sawLoading = true;
      clearTimeout(afterLoad);
      afterLoad = undefined;
      return;
    }
    if (sawLoading && afterLoad === undefined) afterLoad = setTimeout(() => finish(false), afterLoadMs);
  });
  const cap = setTimeout(() => finish(true), maxMs);
  return () => {
    done = true;
    stop();
    clearTimeout(cap);
    clearTimeout(afterLoad);
  };
}

export function useNewTabKeptForPage(tabId: string, newTabShown: boolean, pageShown: boolean): boolean {
  const [shownBefore, setShownBefore] = useState(newTabShown);
  const [kept, setKept] = useState(false);
  if (shownBefore !== newTabShown) {
    setShownBefore(newTabShown);
    setKept(!newTabShown && pageShown);
  }
  useEffect(() => {
    if (!kept) return;
    const consent = consentToken();
    notePageOverlay("newTabKeptForPage", consent);
    return watchPageDrawn(tabId, (timedOut) => {
      if (timedOut) notePageOverlay("newTabKeptTimedOut", consent);
      setKept(false);
    });
  }, [kept, tabId]);
  return kept;
}
