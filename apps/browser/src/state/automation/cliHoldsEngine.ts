import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { setControlHeldTabs } from "../../platform/control";
import { onCliHoldsChanged, tabsHeldByCli } from "../tabs/cliHolds";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { noteChromeDiscardsKeptForCli } from "../telemetry/tabSleepCounts";

let watching = false;
let pushing: Promise<void> = Promise.resolve();

export function pushCliHoldsToEngine(consent: ConsentToken | null): Promise<void> {
  const tabIds = tabsHeldByCli();
  pushing = pushing.then(async () => {
    try {
      const { kept } = await setControlHeldTabs(tabIds);
      noteChromeDiscardsKeptForCli(kept, consent);
    } catch {}
  });
  return pushing;
}

function holdsChanged(): void {
  void pushCliHoldsToEngine(consentToken());
}

export function watchCliHoldsForEngine(): void {
  if (watching || !PLATFORM_FEATURES.vetoesChromeDiscardsForCli) return;
  watching = true;
  onCliHoldsChanged(holdsChanged);
}
