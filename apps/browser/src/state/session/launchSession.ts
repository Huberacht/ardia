import { removeDownloadStaging, type Download } from "../../platform/downloads";
import { SESSION_DOCUMENT } from "./sessionDocument";
import { useBrowser, type BrowserState, type HydrateData } from "../browser/store";
import { inPinnedContainer, snapshotTab } from "../browser/model";
import { parkWindowPins } from "../pins/parkedPins";
import { closedWindowEntry, MAX_CLOSED_WINDOWS } from "../pins/closedTabs";
import type { Tab } from "../browser/types";
import { downloadSession, withoutRepeats } from "../downloads/downloadsSlice";
import { noteSavedTopAppsMerged } from "../telemetry/topAppsSharing";
import { unchanged, type Migrations, type SavedObject } from "../../lib/savedDocument";
import { findDocument, sessionBackups, wholeDownloads, wholeSession, type FoundDocument, type RestoredBackup } from "./sessionSafety";
import { isString } from "../../lib/decode";
import { droppedRows, rows, sessionFromSaved, SESSION_MIGRATIONS, SESSION_VERSION, type SavedSession } from "./savedSession";

const downloadsWithStagingPathOnly = (doc: SavedObject): SavedObject => ({
  ...doc,
  downloads: Array.isArray(doc.downloads)
    ? doc.downloads.map((d: unknown) => {
        if (typeof d !== "object" || d === null) return d;
        const { stagingId: _id, destination: _to, ...kept } = d as SavedObject;
        return kept;
      })
    : doc.downloads,
});
export const DOWNLOADS_DOCUMENT = "downloads.json";
export const DOWNLOADS_VERSION = 3;
const DOWNLOADS_MIGRATIONS: Migrations = { 0: unchanged, 1: unchanged, 2: downloadsWithStagingPathOnly };

export type LaunchOverrides = { restoreSession?: boolean };
export type LoadedSession = HydrateData & { windowsAgainstAutoHideTabs: number };

type SavedDownloads = { list: Download[]; staged: { id: string; staging: NonNullable<Download["staging"]> }[]; droppedPrivate: boolean };
const NO_DOWNLOADS: SavedDownloads = { list: [], staged: [], droppedPrivate: false };

function forgetStaging(id: string) {
  const s = useBrowser.getState();
  const download = s.downloads.find((d) => d.id === id);
  if (!download) return;
  const { staging: _, ...kept } = download;
  s.upsertDownload(kept);
}

function savedDownloads(saved: Pick<BrowserState, "profiles">, found: FoundDocument): SavedDownloads {
  const raw = found.state === "usable" ? found.doc : null;
  const downloads = rows<Download>(raw?.downloads, (d) => isString(d.id) && isString(d.state) && (d.profile === undefined || d.profile === null || isString(d.profile)));
  const staged: SavedDownloads["staged"] = [];
  const list = withoutRepeats(downloads.filter((d) => downloadSession(saved, d) === null)).map((d, i) => {
    const id = `saved-${i}`;
    const { staging, ...kept } = d;
    if (!staging || d.state === "downloading") return { ...kept, id };
    staged.push({ id, staging });
    return { ...d, id };
  });
  return { list, staged, droppedPrivate: downloads.some((d) => downloadSession(saved, d) !== null) };
}

function cleanStaging(downloads: SavedDownloads) {
  for (const { id, staging } of downloads.staged) {
    void removeDownloadStaging(staging)
      .catch(() => false)
      .then((removed) => removed && forgetStaging(id));
  }
}

function closedForLaunch(session: SavedSession): HydrateData {
  const now = Date.now();
  const pinSource = { tabs: session.tabs, groups: session.groups ?? {}, splits: session.splits ?? {}, history: {}, profiles: session.profiles ?? {} };
  let parkedPins = session.parkedPins ?? {};
  for (const w of Object.values(session.windows)) parkedPins = parkWindowPins(parkedPins, w, pinSource);
  const closedWindows = [
    ...(session.closedWindows ?? []).filter((c) => c.tabs.length).map(({ lastWindow: _, activePin: __, ...c }) => c),
    ...Object.values(session.windows)
      .map((w) =>
        closedWindowEntry(
          w,
          w.tabIds
            .map((id) => session.tabs[id])
            .filter((t): t is Tab => !!t && !inPinnedContainer(pinSource, t.id))
            .map((t) => ({ ...snapshotTab(t), active: Object.values(w.activeTabIds).includes(t.id) })),
          [],
          now,
        ),
      )
      .filter((c) => c.tabs.some((t) => t.url)),
  ].slice(-MAX_CLOSED_WINDOWS);
  return { ...session, parkedPins, closedWindows, windows: {}, windowOrder: [], tabs: {} };
}

