import { create } from "zustand";
import { newUuid } from "../../lib/ids";
import { deletePageSnapshots, endPages, endPrivateSession, savePageState } from "../pages/store";
import { currentPreferences, setPreference } from "../settings/store";
import {
  countArchivedTabs,
  deleteArchivedTabs,
  expiredArchivedIds,
  knownReceivedKeys,
  readArchivedTab,
  readArchivedTabs,
  readOpenTabs,
  readTabState,
  searchArchivedTabs,
  writeTabState,
  writeTabs,
} from "../store/browserDatabase";
import { tabDatabase } from "../store/database";
import type { SqlDatabase } from "../../lib/sqlDatabase";
import { forgetPictures, forTheDatabase } from "./pictures";
import { privatePagesRefused, refuseIncognito } from "./privatePages";
import { receiveTabs, type IncomingTab } from "./received";
import type { AutoArchiveInterval, BrowserTab, TabPatch } from "./tabModels";
import { countUsage } from "../telemetry/telemetry";
import { labTrace } from "../../platform/lab";
import {
  archiveTabs,
  clearArchive,
  closeAllPrivateTabs,
  closeAllTabs,
  closeTab,
  deleteArchived,
  emptyTabs,
  findTab,
  launchTabs,
  moveToSpace,
  openTab,
  reopenLastClosed,
  restoreArchived,
  runAutoArchive,
  selectTab,
  updateTab,
  withArchive,
  withSpaces,
  type OpenRequest,
  type TabsChange,
  type TabsData,
} from "./tabsState";
import type { TabSpaces } from "./spaces";

export type TabsStore = TabsData & { incognito: boolean; listing: number };

export const useTabs = create<TabsStore>()(() => ({ ...emptyTabs(), incognito: false, listing: 0 }));

export const ARCHIVE_LIMIT = 2000;
export const ARCHIVE_SEARCH_LIMIT = 200;
export const ARCHIVE_RETENTION_MS = 90 * 24 * 3_600_000;

const now = () => Date.now();

const data = (): TabsData => useTabs.getState();

const privateStates = new Map<string, string>();

let tabProfile: string | null = null;

export const setTabProfile = (profileSyncId: string | null) => {
  tabProfile = profileSyncId;
};

type PendingWrites = { put: Map<string, BrowserTab>; remove: Set<string> };

const pendingWrites = new Map<SqlDatabase, PendingWrites>();
let flushQueued = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let failedFlushes = 0;

const RETRY_FIRST_MS = 100;
const RETRY_LONGEST_MS = 2_000;

function stageWrites(db: SqlDatabase, put: readonly BrowserTab[], remove: readonly string[]) {
  const batch = pendingWrites.get(db) ?? { put: new Map<string, BrowserTab>(), remove: new Set<string>() };
  for (const id of remove) {
    batch.put.delete(id);
    batch.remove.add(id);
  }
  for (const tab of put) {
    if (tab.isPrivate) continue;
    batch.remove.delete(tab.id);
    batch.put.set(tab.id, tab);
  }
  if (batch.put.size || batch.remove.size) pendingWrites.set(db, batch);
}

function retryFlushLater() {
  if (retryTimer) return;
  const wait = Math.min(RETRY_FIRST_MS * 2 ** failedFlushes, RETRY_LONGEST_MS);
  failedFlushes += 1;
  labTrace(`PAGELAB tab writes failed ${failedFlushes} times, kept and retried in ${wait} ms`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flushTabWrites();
  }, wait);
}

export function flushTabWrites(): boolean {
  let flushed = true;
  for (const [db, batch] of [...pendingWrites]) {
    try {
      writeTabs(db, [...batch.put.values()].map(forTheDatabase), [...batch.remove]);
      if (pendingWrites.get(db) === batch) pendingWrites.delete(db);
    } catch {
      flushed = false;
    }
  }
  if (flushed) failedFlushes = 0;
  else retryFlushLater();
  return flushed;
}

export const tabWritesPending = () => pendingWrites.size > 0;

const nextFrame = (run: () => void) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : setTimeout(run, 0));

