import type { Download } from "../../platform/downloads";
import { engineProfile } from "../browser/model";
import { useBrowser, type BrowserState } from "../browser/store";

type Started = { tabId: string; url: string; profile: string; at: number };

export const LINK_WITHIN_MS = 10_000;
const MAX_RECENT_NAVIGATIONS = 32;

const recentNavigations: Started[] = [];
const owners = new Map<string, string>();

const running = (d: Pick<Download, "state">) => d.state === "downloading";
const profileOf = (d: Pick<Download, "profile">) => d.profile ?? "";
const startedAt = (d: Pick<Download, "startTime">, fallback: number) => d.startTime ?? fallback;

function claim(d: Download, now: number): boolean {
  const tabs = useBrowser.getState().tabs;
  for (let i = recentNavigations.length - 1; i >= 0; i--) if (!tabs[recentNavigations[i]!.tabId]) recentNavigations.splice(i, 1);
  const near = recentNavigations.filter((p) => p.profile === profileOf(d) && Math.abs(startedAt(d, now) - p.at) <= LINK_WITHIN_MS);
  if (!near.length) return false;
  const nearest = (list: Started[]) => list.reduce((a, b) => (Math.abs(startedAt(d, now) - a.at) <= Math.abs(startedAt(d, now) - b.at) ? a : b));
  const sameUrl = near.filter((p) => p.url === d.url);
  const best = nearest(sameUrl.length ? sameUrl : near);
  owners.set(d.id, best.tabId);
  recentNavigations.splice(recentNavigations.indexOf(best), 1);
  return true;
}

export function noteNavigationDownload(tabId: string, url: string | null | undefined, profile: string, downloads: readonly Download[], now = Date.now()) {
  if (!url) return;
  for (let i = recentNavigations.length - 1; i >= 0; i--) if (now - recentNavigations[i]!.at > LINK_WITHIN_MS) recentNavigations.splice(i, 1);
  const mine: Started = { tabId, url, profile, at: now };
  recentNavigations.push(mine);
  if (recentNavigations.length > MAX_RECENT_NAVIGATIONS) recentNavigations.shift();
  const unowned = downloads.filter((d) => running(d) && !owners.has(d.id) && profileOf(d) === profile);
  const ordered = [...unowned.filter((d) => d.url === url), ...unowned.filter((d) => d.url !== url)];
  for (const d of ordered) {
    if (!recentNavigations.includes(mine)) break;
    claim(d, now);
  }
}

export function noteDownloadChanged(d: Download, now = Date.now()) {
  if (!running(d)) return void owners.delete(d.id);
  if (!owners.has(d.id)) claim(d, now);
}

export const noteDownloadRemoved = (id: string) => void owners.delete(id);

export function downloadingIn(s: Pick<BrowserState, "downloads">, tabId: string): boolean {
  for (const [id, owner] of owners) if (owner === tabId && s.downloads.some((d) => d.id === id && running(d))) return true;
  return false;
}

export function forgetTabDownloadsExcept(tabs: BrowserState["tabs"], downloads: readonly Pick<Download, "id">[] = []) {
  const listed = new Set(downloads.map((d) => d.id));
  for (const [id, owner] of owners) if (!tabs[owner] || !listed.has(id)) owners.delete(id);
  for (let i = recentNavigations.length - 1; i >= 0; i--) if (!tabs[recentNavigations[i]!.tabId]) recentNavigations.splice(i, 1);
}

export function clearTabDownloads() {
  recentNavigations.length = 0;
  owners.clear();
}

export function noteTabNavigationDownload(tabId: string, url: string | null | undefined) {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (tab) noteNavigationDownload(tabId, url, engineProfile(s, tab.profileId), s.downloads);
}
