import { cleanUrlReport, displayUrl, fixupUrl, type CleanUrlReport } from "@ardia/core";

export const ADDRESS_FIELD_COPIES_CLEAN = true;

export type AddressField = { value: string; rowUrl: string | null; pageUrl: string; untouched: boolean; scoped: boolean };

const shows = (text: string, url: string) => text === url || text === displayUrl(url);
const webAddress = (url: string | null) => (url && /^https?:\/\//i.test(url) ? url : null);

function wholeFieldAddress({ value, rowUrl, pageUrl, untouched, scoped }: AddressField): string | null {
  const text = value.trim();
  if (!text || scoped) return null;
  if (rowUrl && shows(text, rowUrl)) return rowUrl;
  if (untouched && pageUrl && shows(text, pageUrl)) return pageUrl;
  const typed = webAddress(fixupUrl(text));
  return typed && cleanUrlReport(typed).removedTracker ? typed : null;
}

export function addressFieldCopy(field: AddressField): CleanUrlReport | null {
  if (!ADDRESS_FIELD_COPIES_CLEAN) return null;
  const address = wholeFieldAddress(field);
  return address ? cleanUrlReport(address) : null;
}
