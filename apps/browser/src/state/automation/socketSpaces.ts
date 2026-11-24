import type { BrowserState } from "../browser/store";
import { activeTabId, isIncognitoProfile } from "../browser/model";
import type { TabGroup } from "../browser/types";
import { eligibleKind, isEligibleTab, lastFocusedEligibleWindow, shownPage } from "./automationWindows";
import type { MethodSpec } from "./socketCatalog";
import { id, int, obj } from "./socketSchema";
import { now, page, profileArg } from "./socketTargets";

export const MAX_GROUP_TABS = 500;

const SPACE = id("A space id from spaces.list (a profile id); every space when left out");

const spaceIds = (s: BrowserState) => s.profileOrder.filter((p) => s.profiles[p] && !isIncognitoProfile(p));

const shownWindows = (s: BrowserState) => s.windowOrder.filter((w) => eligibleKind(s, w) !== null);

const groupWindowOk = (s: BrowserState, g: TabGroup) => eligibleKind(s, g.windowId) !== null && !isIncognitoProfile(g.profileId);

function spaceRow(s: BrowserState, profileId: string, focusedProfile: string | null) {
  const profile = s.profiles[profileId]!;
  const tabs = Object.values(s.tabs).filter((t) => t.profileId === profileId && isEligibleTab(s, t.id));
  const groups = Object.values(s.groups).filter((g) => g.profileId === profileId && groupWindowOk(s, g));
  return {
    id: profileId,
    name: profile.name,
    profileId,
    color: profile.color,
    icon: profile.icon,
    active: focusedProfile === profileId,
    default: s.settings.defaultProfileId === profileId,
    windowIds: shownWindows(s).filter((w) => s.windows[w]!.profileId === profileId),
    tabCount: tabs.length,
    pinnedCount: tabs.filter((t) => t.pin !== null).length,
    groupCount: groups.length,
  };
}

function listSpaces() {
  const s = now();
  const focused = lastFocusedEligibleWindow(s);
  const focusedProfile = focused ? s.windows[focused]!.profileId : null;
  return { items: spaceIds(s).map((p) => spaceRow(s, p, focusedProfile)) };
}

function groupRow(s: BrowserState, g: TabGroup) {
  const members = g.tabIds.filter((t) => s.tabs[t]?.windowId === g.windowId && isEligibleTab(s, t));
  const active = activeTabId(s, g.windowId, g.profileId);
  const shown = members.slice(0, MAX_GROUP_TABS);
  return {
    id: g.id,
    title: g.name,
    color: g.color,
    icon: g.icon,
    spaceId: g.profileId,
    windowId: g.windowId,
    collapsed: g.collapsed,
    pinned: g.pinned,
    parentId: g.parentId ?? null,
    tabIds: shown,
    tabs: shown.map((t) => {
      const tab = s.tabs[t]!;
      const { url, title } = shownPage(tab);
      return { id: t, url, title, active: t === active };
    }),
    ...(members.length > shown.length ? { truncated: true, tabCount: members.length } : {}),
  };
}

function listGroups(params: Record<string, unknown>) {
  const s = now();
  const space = params.space !== undefined ? profileArg(params.space) : null;
  const windowRank = new Map(s.windowOrder.map((w, i) => [w, i]));
  const groups = Object.values(s.groups)
    .filter((g) => groupWindowOk(s, g) && (space === null || g.profileId === space))
    .sort((a, b) => (windowRank.get(a.windowId) ?? 0) - (windowRank.get(b.windowId) ?? 0) || a.createdAt - b.createdAt);
  return page(groups, params, (g) => groupRow(s, g));
}

export const SPACE_METHODS: MethodSpec[] = [
  {
    name: "spaces.list",
    mutates: false,
    description: "Spaces: each profile's tabs, with how many tabs, pinned tabs and groups it holds and whether the last focused window shows it",
    params: obj({}),
    result: "{items: [{id, name, profileId, color, icon, active, default, windowIds, tabCount, pinnedCount, groupCount}]}",
    run: listSpaces,
  },
  {
    name: "tabGroups.list",
    mutates: false,
    description: "Tab groups in regular windows, with their tabs in order (at most 500 per group); private windows are left out",
    params: obj({ space: SPACE, limit: int("At most this many groups (default 100)", 1, 1000), offset: int("Skip this many groups first (default 0)", 0) }),
    result: "{items: [{id, title, color, icon, spaceId, windowId, collapsed, pinned, parentId, tabIds, tabs: [{id, url, title, active}], truncated?}], total, nextOffset}",
    run: listGroups,
  },
];
