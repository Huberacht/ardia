import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { setControlHeldTabs } from "../../platform/control";
import { cliHoldsLeft, onCliHoldsChanged } from "../tabs/cliHolds";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { noteChromeDiscardsKeptForCli } from "../telemetry/tabSleepCounts";

export const CLI_HOLD_REFRESH_MS = 10_000;

let watching = false;
let pushing: Promise<void> = Promise.resolve();
let countingSince: ConsentToken | null = null;
let refresh: ReturnType<typeof setInterval> | null = null;

export function pushCliHoldsToEngine(consent: ConsentToken | null): Promise<void> {
  const tabs = cliHoldsLeft();
  keepRefreshing(tabs.length > 0);
  pushing = pushing.then(async () => {
    const counted = countingSince;
    countingSince = consent;
    try {
      const { kept } = await setControlHeldTabs(tabs);
      noteChromeDiscardsKeptForCli(kept, counted);
    } catch {}
  });
  return pushing;
}

export const cliHoldsPushed = (): Promise<void> => pushing;

function keepRefreshing(on: boolean): void {
  if (on && refresh === null) refresh = setInterval(holdsChanged, CLI_HOLD_REFRESH_MS);
  if (!on && refresh !== null) {
    clearInterval(refresh);
    refresh = null;
  }
}

function holdsChanged(): void {
  void pushCliHoldsToEngine(consentToken());
}

export function watchCliHoldsForEngine(): void {
  if (watching || !PLATFORM_FEATURES.vetoesChromeDiscardsForCli) return;
  watching = true;
  onCliHoldsChanged(holdsChanged);
  holdsChanged();
}
