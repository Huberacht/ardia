import { DONATE_PRODUCT, SPONSOR_FIELD } from "./donate.mjs";

export { SPONSOR_FIELD };
export const SPONSOR_TIERS = [
  { tier: "patron", minCents: 50_000 },
  { tier: "backer", minCents: 5_000 },
  { tier: "friend", minCents: 0 },
];
export const TIER_CURRENCY = "usd";
export const SPONSORS_MAX = 200;
export const HIDE_METADATA = { key: "ardia_sponsor", value: "hide" };
export const STRIPE_PAGE_BUDGET = 20;
export const REFRESH_DEADLINE_MS = 20_000;

const REQUEST_TIMEOUT_MS = 8_000;
const LOOKUP_CONCURRENCY = 6;
const SPACING = /[\p{Cc}\p{Zl}\p{Zp}\s]+/gu;
const INVISIBLE = /[\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu;
const PILED_MARKS = /(\p{M}{2})\p{M}+/gu;
const DOT_LOOKALIKES = /[。｡︒․⸳·]/gu;
const URL_LIKE = /[a-z][a-z0-9+.-]*:\S|www\.|[\p{L}\p{N}-]+\.[\p{L}]{2,}(?![\p{L}\p{N}])/iu;
const EMAIL_LIKE = /\S@\S/u;
const IPV4_LIKE = /(?<![\p{N}.])\d{1,3}(?:\s*\.\s*\d{1,3}){3}(?![\p{N}])/u;
const IPV6_LIKE = /(?:^|[^\p{L}\p{N}])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,}/iu;
const READABLE = /[\p{L}\p{N}]/u;

const PROBE_CODE_POINTS = SPONSOR_FIELD.maxLength * 4;

const looksLikeAddress = (text) => {
  const probe = Array.from(text.slice(0, PROBE_CODE_POINTS * 2)).slice(0, PROBE_CODE_POINTS).join("").normalize("NFKC").replace(DOT_LOOKALIKES, ".");
  return URL_LIKE.test(probe) || EMAIL_LIKE.test(probe) || IPV4_LIKE.test(probe) || IPV6_LIKE.test(probe);
};

export function cleanSponsorName(raw) {
  if (typeof raw !== "string") return null;
  const flat = raw.normalize("NFC").replace(INVISIBLE, "").replace(SPACING, " ").replace(PILED_MARKS, "$1").trim();
  if (looksLikeAddress(flat)) return null;
  const name = Array.from(flat).slice(0, SPONSOR_FIELD.maxLength).join("").trim();
  return READABLE.test(name) ? name : null;
}

export function sponsorTier(monthlyCents) {
  const cents = Number.isFinite(monthlyCents) ? monthlyCents : 0;
  return SPONSOR_TIERS.find((t) => cents >= t.minCents).tier;
}

const tierRank = (tier) => SPONSOR_TIERS.findIndex((t) => t.tier === tier);
const idOf = (ref) => (typeof ref === "string" ? ref : ref?.id);
const itemsOf = (subscription) => (Array.isArray(subscription?.items?.data) ? subscription.items.data : []);
const isDonation = (subscription, product) => itemsOf(subscription).some((item) => idOf(item?.price?.product) === product);

const MONTHS_PER_INTERVAL = { month: 1, year: 12 };

export function monthlyCentsOf(subscription, product = DONATE_PRODUCT) {
  let cents = 0;
  for (const item of itemsOf(subscription)) {
    const price = item?.price;
    if (idOf(price?.product) !== product) continue;
    if (price.currency !== TIER_CURRENCY) return null;
    const months = MONTHS_PER_INTERVAL[price.recurring?.interval] * (Number(price.recurring?.interval_count) || 1);
    const unit = Number(price.unit_amount);
    const quantity = Number(item.quantity ?? 1);
    if (!Number.isFinite(months) || !Number.isFinite(unit) || !Number.isFinite(quantity)) return null;
    cents += (unit * quantity) / months;
  }
  return cents;
}