function flushAfterFrame() {
  if (flushQueued || !pendingWrites.size) return;
  flushQueued = true;
  nextFrame(() =>
    setTimeout(() => {
      flushQueued = false;
      flushTabWrites();
    }, 0),
  );
}

type WriteTiming = "now" | "afterFrame";

const METADATA_ONLY: ReadonlySet<keyof TabPatch> = new Set<keyof TabPatch>(["title", "faviconUrl", "themeColorHex", "snapshotFileName"]);

const patchTiming = (patch: TabPatch): WriteTiming => ((Object.keys(patch) as (keyof TabPatch)[]).every((key) => patch[key] === undefined || METADATA_ONLY.has(key)) ? "afterFrame" : "now");

function apply(change: TabsChange, timing: WriteTiming = "now") {
  const db = tabDatabase();
  const hadPrivate = useTabs.getState().privates.length > 0;
  const listed = change.put.some((t) => !t.isPrivate) || change.remove.length > 0;
  useTabs.setState((s) => ({ ...change.data, listing: listed ? s.listing + 1 : s.listing }));
  forgetPictures(change.remove);
  stageWrites(db, change.put, change.remove);
  if (timing === "afterFrame" && change.remove.length === 0 && !change.clearArchived) flushAfterFrame();
  else flushTabWrites();
  const cleared = change.clearArchived ? deleteArchivedTabs(db) : [];
  const archived = new Set(change.put.filter((t) => t.archivedAt !== null && !t.isPrivate).map((t) => t.id));
  endPages(change.endedPages.filter((id) => !archived.has(id)));
  for (const id of change.endedPages) if (archived.has(id)) void saveAndEnd(id);
  deletePageSnapshots([...change.remove, ...cleared]);
  for (const id of change.endedPages) privateStates.delete(id);
  if (hadPrivate && change.data.privates.length === 0) {
    endPrivateSession();
    useTabs.setState({ incognito: false });
  }
}

async function saveAndEnd(id: string) {
  const saved = await savePageState(id);
  if (saved) writeTabState(tabDatabase(), id, saved);
  const { open, privates } = data();
  if (!open.some((t) => t.id === id) && !privates.some((t) => t.id === id)) endPages([id]);
}

export function tabSavedState(id: string): string | null {
  return privateStates.get(id) ?? (data().privates.some((t) => t.id === id) ? null : readTabState(tabDatabase(), id));
}

export function saveTabState(id: string, saved: string | null) {
  if (data().privates.some((t) => t.id === id)) {
    if (saved) privateStates.set(id, saved);
    else privateStates.delete(id);
    return;
  }
  if (data().open.some((t) => t.id === id)) writeTabState(tabDatabase(), id, saved);
}

export function pruneExpiredArchive() {
  const db = tabDatabase();
  const expired = expiredArchivedIds(db, now() - ARCHIVE_RETENTION_MS, ARCHIVE_LIMIT);
  if (expired.length) writeTabs(db, [], expired);
  return expired.length;
}

export function loadTabs() {
  flushTabWrites();
  const db = tabDatabase();
  pruneExpiredArchive();
  useTabs.setState({ ...withSpaces(launchTabs(readOpenTabs(db), countArchivedTabs(db)), data().spaces), incognito: false, listing: 0 });
}

let tabsOpenedThisRun = 0;

export function openNewTab(request: Omit<OpenRequest, "isPrivate"> & { isPrivate?: boolean }): BrowserTab {
  const { change, tab } = openTab(
    data(),
    { ...request, isPrivate: request.isPrivate ?? useTabs.getState().incognito, profileSyncId: request.profileSyncId ?? tabProfile },
    now(),
    newUuid(),
  );
  apply(change);
  if (!tab.isPrivate && !request.received) countUsage("tabs_opened");
  labTrace(`PAGELAB tab opened #${++tabsOpenedThisRun} origin ${request.origin}${tab.isPrivate ? " private" : ""}${request.received ? " received" : ""} id ${tab.id} open ${useTabs.getState().open.length}`);
  return tab;
}

export function applyTabSpaces(spaces: TabSpaces) {
  const next = withSpaces(data(), spaces);
  if (next !== data()) useTabs.setState(next);
}

