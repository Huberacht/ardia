import { makeMutable } from "react-native-reanimated";

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
