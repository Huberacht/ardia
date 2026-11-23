import { useBrowser } from "../browser/store";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { DEFAULT_PROFILE_ID } from "../settings/settings";
import { profileOpened } from "../profiles/profileLoading";
import type { ConsentToken } from "../telemetry/choice";
import { notePrivateFaviconPeek } from "../telemetry/pageFaviconCounts";

export const cacheKey = (profileId: string) => (isIncognitoProfile(profileId) ? profileId : engineProfile(useBrowser.getState(), profileId));

export function lookupOrder(profileId?: string): string[] {
  if (profileId && !isIncognitoProfile(profileId)) return [profileId];
  return [...new Set([...(profileId ? [profileId] : []), DEFAULT_PROFILE_ID, ...useBrowser.getState().profileOrder])];
}

export const askable = (id: string) => !isIncognitoProfile(id) && profileOpened(cacheKey(id));

export const privateViewer = (profileId?: string | null) => (profileId && isIncognitoProfile(profileId) ? profileId : undefined);

const BORROWED = ">";
const borrowed = new Set<string>();
const closedViewers = new Set<string>();

export const isBorrowed = (key: string) => key.includes(BORROWED);
export const viewerOf = (key: string) => key.split(BORROWED)[0]!;
export const sourceEngineOf = (key: string) => cacheKey(key.slice(key.indexOf(BORROWED) + 1));
const borrows = (viewer: string | undefined, id: string): viewer is string => !!viewer && isIncognitoProfile(viewer) && id !== viewer;
const borrowedKey = (viewer: string, id: string) => `${viewer}${BORROWED}${id}`;

export const askKey = (viewer: string | undefined, id: string) => (borrows(viewer, id) ? borrowedKey(viewer, id) : cacheKey(id));
export const keysFor = (viewer: string | undefined, id: string) => (borrows(viewer, id) ? [cacheKey(id), borrowedKey(viewer, id)] : [cacheKey(id)]);

export function borrowFor(key: string): boolean {
  if (closedViewers.has(viewerOf(key))) return false;
  borrowed.add(key);
  return true;
}

export const stillBorrowed = (key: string) => borrowed.has(key);
export const borrowersOf = (engine: string) => [...borrowed].filter((key) => sourceEngineOf(key) === engine);
export const anyBorrowed = () => borrowed.size > 0;

export function closeViewers(open: Set<string>, before: Iterable<string>): string[] {
  for (const id of before) if (isIncognitoProfile(id) && !open.has(id)) closedViewers.add(id);
  const gone = [...borrowed].filter((key) => !open.has(viewerOf(key)));
  for (const key of gone) {
    borrowed.delete(key);
    closedViewers.add(viewerOf(key));
  }
  return gone;
}

const PEEK_RETRY_MS = [500, 2000, 8000];
const peekRetries = new Map<string, number>();

function nextPeekRetry(id: string, key: string): number | undefined {
  const tries = peekRetries.get(id) ?? 0;
  if (tries >= PEEK_RETRY_MS.length || !stillBorrowed(key)) return void peekRetries.delete(id);
  peekRetries.set(id, tries + 1);
  return PEEK_RETRY_MS[tries];
}

export function settlePeek(key: string, pages: string[], failed: boolean, consent: ConsentToken | null, recheck: (page: string) => void): boolean {
  if (!isBorrowed(key)) return true;
  notePrivateFaviconPeek(failed, consent);
  for (const page of pages) {
    const id = `${key}|${page}`;
    const retry = failed ? nextPeekRetry(id, key) : void peekRetries.delete(id);
    if (retry !== undefined) setTimeout(() => recheck(page), retry);
  }
  return stillBorrowed(key);
}
