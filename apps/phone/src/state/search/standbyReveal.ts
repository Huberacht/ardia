import { makeMutable } from "react-native-reanimated";
import { searchState } from "./store";

export const STANDBY_ARMED = { none: 0, regular: 1, incognito: 2 } as const;

export const standbyArmed = makeMutable<number>(STANDBY_ARMED.none);
export const standbyShownEarly = makeMutable(0);

export function revealStandbyOnPress(incognito: boolean): boolean {
  "worklet";
  if (standbyArmed.value !== (incognito ? STANDBY_ARMED.incognito : STANDBY_ARMED.regular)) return false;
  standbyShownEarly.value = 1;
  return true;
}

export function dropEarlyStandby() {
  standbyShownEarly.value = 0;
}

export const PLUS_PRESS_MS = 350;
export const EARLY_STANDBY_HELD_MS = 300;

export function acceptsPlusPress(downAt: number, upAt: number, x: number, y: number, size: number): boolean {
  "worklet";
  return downAt >= 0 && upAt - downAt <= PLUS_PRESS_MS && x >= 0 && y >= 0 && x <= size && y <= size;
}

export function dropEarlyStandbyUnlessOpened() {
  setTimeout(() => {
    if (!searchState().open) dropEarlyStandby();
  }, EARLY_STANDBY_HELD_MS);
}
