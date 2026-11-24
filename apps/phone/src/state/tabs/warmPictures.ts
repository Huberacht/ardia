type Size = { width: number; height: number };
export type WarmFrame = { x: number; y: number; width: number; height: number };
export type WarmCapture = { uri: string; url: string; window: Size; frame: WarmFrame | null | undefined; settled: boolean | undefined };
type WarmKey = { uri: string; url: string; window: Size; frame: WarmFrame; stale: boolean };
export type WarmPicture = { uri: string; frame: WarmFrame };

const keys = new Map<string, WarmKey>();

export function noteWarmPicture(id: string, capture: WarmCapture) {
  if (!capture.settled || !capture.frame || capture.frame.width <= 0 || capture.frame.height <= 0) {
    keys.delete(id);
    return;
  }
  keys.set(id, { uri: capture.uri, url: capture.url, window: { ...capture.window }, frame: { ...capture.frame }, stale: false });
}

export function noteViewMoved(id: string) {
  const key = keys.get(id);
  if (key) key.stale = true;
}

export function warmPicture(tab: { id: string; url: string; snapshotFileName: string | null }, window: Size): WarmPicture | null {
  const key = keys.get(tab.id);
  if (!key || key.stale || key.uri !== tab.snapshotFileName || key.url !== tab.url) return null;
  if (key.window.width !== window.width || key.window.height !== window.height) return null;
  return { uri: key.uri, frame: key.frame };
}

export function forgetWarmPictures(ids: readonly string[]) {
  for (const id of ids) keys.delete(id);
}
