import type { BrowserState } from "../browser/store";

const MAX_PER_TAB = 8;
const started = new Map<string, string[]>();

export function noteNavigationDownload(tabId: string, url: string | null | undefined) {
  if (!url) return;
  const urls = (started.get(tabId) ?? []).filter((u) => u !== url);
  started.set(tabId, [...urls, url].slice(-MAX_PER_TAB));
}

export function downloadingIn(s: Pick<BrowserState, "downloads">, tabId: string): boolean {
  const urls = started.get(tabId);
  if (!urls) return false;
  return s.downloads.some((d) => d.state === "downloading" && urls.includes(d.url));
}

export function forgetTabDownloadsExcept(tabs: BrowserState["tabs"]) {
  for (const id of started.keys()) if (!tabs[id]) started.delete(id);
}

export const clearTabDownloads = () => started.clear();
