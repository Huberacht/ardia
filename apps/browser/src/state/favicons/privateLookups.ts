import { useBrowser } from "../browser/store";
import { isIncognitoProfile } from "../browser/model";

export const privateViewer = (profileId?: string) => (profileId && isIncognitoProfile(profileId) ? profileId : undefined);

export const askedAs = (source: string, into: string) => (source === into ? source : `${into}|${source}`);

export function incognitoClosed(key: string): boolean {
  if (!isIncognitoProfile(key)) return false;
  const s = useBrowser.getState();
  return !Object.values(s.windows).some((w) => w.profileId === key) && !Object.values(s.tabs).some((t) => t.profileId === key);
}

export const shouldWrite = (routed: boolean, known: string | null | undefined, uri: string | null) =>
  routed ? (uri ? !known : known === undefined) : known !== uri;

const askers = new Set<string>();
const answeredRoutes = new Set<string>();
const routeId = (into: string, source: string, page: string) => `${into}|${source}|${page}`;

export const notePrivateAsker = (into: string) => void askers.add(into);
export const noteRouteAnswered = (into: string, source: string, page: string) => void answeredRoutes.add(routeId(into, source, page));
export const routeAnswered = (into: string, source: string, page: string) => answeredRoutes.has(routeId(into, source, page));

export function takeClosedAskers(): string[] {
  const closed = [...askers].filter(incognitoClosed);
  for (const id of closed) {
    askers.delete(id);
    for (const route of [...answeredRoutes]) if (route.startsWith(`${id}|`)) answeredRoutes.delete(route);
  }
  return closed;
}
