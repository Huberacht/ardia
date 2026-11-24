export const SPONSOR_FIELD = {
  key: "sponsorname",
  label: "Name or company to show publicly on ardia.dev",
  maxLength: 40,
};
export const SPONSOR_TIERS = [
  { tier: "patron", minCents: 50_000 },
  { tier: "backer", minCents: 5_000 },
  { tier: "friend", minCents: 0 },
];
export const SPONSORS_MAX = 200;
export const HIDE_METADATA = { key: "ardia_sponsor", value: "hide" };

const STRIPE_PAGES = 20;
const SPACING = /[\p{Cc}\p{Zl}\p{Zp}\s]+/gu;
const INVISIBLE = /[\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu;
const PILED_MARKS = /(\p{M}{2})\p{M}+/gu;
const URL_LIKE = /[a-z][a-z0-9+.-]*:\S|www\.|[\p{L}\p{N}-]+\.[\p{L}]{2,}(?![\p{L}\p{N}])/iu;
const EMAIL_LIKE = /\S@\S/u;
const READABLE = /[\p{L}\p{N}]/u;

export function cleanSponsorName(raw) {
  if (typeof raw !== "string") return null;
  const flat = raw.normalize("NFC").replace(INVISIBLE, "").replace(SPACING, " ").replace(PILED_MARKS, "$1").trim();
  const name = Array.from(flat).slice(0, SPONSOR_FIELD.maxLength).join("").trim();
  if (!READABLE.test(name) || URL_LIKE.test(name) || EMAIL_LIKE.test(name)) return null;
  return name;
}

export function sponsorTier(monthlyCents) {
  const cents = Number.isFinite(monthlyCents) ? monthlyCents : 0;
  return SPONSOR_TIERS.find((t) => cents >= t.minCents).tier;
}

const tierRank = (tier) => SPONSOR_TIERS.findIndex((t) => t.tier === tier);

const fieldValue = (session) =>
  (Array.isArray(session.custom_fields) ? session.custom_fields : []).find((f) => f?.key === SPONSOR_FIELD.key)?.text?.value;

export function sponsorsFrom(sessions, activeSubscriptions) {
  const seen = new Map();
  for (const session of sessions) {
    if (session?.mode !== "subscription" || session.status !== "complete") continue;
    if (!String(session.metadata?.donate ?? "").startsWith("monthly_")) continue;
    if (typeof session.subscription !== "string") continue;
    if (activeSubscriptions) {
      const subscription = activeSubscriptions.get(session.subscription);
      if (!subscription || subscription.metadata?.[HIDE_METADATA.key] === HIDE_METADATA.value) continue;
    }
    const name = cleanSponsorName(fieldValue(session));
    if (!name) continue;
    const sponsor = { name, tier: sponsorTier(session.amount_total), since: Number(session.created) || 0 };
    const key = name.toLocaleLowerCase("en-US");
    const earlier = seen.get(key);
    if (!earlier) {
      seen.set(key, sponsor);
      continue;
    }
    seen.set(key, {
      name: earlier.name,
      tier: tierRank(sponsor.tier) < tierRank(earlier.tier) ? sponsor.tier : earlier.tier,
      since: Math.min(earlier.since, sponsor.since),
    });
  }
  return [...seen.values()]
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.since - b.since)
    .slice(0, SPONSORS_MAX)
    .map(({ name, tier }) => ({ name, tier }));
}

class StripeReadError extends Error {
  constructor(status, code) {
    super(`stripe answered ${status}: ${code ?? "no code"}`);
    this.status = status;
  }
}

export function stripeSponsors({ key, fetchImpl = fetch, log = console.log }) {
  const list = async (path, params) => {
    const items = [];
    let after = null;
    for (let page = 0; page < STRIPE_PAGES; page++) {
      const query = new URLSearchParams({ ...params, limit: "100", ...(after ? { starting_after: after } : {}) });
      const response = await fetchImpl(`https://api.stripe.com/v1/${path}?${query}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(body?.data)) throw new StripeReadError(response.status, body?.error?.code);
      items.push(...body.data);
      if (!body.has_more || body.data.length === 0) break;
      after = body.data[body.data.length - 1].id;
    }
    return items;
  };

  let warnedNoSubscriptions = false;
  const activeSubscriptions = async () => {
    try {
      return new Map((await list("subscriptions", { status: "active" })).map((s) => [s.id, s]));
    } catch (error) {
      if (!(error instanceof StripeReadError) || (error.status !== 401 && error.status !== 403)) throw error;
      if (!warnedNoSubscriptions) log("[feedback] sponsors: the Stripe key can't read subscriptions, so cancelled monthly donors stay listed");
      warnedNoSubscriptions = true;
      return null;
    }
  };

  return {
    describe: () => "Stripe Checkout Sessions",
    async list() {
      const [sessions, active] = await Promise.all([list("checkout/sessions", { status: "complete" }), activeSubscriptions()]);
      return { sponsors: sponsorsFrom(sessions, active) };
    },
  };
}
