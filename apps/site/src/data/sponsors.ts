import { SPONSORS_PATH, donorsFrom, type Donor } from "./donors.ts";

export const COMPANY_SPONSORS = [
  {
    key: "greptile",
    name: "Greptile",
    href: "https://www.greptile.com/?utm_source=oss_badge&utm_medium=readme&utm_campaign=greptile_for_open_source",
    does: "reads every pull request before we do",
  },
  {
    key: "blacksmith",
    name: "Blacksmith",
    href: "https://www.blacksmith.sh",
    does: "runs our CI",
  },
] as const;
export type CompanySponsorKey = (typeof COMPANY_SPONSORS)[number]["key"];

const SPONSORS_URL = `https://ardia.dev${SPONSORS_PATH}`;
const FETCH_TIMEOUT_MS = 5000;
const RETRY_DELAYS_MS = [3000, 8000];

type Attempt = { donors: Donor[] } | "unknown" | "none";

async function fetchDonorsOnce(url: string): Promise<Attempt> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "ardia-site-build" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      console.warn(`sponsors: ${url} answered ${res.status}`);
      return res.status >= 500 || res.status === 429 ? "unknown" : "none";
    }
    const donors = donorsFrom(await res.json());
    return donors ? { donors } : "unknown";
  } catch (error) {
    console.warn(`sponsors: fetching ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
    return "unknown";
  }
}

async function fetchDonors(): Promise<Donor[]> {
  const url = process.env.ARDIA_SPONSORS_URL || SPONSORS_URL;
  for (let attempt = 0; ; attempt++) {
    const result = await fetchDonorsOnce(url);
    if (typeof result === "object") return result.donors;
    if (result === "none" || attempt >= RETRY_DELAYS_MS.length) break;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }
  console.warn("sponsors: building with company sponsors only; the page fetches donors live");
  return [];
}

export const DONORS: readonly Donor[] = await fetchDonors();
