type Press = { windowId: string; kind: "open" | "close"; tabId: string | null; until: number };

const PRESS_MS = 1000;
let pending: Press[] = [];

const live = (now: number) => (pending = pending.filter((p) => p.until > now));

export function markStripPress(windowId: string, kind: Press["kind"], tabId: string | null = null, now = Date.now()) {
  live(now).push({ windowId, kind, tabId, until: now + PRESS_MS });
}

export function nameStripOpen(windowId: string, tabId: string | null | undefined) {
  const press = [...pending].reverse().find((p) => p.windowId === windowId && p.kind === "open" && p.tabId === null);
  if (press && tabId) press.tabId = tabId;
}

export function takeStripPress(windowId: string, closed: string[], opened: string[], now = Date.now()): boolean {
  const at = live(now).findIndex((p) => p.windowId === windowId && (p.kind === "close" ? p.tabId !== null && closed.includes(p.tabId) : p.tabId === null ? opened.length > 0 : opened.includes(p.tabId)));
  if (at < 0) return false;
  pending.splice(at, 1);
  return true;
}
