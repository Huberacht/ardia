import type { BrowserState } from "../browser/store";

type Windows = BrowserState["windows"];

const switches = new Map<string, number>();

export function countSwitches(prev: Windows, next: Windows, counts: Map<string, number> = switches) {
  if (prev === next) return;
  for (const [windowId, w] of Object.entries(next)) {
    const before = prev[windowId]?.activeTabIds;
    if (before === w.activeTabIds) continue;
    for (const [profileId, tabId] of Object.entries(w.activeTabIds)) {
      if (tabId && before?.[profileId] !== tabId) counts.set(tabId, (counts.get(tabId) ?? 0) + 1);
    }
  }
}

export const switchesOf = (tabId: string) => switches.get(tabId) ?? 0;

export function forgetSwitchesExcept(tabs: BrowserState["tabs"]) {
  for (const id of switches.keys()) if (!tabs[id]) switches.delete(id);
}

export const clearSwitches = () => switches.clear();
