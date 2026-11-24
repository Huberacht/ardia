type Viewport = { width: number; height: number };
type WarmKey = { uri: string; url: string; viewport: Viewport; size: Viewport; scrollY: number | null; stale: boolean };
export type WarmPicture = { uri: string; size: Viewport };

const keys = new Map<string, WarmKey>();
const settledScroll = new Map<string, number>();

export function noteSettledScroll(id: string, y: number) {
  const was = settledScroll.get(id);
  settledScroll.set(id, y);
  const key = keys.get(id);
  if (key && was !== undefined && Math.abs(was - y) >= 1) key.stale = true;
}

export function noteWarmPicture(id: string, uri: string, url: string, viewport: Viewport, size: Viewport) {
  keys.set(id, { uri, url, viewport: { ...viewport }, size: { ...size }, scrollY: settledScroll.get(id) ?? null, stale: false });
}

export function warmPicture(tab: { id: string; url: string; snapshotFileName: string | null }, viewport: Viewport): WarmPicture | null {
  const key = keys.get(tab.id);
  if (!key || key.stale || key.uri !== tab.snapshotFileName || key.url !== tab.url) return null;
  if (key.viewport.width !== viewport.width || key.viewport.height !== viewport.height) return null;
  if ((settledScroll.get(tab.id) ?? null) !== key.scrollY) return null;
  if (key.size.width <= 0 || key.size.height <= 0) return null;
  return { uri: key.uri, size: key.size };
}

export function forgetWarmPictures(ids: readonly string[]) {
  for (const id of ids) {
    keys.delete(id);
    settledScroll.delete(id);
  }
}
