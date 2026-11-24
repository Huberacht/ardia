import { donorsFrom, type Donor } from "../data/donors.ts";

export const LIVE_FETCH_TIMEOUT_MS = 4000;

interface ListElement {
  hidden: boolean;
  replaceChildren(...nodes: unknown[]): void;
}
interface DocumentLike {
  createElement(tag: "li"): { className: string; textContent: string | null };
}

export function renderDonors(list: ListElement, empty: { hidden: boolean }, donors: readonly Donor[], doc: DocumentLike) {
  list.replaceChildren(
    ...donors.map((donor) => {
      const item = doc.createElement("li");
      item.className = `name ${donor.tier}`;
      item.textContent = donor.name;
      return item;
    }),
  );
  list.hidden = donors.length === 0;
  empty.hidden = donors.length > 0;
}

export async function liveDonors(url: string, fetchImpl: typeof fetch = fetch): Promise<Donor[] | null> {
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return donorsFrom(await res.json());
  } catch {
    return null;
  }
}
