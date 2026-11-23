import type { BrowserState } from "../browser/store";
import { activeTabId, isPinnedRow, tabLayoutOf } from "../browser/model";
import { parseEntry } from "../sidebar/entryKey";
import { groupEntries, keptEntries, sidebarEntries } from "../sidebar/entries";
import { pinnedSequence } from "../sidebar/pinnedOrder";
import { pinnedCollapsed, pinnedKept } from "../sidebar/pinnedFold";
import { liveFolderTabRows } from "../sidebar/liveRows";
import { live } from "../live/store";
import { splitRowPanes, splitTabIdsOf } from "../splits/splits";
import { folderIdOfCell, shownFolderTab } from "../pins/tileFolders";
import { noteCloseActivation } from "../telemetry/closeActivationCounts";
import { consentToken, type ConsentToken } from "../telemetry/consentPeriod";
import { stripEntries, type StripMember } from "./stripEntries";
import type { CloseOptions, ClosePickRules } from "./tabs";

export type VisibleSection = "topApps" | "pinned" | "regular";
export type VisibleRow = { ids: string[]; section: VisibleSection };

export const activatesTabAbove = (s: Pick<BrowserState, "settings">) => s.settings.afterClosingTab === "tabAbove";

function entryRows(s: BrowserState, windowId: string, profileId: string, entry: string): string[][] {
  const { kind, id } = parseEntry(entry);
  if (kind === "tab") return s.tabs[id] ? [[id]] : [];
  if (kind === "live") return liveFolderTabRows(s, live(), windowId, profileId, id);
  if (kind === "split") {
    const panes = splitRowPanes(s, s.splits[id]);
    return [panes.length ? panes : (splitTabIdsOf(s.splits[id]) ?? [])];
  }
  if (kind !== "group" || !s.groups[id]) return [];
  const shown = s.groups[id]!.collapsed ? keptEntries(s, windowId, profileId, id) : groupEntries(s, id);
  return shown.flatMap((e) => entryRows(s, windowId, profileId, e));
}

function sidebarRows(s: BrowserState, windowId: string, profileId: string): VisibleRow[] {
  const { cells, list } = sidebarEntries(s, windowId, profileId);
  const tile = (cell: string): string[] => {
    const folderId = folderIdOfCell(cell);
    if (!folderId) return s.tabs[cell] ? [cell] : [];
    return [shownFolderTab(s, windowId, profileId, folderId) ?? []].flat();
  };
  const sequence = pinnedSequence(s, live().folders, live().folderOrder, windowId, profileId);
  const shownPinned = pinnedCollapsed(s, profileId) ? [pinnedKept(s, windowId, profileId, sequence) ?? []].flat() : sequence;
  const rows = (entries: string[], section: VisibleSection) => entries.flatMap((e) => entryRows(s, windowId, profileId, e)).map((ids) => ({ ids, section }));
  return [...cells.map(tile).filter((ids) => ids.length).map((ids) => ({ ids, section: "topApps" as const })), ...rows(shownPinned, "pinned"), ...rows(list, "regular")];
}

const memberHolds = (m: StripMember, tabId: string) => (m.kind === "tab" ? m.id === tabId : m.tabIds.includes(tabId));

function memberRows(m: StripMember, activeId: string): string[][] {
  if (m.kind === "tab") return [[m.id]];
  if (m.kind === "split") return [m.tabIds];
  return m.tabIds.includes(activeId) ? [[activeId]] : [];
}

function stripRows(s: BrowserState, windowId: string, profileId: string): VisibleRow[] {
  const activeId = activeTabId(s, windowId, profileId) ?? "";
  const rows: VisibleRow[] = [];
  for (const e of stripEntries(s, windowId, profileId)) {
    if (e.kind === "dock") {
      for (const id of e.ids) if (s.tabs[id]) rows.push({ ids: [id], section: isPinnedRow(s.tabs[id]) ? "pinned" : "topApps" });
      continue;
    }
    const section: VisibleSection = e.kind === "group" && s.groups[e.id]?.pinned ? "pinned" : "regular";
    const members = e.kind === "group" ? e.members.filter((m) => !e.collapsed || memberHolds(m, activeId)) : [e];
    for (const m of members) for (const ids of memberRows(m, activeId)) rows.push({ ids, section });
  }
  return rows;
}

export function visibleRows(s: BrowserState, windowId: string, profileId: string): VisibleRow[] {
  return tabLayoutOf(s, windowId) === "top" ? stripRows(s, windowId, profileId) : sidebarRows(s, windowId, profileId);
}

const latest = (s: BrowserState, ids: string[]) => ids.reduce<string | undefined>((best, id) => (!best || s.tabs[id]!.lastActiveAt > s.tabs[best]!.lastActiveAt ? id : best), undefined);

export function tabAbove(s: BrowserState, rows: VisibleRow[], closedId: string, closing: ReadonlySet<string>, eligible: (id: string) => boolean): string | undefined {
  const section = rows.find((row) => row.ids.includes(closedId))?.section;
  if (!section) return undefined;
  const same = rows.filter((row) => row.section === section).map((row) => row.ids);
  const top = same.findIndex((ids) => ids.some((id) => closing.has(id)));
  const survivor = (ids: string[]) => latest(s, ids.filter((id) => !closing.has(id) && eligible(id)));
  for (let i = top - 1; i >= 0; i--) {
    const id = survivor(same[i]!);
    if (id) return id;
  }
  for (let i = Math.max(top, 0); i < same.length; i++) {
    const id = survivor(same[i]!);
    if (id) return id;
  }
  return undefined;
}

export function pickAfterClose(s: BrowserState, windowId: string, closedId: string, closing: ReadonlySet<string>, rules: ClosePickRules, consent: ConsentToken | null): string | undefined {
  const profileId = s.tabs[closedId]?.profileId;
  if (!activatesTabAbove(s) || !profileId) return undefined;
  const rows = visibleRows(s, windowId, profileId);
  const own = (id: string) => s.tabs[id]?.profileId === profileId;
  const adjacent = tabAbove(s, rows, closedId, closing, (id) => own(id) && rules.adjacent(id));
  const picked = adjacent ?? latest(s, rows.flatMap((row) => row.ids).filter((id) => !closing.has(id) && own(id) && rules.fallback(id)));
  if (rules.shown) noteCloseActivation(consent, adjacent ? "above" : "fallback");
  return picked;
}

export const asUser = (user: boolean, options: CloseOptions = {}): CloseOptions => (user ? byUser(options) : options);

export function byUser(options: CloseOptions = {}): CloseOptions {
  const consent = consentToken();
  return { ...options, userClose: { pick: (s, windowId, closedId, closing, rules) => pickAfterClose(s, windowId, closedId, closing, rules, consent) } };
}
