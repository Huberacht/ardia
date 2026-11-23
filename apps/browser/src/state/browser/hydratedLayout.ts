import type { BrowserWindow, Profile, SplitView, Tab, TabGroup } from "./types";
import { isIncognitoProfile } from "./model";
import { pinHome } from "../pins/pinHomes";
import { DEFAULT_PROFILE } from "../profiles/profiles";
import { sanitizeSplits } from "../splits/splits";
import { orderSections } from "../groups/groups";

export type LayoutInput = {
  profiles?: Record<string, Profile>;
  windows?: Record<string, BrowserWindow>;
  windowOrder?: string[];
  tabs?: Record<string, Tab>;
  groups?: Record<string, TabGroup>;
  splits?: Record<string, SplitView>;
};

export function hydratedLayout(data: LayoutInput) {
  const profiles = data.profiles && Object.keys(data.profiles).length ? data.profiles : { [DEFAULT_PROFILE.id]: DEFAULT_PROFILE };
  const rawWindows = data.windows ?? {};
  const profileOk = (p: string) => !!profiles[p] || isIncognitoProfile(p);
  const tabs: Record<string, Tab> = {};
  for (const t of Object.values(data.tabs ?? {})) {
    if (!rawWindows[t.windowId] || !profileOk(t.profileId)) continue;
    tabs[t.id] = { ...t, pinnedUrl: t.pinnedUrl ?? pinHome(t, !!t.pin) };
  }
  const windows: Record<string, BrowserWindow> = {};
  for (const w of Object.values(rawWindows)) {
    const tabIds = orderSections(w.tabIds.filter((id) => tabs[id]?.windowId === w.id), tabs, data.groups ?? {});
    if (!tabIds.length) continue;
    const activeTabIds = Object.fromEntries(Object.entries(w.activeTabIds).filter(([p, id]) => tabs[id]?.profileId === p));
    const profileId = tabIds.some((id) => tabs[id]!.profileId === w.profileId) ? w.profileId : tabs[tabIds[0]!]!.profileId;
    activeTabIds[profileId] ??= tabIds.find((id) => tabs[id]!.profileId === profileId)!;
    windows[w.id] = { ...w, tabIds, profileId, activeTabIds };
  }
  for (const t of Object.values(tabs)) if (!windows[t.windowId]) delete tabs[t.id];
  const windowOrder = [...(data.windowOrder ?? []).filter((id) => windows[id]), ...Object.keys(windows).filter((id) => !data.windowOrder?.includes(id))];
  const inWindow = (id: string, windowId: string) => tabs[id]?.windowId === windowId;
  const groups = Object.fromEntries(
    Object.values(data.groups ?? {})
      .map((g) => ({ ...g, tabIds: g.tabIds.filter((id) => inWindow(id, g.windowId)) }))
      .filter((g) => g.tabIds.length)
      .map((g) => [g.id, g]),
  );
  const splits = sanitizeSplits(data.splits ?? {}, tabs);
  return { profiles, windows, windowOrder, tabs, groups, splits };
}

export function layoutDrops(data: LayoutInput): boolean {
  const out = hydratedLayout(data);
  const count = (record: object | undefined) => Object.keys(record ?? {}).length;
  return count(out.tabs) < count(data.tabs) || count(out.windows) < count(data.windows) || count(out.groups) < count(data.groups) || count(out.splits) < count(data.splits);
}
