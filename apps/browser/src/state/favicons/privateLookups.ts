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
