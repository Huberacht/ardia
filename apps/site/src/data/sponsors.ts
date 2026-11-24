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

export const DONOR_TIERS = ["patron", "backer", "friend"] as const;
export type DonorTier = (typeof DONOR_TIERS)[number];

export interface Donor {
  readonly name: string;
  readonly tier: DonorTier;
}

const SPONSORS_URL = "https://ardia.dev/api/sponsors";
const NAME_MAX = 40;
const DONORS_MAX = 200;
const FETCH_TIMEOUT_MS = 5000;
const FETCH_ATTEMPTS = 2;
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;

const isTier = (tier: unknown): tier is DonorTier => DONOR_TIERS.includes(tier as DonorTier);

export function donorsFrom(body: unknown): Donor[] {
  const list = (body as { sponsors?: unknown } | null)?.sponsors;
  if (!Array.isArray(list)) return [];
  const donors: Donor[] = [];
  for (const entry of list.slice(0, DONORS_MAX)) {
    const name = (entry as { name?: unknown } | null)?.name;
    const tier = (entry as { tier?: unknown } | null)?.tier;
    if (typeof name !== "string" || !isTier(tier)) continue;
    const clean = name.trim();
    if (!clean || Array.from(clean).length > NAME_MAX || HIDDEN_CHARS.test(clean)) continue;
    donors.push({ name: clean, tier });
  }
  return donors;
}

async function fetchDonorsOnce(url: string): Promise<Donor[] | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "ardia-site-build" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      console.warn(`sponsors: ${url} answered ${res.status}; showing company sponsors only`);
      return res.status >= 500 ? null : [];
    }
    return donorsFrom(await res.json());
  } catch (error) {
    console.warn(`sponsors: fetching ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function fetchDonors(): Promise<Donor[]> {
  const url = process.env.ARDIA_SPONSORS_URL || SPONSORS_URL;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    const donors = await fetchDonorsOnce(url);
    if (donors) return donors;
    if (attempt < FETCH_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return [];
}

export const DONORS: readonly Donor[] = await fetchDonors();
