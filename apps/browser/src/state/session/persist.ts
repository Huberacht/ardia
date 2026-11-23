import { removeDownloadStaging, type Download } from "../../platform/downloads";
import { documentSaved, writeDocument } from "../../platform/documents";
import { SESSION_DOCUMENT } from "./sessionDocument";
import { cosmeticChange, doc, field, listed, type Doc } from "./documentJson";
import { useBrowser, type BrowserState, type HydrateData } from "../browser/store";
import { inPinnedContainer, isIncognitoProfile, snapshotTab, tabsShownIn } from "../browser/model";
import { earlyLaunchTabOn, launchTab, linkProfile } from "../tabs/launchTab";
import { launchBackdrop } from "../windows/launchBackdrop";
import { restoreLaunchLook, saveLaunchLook } from "../windows/launchLook";
import { parkWindowPins } from "../pins/parkedPins";
import { closedWindowEntry, MAX_CLOSED_WINDOWS } from "../pins/closedTabs";
import { isPeekTab } from "../peek/peek";
import type { ClosedWindow, Tab } from "../browser/types";
import { downloadSession, withoutRepeats } from "../downloads/downloadsSlice";
import { anyDownloadProgress, withLiveProgress } from "../downloads/progress";
import { noteDownloadHistoryWrite } from "../telemetry/downloadWork";
import { noteSessionBackup, noteSessionSetAside, noteSessionSetAsideFailure, noteSessionWrite, timeSessionSave } from "../telemetry/sessionWrites";
import { saveBeforeQuit } from "../app/quit";
import { landHeldPins, pinGuard, savedAfterPins } from "./pinGuard";
import { noteSavedTopAppsMerged } from "../telemetry/topAppsSharing";
import { unchanged, type Migrations, type SavedObject } from "../../lib/savedDocument";
import { findDocument, keepAsideGate, newestBackup, rollingBackups, type FoundDocument, type RestoredBackup, type WriteGate } from "./sessionSafety";
import { consentToken } from "../telemetry/consentPeriod";
import { isRegularWindow } from "../windows/small";
import { isString } from "../../lib/decode";
import { savedPage } from "./savedShapes";
import { rows, sessionFromSaved, SESSION_MIGRATIONS, SESSION_VERSION, type SavedSession } from "./savedSession";

export { parseSession, SESSION_MIGRATIONS, SESSION_VERSION } from "./savedSession";

const SAVE_DELAY_MS = 800;
const COSMETIC_SAVE_DELAY_MS = 10_000;
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
const DOWNLOADS_DOCUMENT = "downloads.json";
const DOWNLOADS_VERSION = 3;
const DOWNLOADS_MIGRATIONS: Migrations = { 0: unchanged, 1: unchanged, 2: downloadsWithStagingPathOnly };

const publicTab = (t: { profileId: string }) => !isIncognitoProfile(t.profileId);
const publicProfiles = <T,>(byProfile: Record<string, T>) => Object.fromEntries(Object.entries(byProfile).filter(([profileId]) => publicTab({ profileId })));

const persistedTab = (t: Tab) => ({ ...t, page: savedPage(t) });
const savedWindows = (s: Pick<BrowserState, "windows">) =>
  Object.values(s.windows).filter(isRegularWindow).map(({ chromeWindow: _c, kind: _k, ...w }) => ({ ...w, incognito: false }));
const savedWindowsWithTabsShown = (s: Pick<BrowserState, "windows" | "settings">) => savedWindows(s).map((w) => ({ ...w, sidebarOpen: tabsShownIn(s, w.id) }));
const savedWindowIds = (s: Pick<BrowserState, "windows">) => new Set(savedWindows(s).map((w) => w.id));
const savedFocus = (s: Pick<BrowserState, "windows" | "ui">) => {
  const kept = savedWindowIds(s);
  return s.ui.focusOrder.find((id) => kept.has(id)) ?? null;
};

