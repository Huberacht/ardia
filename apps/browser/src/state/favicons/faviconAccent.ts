import { useEffect } from "react";
import { create } from "zustand";
import { iconAccent } from "../../platform/favicons";
import { useResolvedFaviconUri } from "./faviconHooks";
import { onPrivateIconsDropped } from "./favicons";

const KEPT = 64;

export const useFaviconAccents = create<{ byUri: Record<string, string | null> }>()(() => ({ byUri: {} }));

const asking = new Set<string>();

onPrivateIconsDropped((uris) => {
  for (const uri of uris) asking.delete(uri);
  const { byUri } = useFaviconAccents.getState();
  if (Object.keys(byUri).some((uri) => uris.has(uri))) useFaviconAccents.setState({ byUri: Object.fromEntries(Object.entries(byUri).filter(([uri]) => !uris.has(uri))) });
});

function remember(uri: string, accent: string | null) {
  const kept = Object.entries(useFaviconAccents.getState().byUri).filter(([key]) => key !== uri).slice(-(KEPT - 1));
  useFaviconAccents.setState({ byUri: { ...Object.fromEntries(kept), [uri]: accent } });
}

export function useFaviconAccent(url: string, profileId?: string): string | null | undefined {
  const uri = useResolvedFaviconUri(url, null, profileId);
  const accent = useFaviconAccents((a) => (uri ? a.byUri[uri] : null));
  useEffect(() => {
    if (!uri || accent !== undefined || asking.has(uri)) return;
    asking.add(uri);
    void iconAccent(uri)
      .catch(() => null)
      .then((found) => asking.has(uri) && remember(uri, found ?? null))
      .finally(() => asking.delete(uri));
  }, [uri, accent]);
  return accent;
}
