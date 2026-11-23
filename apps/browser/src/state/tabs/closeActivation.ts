import type { BrowserState } from "../browser/store";
import { tabLayoutOf } from "../browser/model";
import { parseEntry } from "../sidebar/entryKey";
import { groupEntries, keptEntries, sidebarEntries } from "../sidebar/entries";
import { splitRowPanes, splitTabIdsOf } from "../splits/splits";
import { noteCloseActivation } from "../telemetry/closeActivationCounts";
import type { ConsentToken } from "../telemetry/consentPeriod";
import { stripEntries, type StripMember } from "./stripEntries";

type Row = string[];

export type CloseContext = { consent: ConsentToken | null };

export type ActivationOptions = { close: CloseContext; shown: boolean; visibleFallback: boolean };

export const activatesTabAbove = (s: Pick<BrowserState, "settings">) => s.settings.afterClosingTab === "tabAbove";

function entryRows(s: BrowserState, windowId: string, profileId: string, entry: string): Row[] {
  const { kind, id } = parseEntry(entry);
  if (kind === "tab") return s.tabs[id] ? [[id]] : [];
  if (kind === "split") {
    const panes = splitRowPanes(s, s.splits[id]);
    return [panes.length ? panes : (splitTabIdsOf(s.splits[id]) ?? [])];
  }
  if (kind !== "group" || !s.groups[id]) return [];
  const shown = s.groups[id]!.collapsed ? keptEntries(s, windowId, profileId, id) : groupEntries(s, id);
  return shown.flatMap((e) => entryRows(s, windowId, profileId, e));
}

function sidebarSections(s: BrowserState, windowId: string, profileId: string): Row[][] {
  const { cells, pinned, list } = sidebarEntries(s, windowId, profileId);
  const rows = (entries: string[]) => entries.flatMap((e) => entryRows(s, windowId, profileId, e));
  return [cells.filter((cell) => s.tabs[cell]).map((id) => [id]), rows(pinned), rows(list)];
}

const memberHolds = (m: StripMember, tabId: string) => (m.kind === "tab" ? m.id === tabId : m.tabIds.includes(tabId));

function memberRows(m: StripMember, activeId: string): Row[] {
  if (m.kind === "tab") return [[m.id]];
  if (m.kind === "split") return [m.tabIds];
  return m.tabIds.includes(activeId) ? [[activeId]] : [];
}

function stripSections(s: BrowserState, windowId: string, profileId: string): Row[][] {
  const activeId = s.windows[windowId]?.activeTabIds[profileId] ?? "";
  const dock: Row[] = [];
  const rows: Row[] = [];
  for (const e of stripEntries(s, windowId, profileId)) {
    if (e.kind === "dock") dock.push(...e.ids.filter((id) => s.tabs[id]).map((id) => [id]));
    else if (e.kind === "group") rows.push(...e.members.filter((m) => !e.collapsed || memberHolds(m, activeId)).flatMap((m) => memberRows(m, activeId)));
    else rows.push(...memberRows(e, activeId));
  }
  return [dock, rows];
}

export function visibleSections(s: BrowserState, windowId: string, profileId: string): Row[][] {
  return tabLayoutOf(s, windowId) === "top" ? stripSections(s, windowId, profileId) : sidebarSections(s, windowId, profileId);
}

const latest = (s: BrowserState, ids: string[]) => ids.reduce<string | undefined>((best, id) => (!best || s.tabs[id]!.lastActiveAt > s.tabs[best]!.lastActiveAt ? id : best), undefined);

export function tabAbove(s: BrowserState, windowId: string, closedId: string, closing: ReadonlySet<string>, eligible: (id: string) => boolean, visibleFallback = false): string | undefined {
  const profileId = s.tabs[closedId]?.profileId;
  if (!profileId) return undefined;
  const sections = visibleSections(s, windowId, profileId);
  const survivors = (row: Row) => row.filter((id) => !closing.has(id) && s.tabs[id]?.profileId === profileId && eligible(id));
  const section = sections.find((rows) => rows.some((row) => row.includes(closedId)));
  const top = section?.findIndex((row) => row.some((id) => closing.has(id))) ?? -1;
  if (section && top >= 0) {
    for (let i = top - 1; i >= 0; i--) {
      const id = latest(s, survivors(section[i]!));
      if (id) return id;
    }
    for (let i = top; i < section.length; i++) {
      const id = latest(s, survivors(section[i]!));
      if (id) return id;
    }
  }
  return visibleFallback ? latest(s, sections.flat().flatMap(survivors)) : undefined;
}

export function closeActivation(s: BrowserState, windowId: string, closedId: string, closing: ReadonlySet<string>, eligible: (id: string) => boolean, { close, shown, visibleFallback }: ActivationOptions): string | undefined {
  if (!activatesTabAbove(s)) return undefined;
  const adjacent = tabAbove(s, windowId, closedId, closing, eligible);
  const picked = adjacent ?? (visibleFallback ? tabAbove(s, windowId, closedId, closing, eligible, true) : undefined);
  if (shown) noteCloseActivation(close.consent, adjacent ? "above" : "fallback");
  return picked;
}