const findSession = () => findDocument(SESSION_DOCUMENT, SESSION_VERSION, SESSION_MIGRATIONS, wholeSession);
const findDownloads = () => findDocument(DOWNLOADS_DOCUMENT, DOWNLOADS_VERSION, DOWNLOADS_MIGRATIONS, wholeDownloads);
const backupsOf = (found: FoundDocument) => (found.state === "unusable" || found.state === "unknown" ? sessionBackups(sessionFromSaved, SESSION_VERSION, SESSION_MIGRATIONS) : []);

function launchData(session: SavedSession, downloads: Download[], { restoreSession }: LaunchOverrides): LoadedSession {
  const restore = restoreSession ?? session.settings?.restoreSession !== false;
  const data = restore ? session : closedForLaunch(session);
  return { ...data, downloads, windowsAgainstAutoHideTabs: restore ? session.windowsAgainstAutoHideTabs : 0 };
}

export function loadSession(overrides: LaunchOverrides = {}): LoadedSession | null {
  const found = findSession();
  const session = found.state === "usable" ? sessionFromSaved(found.doc) : backupsOf(found)[0]?.value;
  if (!session) return null;
  const downloads = savedDownloads({ profiles: session.profiles ?? {} }, findDownloads());
  cleanStaging(downloads);
  return launchData(session, downloads.list, overrides);
}

export type Launch = { loaded: LoadedSession | null; session: FoundDocument; downloads: FoundDocument; restored: RestoredBackup<SavedSession> | null; droppedPrivateDownloads: boolean };

const textOf = (found: FoundDocument) => (found.state === "usable" || found.state === "unusable" ? found.text : null);

export function hydrateAtLaunch(overrides: LaunchOverrides): Launch {
  let session = findSession();
  let downloads = findDownloads();
  const downloadsFor = (saved: Pick<BrowserState, "profiles">) => {
    try {
      return savedDownloads(saved, downloads);
    } catch {
      downloads = { state: "unusable", reason: "shape", text: textOf(downloads) };
      return NO_DOWNLOADS;
    }
  };
  const attempt = (saved: SavedSession | (() => SavedSession)) => {
    try {
      const value = typeof saved === "function" ? saved() : saved;
      const list = downloadsFor({ profiles: value.profiles ?? {} });
      const data = launchData(value, list.list, overrides);
      noteSavedTopAppsMerged(data.topAppsMerged ?? "");
      useBrowser.getState().hydrate(data);
      cleanStaging(list);
      return { data, list };
    } catch (error) {
      console.warn("Couldn't restore a saved session", error);
      return null;
    }
  };
  let won: ReturnType<typeof attempt> = null;
  let restored: RestoredBackup<SavedSession> | null = null;
  if (session.state === "usable") {
    const usable = session;
    let partial = false;
    won = attempt(() => {
      const value = sessionFromSaved(usable.doc);
      partial = droppedRows(usable.doc, value);
      return value;
    });
    if (!won) session = { state: "unusable", reason: "shape", text: usable.text };
    else if (partial) session = { state: "unusable", reason: "rows", text: usable.text };
  }
  for (const backup of won ? [] : backupsOf(session)) {
    won = attempt(backup.value);
    if (!won) continue;
    restored = backup;
    break;
  }
  if (!won) {
    const list = downloadsFor({ profiles: {} });
    noteSavedTopAppsMerged("");
    try {
      useBrowser.getState().hydrate({ downloads: list.list });
      cleanStaging(list);
      won = { data: { downloads: list.list, windowsAgainstAutoHideTabs: 0 }, list };
    } catch {
      useBrowser.getState().hydrate({});
    }
    return { loaded: null, session, downloads, restored, droppedPrivateDownloads: !!won?.list.droppedPrivate };
  }
  return { loaded: won.data, session, downloads, restored, droppedPrivateDownloads: won.list.droppedPrivate };
}
