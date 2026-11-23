import { useBrowser } from "../browser/store";
import { isIncognitoProfile } from "../browser/model";

type IconMaps = { pages: Record<string, string | null>; srcs: Record<string, string>; appearances: Record<string, [string, string]> };

export const privateViewer = (profileId?: string) => (profileId && isIncognitoProfile(profileId) ? profileId : undefined);

export function incognitoClosed(key: string): boolean {
  if (!isIncognitoProfile(key)) return false;
  const s = useBrowser.getState();
  return !Object.values(s.windows).some((w) => w.profileId === key) && !Object.values(s.tabs).some((t) => t.profileId === key);
}

const urisOf = (icons: IconMaps) => [...Object.values(icons.pages), ...Object.values(icons.srcs), ...Object.values(icons.appearances).flat()].filter((uri): uri is string => !!uri);

const ownedByPrivate = new Map<string, Set<string>>();

export function notePrivateUri(key: string, uri: string) {
  let owned = ownedByPrivate.get(key);
  if (!owned) ownedByPrivate.set(key, (owned = new Set()));
  owned.add(uri);
}

export function takePrivateUris(gone: [string, IconMaps][], kept: IconMaps[]): Set<string> {
  const still = new Set(kept.flatMap(urisOf));
  const held = gone.flatMap(([key, icons]) => {
    const owned = [...(ownedByPrivate.get(key) ?? [])];
    ownedByPrivate.delete(key);
    return [...owned, ...urisOf(icons)];
  });
  return new Set(held.filter((uri) => !still.has(uri)));
}
