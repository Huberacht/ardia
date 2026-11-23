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
  o: { current: boolean; activeId: string; dragging: boolean; pressHeld: boolean; overflows: boolean; measuring: boolean; userScrollAt: number; now: number },
): { state: FirstReveal; reveal: boolean } {
  if (!o.current || !o.activeId || o.dragging || o.pressHeld || !o.overflows) return { state, reveal: false };
  if (!state.shown) return { state: { shown: true, at: o.now, settling: o.measuring }, reveal: true };
  if (!state.settling) return { state, reveal: false };
  if (o.userScrollAt > state.at) return { state: { ...state, settling: false }, reveal: false };
  return { state: { ...state, settling: o.measuring }, reveal: true };
}

export function endSettling(state: FirstReveal): FirstReveal {
  return state.settling ? { ...state, settling: false } : state;
}

export type OwnScroll = { from: number; to: number; until: number };

export const NO_OWN_SCROLL: OwnScroll = { from: NaN, to: NaN, until: -Infinity };

export function ownScroll(from: number, x: number, animated: boolean, until: number): OwnScroll {
  const to = Math.max(0, x);
  return { from: animated ? from : to, to, until };
}

export function isOwnScroll(own: OwnScroll, x: number, previous: number, max: number, now: number): boolean {
  const end = Math.max(0, max);
  if (previous > end + 0.5 && Math.abs(x - end) < 1) return true;
  const to = Math.min(own.to, end);
  if (Math.abs(x - to) < 1) return true;
  if (now > own.until) return false;
  return x >= Math.min(own.from, to) - 1 && x <= Math.max(own.from, to) + 1;
}

export type PendingReveal = { tabId: string; scrolls: number };

export function revealStillWanted(pending: PendingReveal, now: { tabId: string; scrolls: number; current: boolean; dragging: boolean }): boolean {
  return now.current && !now.dragging && now.tabId === pending.tabId && now.scrolls === pending.scrolls;
}
