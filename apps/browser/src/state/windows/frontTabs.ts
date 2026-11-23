import { useBrowser, type BrowserState } from "../browser/store";

type Fronts = Pick<BrowserState, "windows" | "tabs">;

export type FrontTabChange = { windowId: string; before: string | undefined; after: string | undefined };
export type FrontTabListener = (change: FrontTabChange, s: BrowserState) => void;

const frontOf = (s: Fronts, windowId: string) => {
  const w = s.windows[windowId];
  const id = w?.activeTabIds[w.profileId];
  return id && s.tabs[id]?.windowId === windowId ? id : undefined;
};

export function frontTabChanges(prev: Fronts, next: Fronts): FrontTabChange[] {
  if (prev.windows === next.windows) return [];
  const changes: FrontTabChange[] = [];
  for (const windowId of Object.keys(next.windows)) {
    const before = frontOf(prev, windowId);
    const after = frontOf(next, windowId);
    if (before !== after) changes.push({ windowId, before, after });
  }
  return changes;
}

const listeners = new Set<FrontTabListener>();
let stopWatching: (() => void) | null = null;

export function onFrontTabChanged(listener: FrontTabListener): () => void {
  listeners.add(listener);
  stopWatching ??= useBrowser.subscribeTo(["windows"], (s, prev) => {
    for (const change of frontTabChanges(prev, s)) for (const each of listeners) each(change, s);
  });
  return () => {
    listeners.delete(listener);
    if (listeners.size || !stopWatching) return;
    stopWatching();
    stopWatching = null;
  };
}