const SESSION_FIELDS = {
  profiles: field(["profiles"], (s) => s.profiles),
  profileOrder: field(["profileOrder"], (s) => s.profileOrder),
  orphanedProfileData: field(["orphanedProfileData"], (s) => s.orphanedProfileData),
  settings: field(["settings"], (s) => s.settings),
  settingsMeta: field(["settingsMeta"], (s) => s.settingsMeta),
  windows: field(["windows", "settings"], savedWindowsWithTabsShown),
  windowOrder: field(["windows", "windowOrder"], (s) => {
    const kept = savedWindowIds(s);
    return s.windowOrder.filter((id) => kept.has(id));
  }),
  focusedWindowId: field(["windows", "ui"], savedFocus),
  lastProfileId: field(["ui"], (s) => s.ui.lastProfileId),
  launchTab: field(["windows", "tabs", "settings", "profiles", "ui"], (s) => (earlyLaunchTabOn() ? launchTab(s, savedFocus(s)) : null)),
  launchBackdrop: field(["windows", "profiles", "ui", "settings"], (s) => (earlyLaunchTabOn() ? launchBackdrop(s, savedFocus(s)) : null)),
  linkProfile: field(["windows", "profiles", "ui", "windowOrder", "settings"], (s) => (earlyLaunchTabOn() ? linkProfile(s) : null)),
  tabs: field(["windows", "tabs", "peeks"], (s) => {
    const kept = savedWindowIds(s);
    return listed(Object.values(s.tabs).filter((t) => kept.has(t.windowId) && !isPeekTab(s, t.id)), persistedTab);
  }),
  groups: field(["windows", "groups"], (s) => {
    const kept = savedWindowIds(s);
    return listed(Object.values(s.groups).filter((g) => kept.has(g.windowId)));
  }),
  splits: field(["windows", "splits"], (s) => {
    const kept = savedWindowIds(s);
    return listed(Object.values(s.splits).filter((v) => kept.has(v.windowId)));
  }),
  closedTabs: field(["closedTabs"], (s) => listed(s.closedTabs.filter((c) => publicTab(c.tab)))),
  closedWindows: field(["closedWindows", "settings"], (s) =>
    s.closedWindows.filter((c) => c.tabs.every(publicTab)).map((c) => ({ ...c, window: { ...c.window, sidebarOpen: !(c.window.autoHideTabs ?? s.settings.autoHideTabs) } })),
  ),
  parkedPins: field(["parkedPins"], (s) => publicProfiles(s.parkedPins)),
  pinChoices: field(["pinChoices"], (s) => publicProfiles(s.pinChoices)),
  pinSync: field(["pinSync"], (s) => publicProfiles(s.pinSync)),
  topAppsMerged: field(["topAppsMerged"], (s) => s.topAppsMerged),
  closedGroups: field(["closedGroups"], (s) => s.closedGroups.filter((c) => c.tabs.every(publicTab))),
  deletedGroups: field(["deletedGroups"], (s) => s.deletedGroups.filter((c) => c.tabs.every(publicTab))),
  cleanedTabs: field(["cleanedTabs"], (s) => s.cleanedTabs.filter((c) => publicTab(c.tab))),
};

const DOWNLOADS_FIELDS = {
  downloads: field(["downloads", "profiles"], (s) =>
    withLiveProgress(s.downloads.filter((d) => downloadSession(s, d) === null)).map((d) => (d.state === "downloading" ? { ...d, state: "failed" } : d)),
  ),
};

const DOCS: Doc[] = [doc(DOWNLOADS_DOCUMENT, DOWNLOADS_VERSION, DOWNLOADS_FIELDS), doc(SESSION_DOCUMENT, SESSION_VERSION, SESSION_FIELDS)];

function write(name: string, json: string): boolean {
  try {
    writeDocument(name, json);
    return true;
  } catch (error) {
    console.warn(`Couldn't save ${name}`, error);
    return false;
  }
}

let droppedPrivateDownloads = false;

function forgetStaging(id: string) {
  const s = useBrowser.getState();
  const download = s.downloads.find((d) => d.id === id);
  if (!download) return;
  const { staging: _, ...kept } = download;
  s.upsertDownload(kept);
}

