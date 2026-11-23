import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { childProcessCpu, listTasks, type ChildProcessCpu } from "../../platform/performance";
import { everySlowly } from "../../platform/slowTimers";
import { webviews } from "../../platform/webviews";
import { showToast, useToasts } from "../app/toasts";
import { useBrowser, type BrowserState } from "../browser/store";
import { openManageExtensions } from "../extensions/actions";
import { noteBusyTab } from "../telemetry/busyTabCounts";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { focusedWindowOf } from "../windows/ui";
import { BUSY_TICK_MS, busyFor, HOT_CORES, keptActive, readHeat, siteToKeepActive, SUSTAINED_MS, sustainedBusy, type ProcessHeat } from "./busyProcesses";
import { inUse } from "./loadedTabBudget";
import { canSleep, sleepAsked } from "./manualSleep";
import { keepSiteActive } from "./memorySaver";
import { shownTabIds } from "./shownTabs";
import { useLifecycle } from "./sleepingTabs";

type Owner = { started: number; at: number; tabIds: string[]; extension: string | null };

const MINUTE = 60_000;
const OWNERS_FRESH_MS = 5 * MINUTE;
const QUIET_AFTER_WARNING_MS = 120 * MINUTE;
const WARNING_HOLD_MS = 20_000;
const TOAST_KEY = "busyTab";
const TITLE_CHARS = 28;

let heat = new Map<number, ProcessHeat>();
const owners = new Map<number, Owner>();
const seenAt = new Map<string, number>();
const quietUntil = new Map<string, number>();
const keptTabs = new Set<string>();
const keptExtensions = new Set<string>();
let ticking = false;
let hotCores = HOT_CORES;
let unsupported = false;

const hasHiddenLoadedTab = (s: BrowserState) => {
  for (const id of webviews.keys()) if (canSleep(s, id)) return true;
  return false;
};