const fieldValue = (session) =>
  (Array.isArray(session?.custom_fields) ? session.custom_fields : []).find((f) => f?.key === SPONSOR_FIELD.key)?.text?.value;

export function sponsorsFrom(activeSubscriptions, sessionBySubscription, product = DONATE_PRODUCT) {
  const seen = new Map();
  for (const subscription of activeSubscriptions) {
    if (subscription?.status !== "active" || !isDonation(subscription, product)) continue;
    if (subscription.metadata?.[HIDE_METADATA.key] === HIDE_METADATA.value) continue;
    const session = sessionBySubscription.get(subscription.id);
    if (session?.status !== "complete" || !String(session.metadata?.donate ?? "").startsWith("monthly_")) continue;
    const name = cleanSponsorName(fieldValue(session));
    if (!name) continue;
    const sponsor = { name, tier: sponsorTier(monthlyCentsOf(subscription, product) ?? 0), since: Number(subscription.created) || 0 };
    const key = name.toLocaleLowerCase("en-US");
    const earlier = seen.get(key);
    seen.set(
      key,
      earlier
        ? { name: earlier.name, tier: tierRank(sponsor.tier) < tierRank(earlier.tier) ? sponsor.tier : earlier.tier, since: Math.min(earlier.since, sponsor.since) }
        : sponsor,
    );
  }
  return [...seen.values()]
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.since - b.since)
    .slice(0, SPONSORS_MAX)
    .map(({ name, tier }) => ({ name, tier }));
}

export class StripeReadError extends Error {
  constructor(status, code) {
    super(`stripe answered ${status}: ${code ?? "no code"}`);
    this.status = status;
  }
}

export class IncompleteListError extends Error {}

const keptSession = (session) =>
  session
    ? {
        status: session.status,
        metadata: { donate: session.metadata?.donate },
        custom_fields: [{ key: SPONSOR_FIELD.key, text: { value: fieldValue(session) } }],
      }
    : null;

async function eachLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function stripeSponsors({ key, product = DONATE_PRODUCT, fetchImpl = fetch, deadlineMs = REFRESH_DEADLINE_MS }) {
  const sessions = new Map();

  const get = async (path, params, deadline) => {
    const response = await fetchImpl(`https://api.stripe.com/v1/${path}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.any([deadline, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(body?.data)) throw new StripeReadError(response.status, body?.error?.code);
    return body;
  };

  const listAll = async (path, params, deadline) => {
    const items = [];
    let after = null;
    for (let page = 0; page < STRIPE_PAGE_BUDGET; page++) {
      const body = await get(path, { ...params, limit: "100", ...(after ? { starting_after: after } : {}) }, deadline);
      items.push(...body.data);
      if (!body.has_more) return items;
      if (body.data.length === 0) break;
      after = body.data[body.data.length - 1].id;
    }
    throw new IncompleteListError(`${path} still had more after ${STRIPE_PAGE_BUDGET} pages`);
  };

  return {
    describe: () => "Stripe subscriptions",
    async list() {
      const deadline = AbortSignal.timeout(deadlineMs);
      const active = await listAll("subscriptions", { status: "active" }, deadline);
      const donations = active.filter((s) => isDonation(s, product));
      const wanted = new Set(donations.map((s) => s.id));
      for (const id of sessions.keys()) if (!wanted.has(id)) sessions.delete(id);
      const missing = donations.filter((s) => !sessions.has(s.id));
      await eachLimited(missing, LOOKUP_CONCURRENCY, async (subscription) => {
        const body = await get("checkout/sessions", { subscription: subscription.id, limit: "1" }, deadline);
        sessions.set(subscription.id, keptSession(body.data[0]));
      });
      return { sponsors: sponsorsFrom(donations, sessions, product) };
    },
  };
}