function savedDownloads(saved: Pick<BrowserState, "profiles">, found: FoundDocument): Download[] {
  const raw = found.state === "usable" ? found.doc : null;
  const downloads = rows<Download>(raw?.downloads, (d) => isString(d.id) && isString(d.state));
  droppedPrivateDownloads = downloads.some((d) => downloadSession(saved, d) !== null);
  return withoutRepeats(downloads.filter((d) => downloadSession(saved, d) === null)).map((d, i) => {
    const id = `saved-${i}`;
    const { staging, ...kept } = d;
    if (!staging || d.state === "downloading") return { ...kept, id };
    void removeDownloadStaging(staging)
      .catch(() => false)
      .then((removed) => removed && forgetStaging(id));
    return { ...d, id };
  });
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

export type LaunchOverrides = { restoreSession?: boolean };

type LoadedSession = HydrateData & { windowsAgainstAutoHideTabs: number };
type LaunchRead = { data: LoadedSession | null; session: FoundDocument; downloads: FoundDocument; restored: RestoredBackup<SavedSession> | null };

function readLaunch({ restoreSession }: LaunchOverrides = {}): LaunchRead {
  const found = findDocument(SESSION_DOCUMENT, SESSION_VERSION, SESSION_MIGRATIONS);
  const downloadsFound = findDocument(DOWNLOADS_DOCUMENT, DOWNLOADS_VERSION, DOWNLOADS_MIGRATIONS);
  const restored = found.state === "unusable" ? newestBackup(sessionFromSaved, SESSION_VERSION, SESSION_MIGRATIONS) : null;
  const session = found.state === "usable" ? sessionFromSaved(found.doc) : restored?.value ?? null;
  if (!session) return { data: null, session: found, downloads: downloadsFound, restored };
  const downloads = savedDownloads({ profiles: session.profiles ?? {} }, downloadsFound);
  const restore = restoreSession ?? session.settings?.restoreSession !== false;
  const data = restore ? session : closedForLaunch(session);
  return { data: { ...data, downloads, windowsAgainstAutoHideTabs: restore ? session.windowsAgainstAutoHideTabs : 0 }, session: found, downloads: downloadsFound, restored };
}

export function loadSession(overrides: LaunchOverrides = {}): LoadedSession | null {
  return readLaunch(overrides).data;
}

let flush: () => void = () => {};
let unstaged: () => boolean = () => false;
let pinsLanding: () => Promise<void> | null = () => null;
let resume: () => void = () => {};
let stageDownloads: () => void = () => {};
let frozen = false;

export function flushPersistence({ final = false } = {}): boolean {
  const saving = !frozen;
  if (final && anyDownloadProgress()) stageDownloads();
  flush();
  if (final && !frozen) saveLaunchLook(useBrowser.getState());
  if (final) frozen = true;
  return saving;
}

export async function sessionSaved(): Promise<boolean> {
  if (!(await savedAfterPins(flushPersistence, unstaged, pinsLanding))) return false;
  try {
    await documentSaved(SESSION_DOCUMENT);
    return !frozen;
  } catch {
    return false;
  }
}

export function holdPersistence(): boolean {
  const saving = flushPersistence();
  frozen = true;
  return saving;
}

export function resumePersistence() {
  frozen = false;
  resume();
}

let restoredAtLaunch = false;
let realignedAtLaunch = 0;

export const sessionRestoredAtLaunch = () => restoredAtLaunch;
export const windowsRealignedToAutoHideTabsAtLaunch = () => realignedAtLaunch;

export function startPersistence(overrides: LaunchOverrides = {}) {
  const launch = readLaunch(overrides);
  const loaded = launch.data;
  const consent = consentToken();
  if (launch.session.state === "unusable") noteSessionSetAside(true, launch.session.reason, launch.restored?.ageDays ?? null, consent);
  if (launch.downloads.state === "unusable") noteSessionSetAside(false, launch.downloads.reason, null, consent);
  restoredAtLaunch = !!loaded?.windowOrder?.length;
  realignedAtLaunch = loaded?.windowsAgainstAutoHideTabs ?? 0;
  noteSavedTopAppsMerged(loaded?.topAppsMerged ?? "");
  useBrowser.getState().hydrate(loaded ?? {});
  restoreLaunchLook();

  const keepDroppedPins = pinGuard(useBrowser.getState(), (delay) => unstaged() && schedule(delay));
  const gates = new Map<string, WriteGate>();
  const backups = rollingBackups(noteSessionBackup);
  pinsLanding = () => gates.get(SESSION_DOCUMENT)?.landing() ?? keepDroppedPins.landing();
  saveBeforeQuit(() => landHeldPins(() => unstaged() && frozen, pinsLanding, () => ((frozen = false), save(), (frozen = true))));
  const lastSources = new Map<string, unknown[]>();
  const lastJson = new Map<string, string>();
  const dirty = new Set<Doc>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let due = 0;
  let cosmeticOnly = true;

  const schedule = (delay: number) => {
    const at = Date.now() + delay;
    if (timer !== undefined && due <= at) return;
    clearTimeout(timer);
    due = at;
    timer = setTimeout(save, delay);
  };

  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    if (frozen) return;
    const s = useBrowser.getState();
    const done = timeSessionSave();
    const held = new Set<string>();
    let againIn: number | null = null;
    const holdFor = (wait: number | null) => {
      if (wait !== null) againIn = againIn === null ? wait : Math.min(againIn, wait);
    };
    for (const doc of DOCS.filter((d) => dirty.has(d))) {
      if (doc.name === SESSION_DOCUMENT) done.sessionStarts();
      const gate = gates.get(doc.name)?.check();
      if (gate?.hold) {
        held.add(doc.name);
        holdFor(gate.againIn);
        continue;
      }
      const json = doc.json(s);
      const saved = lastJson.get(doc.name) === json;
      const pins = !saved && doc.name === SESSION_DOCUMENT ? keepDroppedPins(s) : null;
      if (pins?.hold) {
        held.add(doc.name);
        holdFor(pins.againIn);
        continue;
      }
      if (saved || write(doc.name, json)) {
        pins?.commit();
        if (!saved && doc.name === DOWNLOADS_DOCUMENT) noteDownloadHistoryWrite(json.length);
        if (!saved && doc.name === SESSION_DOCUMENT) {
          noteSessionWrite(json.length, cosmeticOnly);
          backups.afterSave(json);
        }
        lastJson.set(doc.name, json);
        dirty.delete(doc);
      }
    }
    done();
    if (!held.has(SESSION_DOCUMENT)) cosmeticOnly = true;
    if ([...dirty].some((d) => !held.has(d.name))) schedule(SAVE_DELAY_MS);
    if (againIn !== null) schedule(againIn);
  };
  flush = save;
  stageDownloads = () => dirty.add(DOCS.find((d) => d.name === DOWNLOADS_DOCUMENT)!);
  unstaged = () => [...dirty].some((d) => d.name === SESSION_DOCUMENT);

  const check = (s: BrowserState, initial = false) => {
    if (frozen) return;
    let urgent = false;
    for (const doc of DOCS) {
      const sources = doc.reads.map((key) => s[key]);
      const prev = lastSources.get(doc.name);
      if (prev && sources.every((v, i) => v === prev[i])) continue;
      lastSources.set(doc.name, sources);
      if (initial) continue;
      dirty.add(doc);
      if (!prev || !cosmeticChange(doc, prev, sources)) urgent = true;
    }
    if (urgent) cosmeticOnly = false;
    if (dirty.size) schedule(urgent || !cosmeticOnly ? SAVE_DELAY_MS : COSMETIC_SAVE_DELAY_MS);
  };
  for (const [name, found] of [[SESSION_DOCUMENT, launch.session], [DOWNLOADS_DOCUMENT, launch.downloads]] as const) {
    const session = name === SESSION_DOCUMENT;
    const gate = keepAsideGate(name, found, (delay) => schedule(delay), { unreadable: () => noteSessionSetAside(session, "unreadable", null, consent), failed: () => noteSessionSetAsideFailure(session, consent) });
    if (gate) gates.set(name, gate);
  }
  if (launch.session.state === "usable" && launch.session.from < SESSION_VERSION) backups.beforeMigration(launch.session.text);
  check(useBrowser.getState(), true);
  if (launch.session.state === "unusable") {
    dirty.add(DOCS.find((d) => d.name === SESSION_DOCUMENT)!);
    cosmeticOnly = false;
  }
  if (droppedPrivateDownloads) {
    droppedPrivateDownloads = false;
    dirty.add(DOCS.find((d) => d.name === DOWNLOADS_DOCUMENT)!);
    cosmeticOnly = false;
    schedule(SAVE_DELAY_MS);
  }
  if (realignedAtLaunch) {
    dirty.add(DOCS.find((d) => d.name === SESSION_DOCUMENT)!);
    cosmeticOnly = false;
    schedule(SAVE_DELAY_MS);
  }
  resume = () => {
    check(useBrowser.getState());
    save();
  };
  return useBrowser.subscribe((s) => check(s));
}