export function moveTabToSpace(id: string, space: string) {
  const tab = findTab(data(), id);
  if (!tab || tab.isPrivate) return;
  const change = moveToSpace(data(), id, space);
  if (!change.put.length) return;
  apply(change);
  countUsage("tabs_moved_to_space");
}

export const selectTabById = (id: string | null) => apply(selectTab(data(), id, now()), "afterFrame");

export const closeTabById = (id: string) => apply(closeTab(data(), id, now()));

export const closeEveryTab = () => {
  apply(closeAllTabs(data(), now()));
  useTabs.setState({ incognito: false });
};

export const closePrivateTabs = () => {
  apply(closeAllPrivateTabs(data()));
  useTabs.setState({ incognito: false });
};

export function reopenClosedTab(): BrowserTab | null {
  const { change, reopened } = reopenLastClosed(data(), now());
  apply(change);
  return reopened.find((t) => t.id === change.data.selectedId) ?? reopened[reopened.length - 1] ?? null;
}

export const updateTabById = (id: string, patch: TabPatch) => apply(updateTab(data(), id, patch), patchTiming(patch));

export function rewriteTab(id: string) {
  const tab = findTab(data(), id);
  if (!tab) return;
  stageWrites(tabDatabase(), [tab], []);
  flushAfterFrame();
}

export const archiveDueTabs = () => apply(runAutoArchive(data(), currentPreferences().autoArchiveInterval, now()));

export function setAutoArchiveInterval(interval: AutoArchiveInterval) {
  setPreference("autoArchiveInterval", interval);
  archiveDueTabs();
}

export function setIncognito(incognito: boolean): boolean {
  if (incognito && !useTabs.getState().incognito && privatePagesRefused()) {
    refuseIncognito();
    return false;
  }
  useTabs.setState({ incognito });
  return true;
}

export const archivedTabById = (id: string): BrowserTab | null => readArchivedTab(tabDatabase(), id);

const sameArchive = (before: readonly BrowserTab[] | null, after: readonly BrowserTab[] | null) => before !== null && after !== null && before.length === after.length && before.every((tab, index) => tab === after[index]);

export function loadArchive() {
  const current = data();
  const next = withArchive(current, readArchivedTabs(tabDatabase(), ARCHIVE_LIMIT));
  if (!sameArchive(current.archive, next.archive)) useTabs.setState(next);
}

const PREPARED_ARCHIVE_FRESH_MS = 2_000;
let archivePreparedAt = 0;

export function prepareArchive() {
  loadArchive();
  archivePreparedAt = now();
}

export function loadArchiveUnlessPrepared() {
  if (data().archive !== null && now() - archivePreparedAt < PREPARED_ARCHIVE_FRESH_MS) return;
  loadArchive();
}

export const archiveInMemory = () => data().archive !== null;

export function searchArchive(text: string): BrowserTab[] {
  const query = text.trim();
  const archive = data().archive;
  if (!query && archive) return archive;
  return query ? searchArchivedTabs(tabDatabase(), query, ARCHIVE_SEARCH_LIMIT) : readArchivedTabs(tabDatabase(), ARCHIVE_SEARCH_LIMIT);
}

export const restoreArchivedTab = (tab: BrowserTab) => apply(restoreArchived(data(), tab, now()));

export const deleteArchivedTabsById = (ids: readonly string[]) => apply(deleteArchived(data(), ids));

export const clearArchivedTabs = () => apply(clearArchive(data()));

export const archiveTabById = (id: string) => apply(archiveTabs(data(), [id], true, now()));

export function receiveSentTabs(incoming: readonly IncomingTab[]): BrowserTab[] {
  if (!incoming.length) return [];
  const known = knownReceivedKeys(tabDatabase(), incoming.map((tab) => tab.key));
  const { change, opened } = receiveTabs(data(), incoming, known, now(), newUuid);
  if (opened.length) apply(change);
  for (const tab of opened) labTrace(`PAGELAB tab opened #${++tabsOpenedThisRun} origin received-from-mac id ${tab.id} open ${useTabs.getState().open.length}`);
  return opened;
}

export const currentTabs = data;
