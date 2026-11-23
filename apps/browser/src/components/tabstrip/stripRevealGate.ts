export type SelectionReveal = "none" | "drop" | "wait" | "run";

export function selectionReveal(revealed: string, activeId: string, heldClose: boolean, current: boolean, dragging: boolean): SelectionReveal {
  if (revealed === activeId || heldClose) return "none";
  if (!activeId || dragging) return "drop";
  return current ? "run" : "wait";
}

export type FirstReveal = { shown: boolean; at: number; settling: boolean };

export const FIRST_REVEAL: FirstReveal = { shown: false, at: -Infinity, settling: false };

export function firstOverflowReveal(
  state: FirstReveal,
  o: { current: boolean; activeId: string; dragging: boolean; overflows: boolean; measuring: boolean; userScrollAt: number; now: number },
): { state: FirstReveal; reveal: boolean } {
  if (!o.current || !o.activeId || o.dragging || !o.overflows) return { state, reveal: false };
  if (!state.shown) return { state: { shown: true, at: o.now, settling: o.measuring }, reveal: true };
  if (!state.settling) return { state, reveal: false };
  if (o.userScrollAt > state.at) return { state: { ...state, settling: false }, reveal: false };
  return { state: { ...state, settling: o.measuring }, reveal: true };
}