const shortTitle = (title: string) => (title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1).trimEnd()}…` : title);

const quiet = (key: string, now: number) => (quietUntil.get(key) ?? 0) > now;

async function lookUpOwners(pids: number[], now: number, consent: ConsentToken | null) {
  const stale = pids.filter((pid) => {
    const known = owners.get(pid);
    return !known || known.started !== heat.get(pid)?.started || now - known.at >= OWNERS_FRESH_MS;
  });
  if (!stale.length) return;
  noteBusyTab("busy_tab_owner_lookups", consent);
  const tasks = await listTasks().catch(() => []);
  for (const pid of stale) {
    const mine = tasks.filter((t) => t.pid === pid);
    const extension = mine.find((t) => t.type === "extension")?.title.replace(/^[^:]*:\s*/, "") ?? null;
    const tabIds = [...new Set(mine.flatMap((t) => t.tabIds).filter((id): id is string => !!id))];
    owners.set(pid, { started: heat.get(pid)?.started ?? 0, at: now, tabIds, extension });
  }
}

function busyTabsOf(s: BrowserState, owner: Owner, now: number): string[] | null {
  const tabIds = owner.tabIds.filter((id) => s.tabs[id]);
  if (!tabIds.length) return null;
  const sites = s.settings.keepActiveSites;
  const unseen = (id: string) =>
    canSleep(s, id) && !inUse(s, id) && !keptTabs.has(id) && !keptActive(s.tabs[id]!.url, sites) && now - Math.max(s.tabs[id]!.lastActiveAt, seenAt.get(id) ?? 0) >= SUSTAINED_MS;
  return tabIds.every(unseen) && !tabIds.some((id) => quiet(id, now)) ? tabIds : null;
}

function warnAboutTabs(windowId: string, tabIds: string[], minutes: number, now: number, consent: ConsentToken | null) {
  const s = useBrowser.getState();
  const first = s.tabs[tabIds[0]!]!;
  const many = tabIds.length > 1;
  const site = siteToKeepActive(first.url);
  for (const id of tabIds) quietUntil.set(id, now + QUIET_AFTER_WARNING_MS);
  noteBusyTab("busy_tab_warnings", consent);
  const name = shortTitle(first.customTitle || first.title || site || "A background tab");
  showToast(windowId, many ? `${tabIds.length} tabs from ${site ?? "one site"} are using a lot of energy` : `“${name}” is using a lot of energy`, `Busy in the background for ${minutes} minutes.`, {
    icon: "bolt.fill",
    key: TOAST_KEY,
    holdMs: WARNING_HOLD_MS,
    action: {
      title: many ? "Sleep Tabs" : "Sleep Tab",
      run: () => {
        const asked = consentToken();
        void Promise.all(tabIds.map(sleepAsked)).then((results) => {
          const slept = results.some((r) => r.outcome === "asleep");
          noteBusyTab(slept ? "busy_tab_slept" : "busy_tab_stayed_awake", asked);
          if (!slept && results.some((r) => r.outcome === "kept")) showToast(windowId, many ? "These tabs stayed awake" : "This tab stayed awake", "It's playing, sharing or holding something you typed.", { icon: "bolt.fill" });
        });
      },
    },
    secondary: {
      title: "Keep Running",
      run: () => {
        noteBusyTab("busy_tab_kept_running");
        for (const id of tabIds) keptTabs.add(id);
        if (site) void keepSiteActive(site);
      },
    },
  });
}

function warnAboutExtension(windowId: string, extension: string, minutes: number, now: number, consent: ConsentToken | null) {
  quietUntil.set(`extension:${extension}`, now + QUIET_AFTER_WARNING_MS);
  noteBusyTab("busy_extension_warnings", consent);
  showToast(windowId, `“${shortTitle(extension)}” is using a lot of energy`, `This extension has been busy for ${minutes} minutes.`, {
    icon: "bolt.fill",
    key: TOAST_KEY,
    holdMs: WARNING_HOLD_MS,
    action: {
      title: "Manage",
      run: () => {
        noteBusyTab("busy_extension_managed");
        openManageExtensions(windowId);
      },
    },
    secondary: {
      title: "Ignore",
      run: () => {
        noteBusyTab("busy_extension_ignored");
        keptExtensions.add(extension);
      },
    },
  });
}

async function warnFor(pids: number[], now: number, consent: ConsentToken | null) {
  await lookUpOwners(pids, now, consent);
  const s = useBrowser.getState();
  const windowId = focusedWindowOf(s);
  if (!windowId || !s.windows[windowId] || useToasts.getState().toasts[windowId]) return;
  for (const pid of pids.sort((a, b) => busyFor(heat.get(b)!, now) - busyFor(heat.get(a)!, now))) {
    const owner = owners.get(pid);
    const h = heat.get(pid);
    if (!owner || !h) continue;
    const minutes = Math.max(2, Math.round(busyFor(h, now) / MINUTE));
    if (h.kind === "extension") {
      const extension = owner.extension;
      if (!extension || keptExtensions.has(extension) || quiet(`extension:${extension}`, now)) continue;
      return warnAboutExtension(windowId, extension, minutes, now, consent);
    }
    const tabIds = busyTabsOf(s, owner, now);
    if (tabIds) return warnAboutTabs(windowId, tabIds, minutes, now, consent);
  }
}

export async function watchBusyTabs(now = Date.now(), read: () => Promise<ChildProcessCpu[]> = childProcessCpu) {
  if (ticking || unsupported) return;
  ticking = true;
  try {
    const consent = consentToken();
    noteBusyTab("busy_tab_watch_ticks", consent);
    const s = useBrowser.getState();
    for (const id of shownTabIds(s)) seenAt.set(id, now);
    for (const id of seenAt.keys()) if (!s.tabs[id]) seenAt.delete(id);
    for (const [key, at] of quietUntil) if (at <= now) quietUntil.delete(key);
    for (const id of keptTabs) if (!s.tabs[id]) keptTabs.delete(id);
    let readings: ChildProcessCpu[];
    try {
      readings = await read();
    } catch {
      unsupported = true;
      return;
    }
    heat = readHeat(heat, readings, now, hotCores);
    for (const pid of owners.keys()) if (heat.get(pid)?.started !== owners.get(pid)!.started) owners.delete(pid);
    const busy = sustainedBusy(heat);
    if (busy.length) await warnFor(busy, now, consent);
  } finally {
    ticking = false;
  }
}

let started = false;

export function startBusyTabWatch() {
  if (started || !PLATFORM_FEATURES.busyTabWatch) return;
  started = true;
  everySlowly({
    every: BUSY_TICK_MS,
    run: () => void watchBusyTabs(),
    needed: () => !unsupported && hasHiddenLoadedTab(useBrowser.getState()),
    watch: (changed) => {
      const browser = useBrowser.subscribeTo(["tabs", "windows"], changed);
      const lifecycle = useLifecycle.subscribe(changed);
      return () => (browser(), lifecycle());
    },
  });
  if (__DEV__) (globalThis as { acBusyTabs?: unknown }).acBusyTabs = { watchBusyTabs, heat: () => heat, owners: () => owners, quietUntil, setHotCores: (cores: number) => void (hotCores = cores) };
}
