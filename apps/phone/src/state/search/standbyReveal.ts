import { useWindowDimensions } from "react-native";
import { makeMutable, runOnUI } from "react-native-reanimated";
import { useScreenLayout } from "../app/screenLayout";

export type StandbyPrepared = { generation: number; tabId: string; layout: string; incognito: boolean };

export type EarlyReveal = { generation: number; press: number };

export const NOT_PREPARED: StandbyPrepared = { generation: 0, tabId: "", layout: "", incognito: false };

export const NO_EARLY_REVEAL: EarlyReveal = { generation: 0, press: 0 };

const NOT_SHOWN = NO_EARLY_REVEAL;

export const standbyPrepared = makeMutable<StandbyPrepared>(NOT_PREPARED);
export const standbyShownEarly = makeMutable<EarlyReveal>(NOT_SHOWN);
const plusPresses = makeMutable(0);

let lastGeneration = 0;
let pressing: EarlyReveal = NOT_SHOWN;
let adopted = 0;
let closedEarly = 0;

export const nextStandbyGeneration = () => (lastGeneration += 1);

export function useStandbyLayout(): string {
  const { width, height, fontScale } = useWindowDimensions();
  const name = useScreenLayout((state) => state.layout.name);
  const hinge = useScreenLayout((state) => state.hinge);
  return `${name}|${hinge}|${Math.round(width)}x${Math.round(height)}|${fontScale}`;
}

export function revealStandbyOnPress(tabId: string, layout: string, incognito: boolean): EarlyReveal {
  "worklet";
  const prepared = standbyPrepared.value;
  if (prepared.generation === 0 || prepared.tabId !== tabId || prepared.layout !== layout || prepared.incognito !== incognito) return NOT_SHOWN;
  plusPresses.value += 1;
  const shown = { generation: prepared.generation, press: plusPresses.value };
  standbyShownEarly.value = shown;
  return shown;
}

export function shownForGeneration(generation: number, early: EarlyReveal, revealed: number): boolean {
  "worklet";
  return generation !== 0 && (revealed === generation || early.generation === generation);
}

function withdrawOnUI(press: number) {
  "worklet";
  const shown = standbyShownEarly.value;
  if (shown.generation === 0) return;
  if (press === 0 || shown.press === press) standbyShownEarly.value = NOT_SHOWN;
}

function withdrawGenerationOnUI(generation: number) {
  "worklet";
  if (standbyShownEarly.value.generation === generation) standbyShownEarly.value = NOT_SHOWN;
}

export function dropEarlyStandby(press = 0) {
  runOnUI(withdrawOnUI)(press);
}

export function prepareStandby(prepared: StandbyPrepared) {
  adopted = 0;
  closedEarly = 0;
  standbyPrepared.value = prepared;
  dropEarlyStandby();
}

export function unprepareStandby(generation: number) {
  runOnUI((gone: number) => {
    "worklet";
    if (standbyPrepared.value.generation === gone) standbyPrepared.value = NOT_PREPARED;
    withdrawGenerationOnUI(gone);
  })(generation);
}

export const pressedReveal = (): EarlyReveal => pressing;

export function adoptStandby(generation: number) {
  adopted = generation;
}

export const standbyAdopted = (generation: number) => generation !== 0 && adopted === generation;

export function closeEarlyReveal(generation: number) {
  closedEarly = generation;
  runOnUI(withdrawGenerationOnUI)(generation);
}

export function pressWithReveal(reveal: EarlyReveal, press: () => void) {
  if (reveal.generation !== 0 && closedEarly === reveal.generation) {
    closedEarly = 0;
    dropEarlyStandby(reveal.press);
    return;
  }
  pressing = reveal;
  try {
    press();
  } finally {
    pressing = NOT_SHOWN;
    if (reveal.press !== 0 && adopted !== reveal.generation) dropEarlyStandby(reveal.press);
  }
}

export const PRESS_RETENTION = { left: 20, top: 20, right: 20, bottom: 30 } as const;

export function withinPressRect(x: number, y: number, width: number, height: number): boolean {
  "worklet";
  return x >= -PRESS_RETENTION.left && y >= -PRESS_RETENTION.top && x <= width + PRESS_RETENTION.right && y <= height + PRESS_RETENTION.bottom;
}

export type PlusTouch = { live: boolean; pointers: number };

export const IDLE_PLUS_TOUCH: PlusTouch = { live: false, pointers: 0 };

export function plusTouchDown(touch: PlusTouch, pointers: number): PlusTouch {
  "worklet";
  return { live: touch.pointers === 0 ? true : touch.live, pointers };
}

export function plusTouchUp(touch: PlusTouch, pointers: number, x: number, y: number, size: number): { touch: PlusTouch; accepted: boolean } {
  "worklet";
  if (pointers > 0) return { touch: { live: touch.live, pointers }, accepted: false };
  return { touch: IDLE_PLUS_TOUCH, accepted: touch.live && withinPressRect(x, y, size, size) };
}

export const isTouchRelease = (event: unknown): boolean => {
  const native = (event as { nativeEvent?: { changedTouches?: unknown } } | null | undefined)?.nativeEvent;
  return Array.isArray(native?.changedTouches);
};
