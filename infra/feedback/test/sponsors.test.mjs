import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { HOSTILE_VALUES, embedded } from "../../../scripts/security/hostile-inputs.mjs";
import { localEvents, localIssues, localStore } from "../lib/backends.mjs";
import { DONATE_PRODUCT, monthlySessionForm } from "../lib/donate.mjs";
import { SPONSORS_TIMING, createService } from "../lib/service.mjs";
import {
  IncompleteListError,
  SPONSOR_FIELD,
  SPONSORS_MAX,
  STRIPE_PAGE_BUDGET,
  StripeReadError,
  cleanSponsorName,
  monthlyCentsOf,
  sponsorTier,
  sponsorsFrom,
  stripeSponsors,
} from "../lib/sponsors.mjs";

const servers = [];
after(() => servers.forEach((s) => s.close()));

async function service(sponsors, { rateLimits = false, now = Date.now, log = () => {} } = {}) {
  const handle = createService({
    store: localStore("/tmp/ardia-sponsors-test"), events: localEvents("/tmp/ardia-sponsors-test"), issues: localIssues("/tmp/ardia-sponsors-test"),
    secret: "x".repeat(40), publicUrl: () => "https://ardia.example", dashboardUrl: "https://dash.example", rateLimits, log, now,
    sponsors, donateReturnUrl: "https://ardia.example",
  });
  const server = createServer(handle);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

let seq = 0;
const subscription = ({ id = `sub_${++seq}`, cents = 500, quantity = 1, currency = "usd", priceCurrency = currency, currencyOptions, interval = "month", product = DONATE_PRODUCT, status = "active", metadata = {}, created = seq } = {}) => ({
  id,
  object: "subscription",
  status,
  created,
  metadata,
  customer: "cus_private",
  currency,
  items: { data: [{ quantity, price: { unit_amount: cents, currency: priceCurrency, ...(currencyOptions ? { currency_options: currencyOptions } : {}), product, recurring: { interval, interval_count: 1 } } }] },
});
const checkout = (name, { donate = "monthly_5", status = "complete", amountTotal = 500 } = {}) => ({
  id: `cs_${++seq}`,
  status,
  mode: "subscription",
  amount_total: amountTotal,
  metadata: { donate },
  customer_details: { email: "donor@example.com", name: "Private Person", address: { city: "Secret City" } },
  custom_fields: name === undefined ? [] : [{ key: SPONSOR_FIELD.key, type: "text", text: { value: name } }],
});
const donor = (name, subOptions = {}, checkoutOptions = {}) => {
  const sub = subscription(subOptions);
  return [sub, checkout(name, checkoutOptions)];
};
const listed = (pairs) => sponsorsFrom(pairs.map(([sub]) => sub), new Map(pairs.map(([sub, session]) => [sub.id, session])));

const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;

function assertShowable(name, label) {
  assert.equal(typeof name, "string", label);
  assert.ok(Array.from(name).length <= SPONSOR_FIELD.maxLength, `${label}: too long`);
  assert.equal(name, name.trim(), `${label}: untrimmed`);
  assert.doesNotMatch(name, HIDDEN_CHARS, `${label}: hidden character`);
  assert.doesNotMatch(name, /\s{2}|[^\S ]/u, `${label}: odd spacing`);
  assert.match(name, /[\p{L}\p{N}]/u, `${label}: nothing readable`);
  const probe = name.normalize("NFKC");
  assert.doesNotMatch(probe, /:\/\/|www\.|\S@\S|^[a-z][a-z0-9+.-]*:\S|\d{1,3}(\.\d{1,3}){3}/iu, `${label}: link or address`);
}

test("cleanSponsorName keeps ordinary names and companies, flattened to one plain line", () => {
  for (const [raw, want] of [
    ["Ada Lovelace", "Ada Lovelace"],
    ["  Zoë   Ångström ", "Zoë Ångström"],
    ["株式会社アーディア", "株式会社アーディア"],
    ["Ａｃｍｅ\u3000Ｃｏ", "Ａｃｍｅ Ｃｏ"],
    ["Ada\nLovelace", "Ada Lovelace"],
    ["Ada\u202eLovelace", "AdaLovelace"],
    ["Ad\u200ba", "Ada"],
    ["Acme Inc.", "Acme Inc."],
    ["J.R.R. Tolkien", "J.R.R. Tolkien"],
    ["Team: Ardia fans", "Team: Ardia fans"],
    ["Version 1.2 fans", "Version 1.2 fans"],
    ["e\u0301\u0301\u0301\u0301\u0301", "é\u0301\u0301"],
    ["x".repeat(80), "x".repeat(SPONSOR_FIELD.maxLength)],
    ["😀a".repeat(30), "😀a".repeat(SPONSOR_FIELD.maxLength / 2)],
  ]) assert.equal(cleanSponsorName(raw), want, JSON.stringify(raw));
});

test("cleanSponsorName refuses links, addresses and names with nothing to read", () => {
  for (const raw of ["https://evil.example", "visit www.evil.example", "acme.io", "Cal.com", "ada@example.com", "javascript:void(0)", "data:text/html,x", "   ", "\u200b\u202e", "!!!", "😀😀", "", null, 42, {}, ["Ada"]]) {
    assert.equal(cleanSponsorName(raw), null, JSON.stringify(raw));
  }
});

test("F6: compatibility forms, IP addresses and addresses past the length cap are refused too", () => {
  for (const raw of [
    "ａｄａ＠ｅｘａｍｐｌｅ．ｃｏｍ",
    "ada﹫example.com",
    "ａｃｍｅ．ｉｏ",
    "acme。io",
    "ｈｔｔｐｓ：／／evil.example",
    "192.168.0.1",
    "Ping 10 . 0 . 0 . 1",
    "１９２．１６８．０．１",
    "2001:db8::1",
    `${"x".repeat(SPONSOR_FIELD.maxLength - 2)} ada@example.com`,
  ]) assert.equal(cleanSponsorName(raw), null, JSON.stringify(raw));
});

test("every shared hostile input reaches the sponsor list clean or not at all", () => {
  let shown = 0;
  for (const { id, value } of HOSTILE_VALUES) {
    const shapes = typeof value === "string" ? embedded(value, "Ada ", " Lovelace") : [value];
    for (const [i, raw] of shapes.entries()) {
      const label = `${id}#${i}`;
      const sponsors = listed([donor(raw)]);
      assert.ok(sponsors.length <= 1, label);
      for (const sponsor of sponsors) {
        assert.deepEqual(Object.keys(sponsor).sort(), ["name", "tier"], label);
        assertShowable(sponsor.name, label);
        shown++;
      }
    }
  }
  assert.ok(shown > 50, `the positive control listed only ${shown}`);
});

test("sponsorTier gives a coarse tier, never the amount", () => {
  assert.equal(sponsorTier(100), "friend");
  assert.equal(sponsorTier(4_999), "friend");
  assert.equal(sponsorTier(5_000), "backer");
  assert.equal(sponsorTier(50_000), "patron");
  assert.equal(sponsorTier(null), "friend");
});

test("R3-5: the tier reads the subscription's own currency, including a multi-currency price", () => {
  const cadOnUsdDefault = subscription({ currency: "cad", priceCurrency: "usd", cents: 100_000, currencyOptions: { cad: { unit_amount: 137_000 } } });
  assert.equal(monthlyCentsOf(cadOnUsdDefault), null);
  const usdOnCadDefault = subscription({ currency: "usd", priceCurrency: "cad", cents: 137_000, currencyOptions: { usd: { unit_amount: 60_000 } } });
  assert.equal(monthlyCentsOf(usdOnCadDefault), 60_000);
  const usdWithoutOption = subscription({ currency: "usd", priceCurrency: "cad", cents: 137_000 });
  assert.equal(monthlyCentsOf(usdWithoutOption), null);
  assert.deepEqual(listed([
    [cadOnUsdDefault, checkout("Canadian Patron")],
    [usdOnCadDefault, checkout("Dollar Patron")],
  ]), [
    { name: "Dollar Patron", tier: "patron" },
    { name: "Canadian Patron", tier: "friend" },
  ]);
});

test("F5: the tier follows the subscription's current recurring USD amount, not the first checkout", () => {
  assert.equal(monthlyCentsOf(subscription({ cents: 100, quantity: 60 })), 6_000);
  assert.equal(monthlyCentsOf(subscription({ cents: 120_000, interval: "year" })), 10_000);
  assert.equal(monthlyCentsOf(subscription({ currency: "eur", cents: 100_000 })), null);
  const mixed = subscription({ cents: 500 });
  mixed.items.data.push({ quantity: 1, price: { unit_amount: 99_999, currency: "usd", product: "prod_other", recurring: { interval: "month" } } });
  assert.equal(monthlyCentsOf(mixed), 500);
  assert.deepEqual(listed([
    donor("Upgraded", { cents: 50_000 }, { amountTotal: 500 }),
    donor("Downgraded", { cents: 500 }, { amountTotal: 100_000 }),
    donor("Euro Patron", { cents: 100_000, currency: "eur" }),
  ]), [
    { name: "Upgraded", tier: "patron" },
    { name: "Downgraded", tier: "friend" },
    { name: "Euro Patron", tier: "friend" },
  ]);
});

test("sponsorsFrom lists active donation subscriptions that opted in, biggest tier first, then longest standing", () => {
  assert.deepEqual(listed([
    donor("Late Friend", { created: 30 }),
    donor("Early Friend", { created: 10 }),
    donor("Big Co", { cents: 100_000, created: 40 }, { donate: "monthly_1000" }),
    donor("Custom Backer", { cents: 7_500, created: 50 }, { donate: "monthly_custom" }),
    donor("Past Due", { status: "past_due" }),
    donor("Hidden By Owner", { metadata: { ardia_sponsor: "hide" } }),
    donor(undefined),
    donor("Other Product", { product: "prod_other" }),
    donor("Not A Donation Checkout", {}, { donate: "" }),
    donor("Open Checkout", {}, { status: "open" }),
    donor("early friend", { created: 60 }),
  ]), [
    { name: "Big Co", tier: "patron" },
    { name: "Custom Backer", tier: "backer" },
    { name: "Early Friend", tier: "friend" },
    { name: "Late Friend", tier: "friend" },
  ]);
  const [sub] = donor("No Checkout");
  assert.deepEqual(sponsorsFrom([sub], new Map([[sub.id, null]])), []);
});

test("sponsorsFrom caps the published list", () => {
  const many = Array.from({ length: SPONSORS_MAX + 20 }, (_, i) => donor(`Donor ${i}`));
  assert.equal(listed(many).length, SPONSORS_MAX);
});

async function holdingTheLoop(run) {
  const hold = setInterval(() => {}, 1000);
  try {
    return await run();
  } finally {
    clearInterval(hold);
  }
}

const ok = (data, has_more = false) => new Response(JSON.stringify({ object: "list", data, has_more }), { status: 200 });

function fakeStripe({ subscriptions, sessions, subscriptionStatus = 200, sessionStatus = 200, pageSize = 100, sessionAnswer = null }) {
  const calls = { subscriptions: 0, sessions: [], startedAt: [], inFlight: 0, maxInFlight: 0 };
  const fetchImpl = async (url, init) => {
    calls.startedAt.push(Date.now());
    assert.equal(init.headers.Authorization, "Bearer rk_test_x");
    const { pathname, searchParams } = new URL(url);
    if (pathname === "/v1/subscriptions") {
      calls.subscriptions++;
      assert.equal(searchParams.get("status"), "active");
      if (subscriptionStatus !== 200) return new Response(JSON.stringify({ error: { code: "permission" } }), { status: subscriptionStatus });
      const after = searchParams.get("starting_after");
      const start = after ? subscriptions.findIndex((s) => s.id === after) + 1 : 0;
      const page = subscriptions.slice(start, start + pageSize);
      return ok(page, start + pageSize < subscriptions.length);
    }
    if (pathname === "/v1/checkout/sessions") {
      const id = searchParams.get("subscription");
      calls.sessions.push(id);
      if (sessionAnswer) {
        calls.inFlight++;
        calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
        try {
          return await sessionAnswer(id, calls.sessions.length, init.signal);
        } finally {
          calls.inFlight--;
        }
      }
      if (sessionStatus !== 200) return new Response("{}", { status: sessionStatus });
      return ok(sessions.has(id) ? [sessions.get(id)] : []);
    }
    throw new Error(`unexpected ${pathname}`);
  };
  return { fetchImpl, calls };
}

test("F3: stripeSponsors starts from active subscriptions, so a long checkout history can't hide a donor", async () => {
  const others = Array.from({ length: 150 }, (_, i) => subscription({ product: `prod_other_${i}` }));
  const [sub, session] = donor("Still Here", { cents: 5_000 });
  const stripe = fakeStripe({ subscriptions: [...others, sub], sessions: new Map([[sub.id, session]]) });
  const sponsors = stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, requestGapMs: 0 });
  const body = await sponsors.list();
  assert.deepEqual(body, { sponsors: [{ name: "Still Here", tier: "backer" }] });
  assert.equal(stripe.calls.subscriptions, 2);
  assert.deepEqual(stripe.calls.sessions, [sub.id]);
  const text = JSON.stringify(body);
  for (const secret of ["donor@example.com", "Private Person", "Secret City", "cus_private", "5000", "sub_", "cs_"]) assert.ok(!text.includes(secret), secret);
  await sponsors.list();
  assert.deepEqual(stripe.calls.sessions, [sub.id], "a known subscription's checkout isn't fetched again");
});

test("F3: a new hide on the subscription takes the name off at the next refresh", async () => {
  const [sub, session] = donor("Changed Mind");
  const stripe = fakeStripe({ subscriptions: [sub], sessions: new Map([[sub.id, session]]) });
  const sponsors = stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, requestGapMs: 0 });
  assert.equal((await sponsors.list()).sponsors.length, 1);
  sub.metadata = { ardia_sponsor: "hide" };
  assert.deepEqual(await sponsors.list(), { sponsors: [] });
});

test("F2: stripeSponsors publishes nothing when subscriptions or a checkout can't be read", async () => {
  const [sub, session] = donor("Hidden Donor", { metadata: { ardia_sponsor: "hide" } });
  for (const status of [401, 403, 500]) {
    const stripe = fakeStripe({ subscriptions: [sub], sessions: new Map([[sub.id, session]]), subscriptionStatus: status });
    await assert.rejects(stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, requestGapMs: 0 }).list(), StripeReadError, String(status));
  }
  const [visible, visibleSession] = donor("Visible");
  const lookupFails = fakeStripe({ subscriptions: [visible], sessions: new Map([[visible.id, visibleSession]]), sessionStatus: 403 });
  await assert.rejects(stripeSponsors({ key: "rk_test_x", fetchImpl: lookupFails.fetchImpl, requestGapMs: 0 }).list(), StripeReadError);
});

test("B: a listing still reporting more at the page budget is incomplete, never a short list", async () => {
  const [sub, session] = donor("On Page One");
  const filler = Array.from({ length: STRIPE_PAGE_BUDGET + 5 }, () => subscription({ product: "prod_other" }));
  const stripe = fakeStripe({ subscriptions: [sub, ...filler], sessions: new Map([[sub.id, session]]), pageSize: 1 });
  await assert.rejects(stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, requestGapMs: 0 }).list(), IncompleteListError);
  assert.equal(stripe.calls.subscriptions, STRIPE_PAGE_BUDGET);
});

test("F4: a refresh stops at its deadline even when Stripe never answers", async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  await holdingTheLoop(async () => {
    const started = Date.now();
    await assert.rejects(stripeSponsors({ key: "rk_test_x", fetchImpl: hang, deadlineMs: 150 }).list());
    assert.ok(Date.now() - started < 2000);
  });
});

test("custom monthly checkouts ask for the same optional public name", () => {
  const form = monthlySessionForm(25, { product: "prod_x", returnUrl: "https://ardia.example" });
  assert.equal(form.get("custom_fields[0][key]"), SPONSOR_FIELD.key);
  assert.equal(form.get("custom_fields[0][type]"), "text");
  assert.equal(form.get("custom_fields[0][optional]"), "true");
  assert.equal(form.get("custom_fields[0][label][custom]"), SPONSOR_FIELD.label);
  assert.equal(form.get("custom_fields[0][text][maximum_length]"), String(SPONSOR_FIELD.maxLength));
});

function controlledList() {
  const state = { calls: 0, mode: "ok", release: null };
  const backend = {
    describe: () => "fake",
    list: () => {
      state.calls++;
      if (state.mode === "fail") return Promise.reject(new Error("stripe down"));
      if (state.mode === "hang") return new Promise((resolve) => (state.release = () => resolve({ sponsors: [{ name: `Donor ${state.calls}`, tier: "friend" }] })));
      return Promise.resolve({ sponsors: [{ name: `Donor ${state.calls}`, tier: "friend" }] });
    },
  };
  return { state, backend };
}

const getJson = async (url) => {
  const res = await fetch(`${url}/api/sponsors`);
  return { status: res.status, body: await res.json(), res };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("GET /api/sponsors serves the cached list, refreshes it in the background, and is never cached by browsers", async () => {
  let clock = 1_000_000;
  const { state, backend } = controlledList();
  const url = await service(backend, { now: () => clock });
  const [a, b] = await Promise.all([getJson(url), getJson(url)]);
  assert.equal(a.status, 200);
  assert.equal(a.res.headers.get("cache-control"), "no-store");
  assert.equal(a.res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(a.body, { sponsors: [{ name: "Donor 1", tier: "friend" }] });
  assert.deepEqual(b.body, a.body);
  assert.equal(state.calls, 1);
  clock += SPONSORS_TIMING.freshMs;
  state.mode = "hang";
  assert.deepEqual((await getJson(url)).body, { sponsors: [{ name: "Donor 1", tier: "friend" }] }, "a stale list answers at once");
  assert.equal(state.calls, 2);
  state.release();
  await settle();
  assert.deepEqual((await getJson(url)).body, { sponsors: [{ name: "Donor 2", tier: "friend" }] });
});

test("F2+F4: a failing refresh waits out a cooldown, and a stale list is dropped after its max age", async () => {
  let clock = 1_000_000;
  const { state, backend } = controlledList();
  const url = await service(backend, { now: () => clock });
  assert.equal((await getJson(url)).status, 200);
  state.mode = "fail";
  clock += SPONSORS_TIMING.freshMs;
  assert.equal((await getJson(url)).status, 200);
  await settle();
  assert.equal(state.calls, 2);
  clock += SPONSORS_TIMING.cooldownMs - 1;
  assert.equal((await getJson(url)).status, 200);
  assert.equal(state.calls, 2, "no retry inside the cooldown");
  clock = 1_000_000 + SPONSORS_TIMING.maxAgeMs;
  const dropped = await getJson(url);
  await settle();
  assert.equal(dropped.status, 503);
  assert.equal(dropped.body.error, "sponsors_unavailable");
  assert.equal(dropped.res.headers.get("retry-after"), String(SPONSORS_TIMING.cooldownMs / 1000));
  assert.equal(state.calls, 3);
  assert.equal((await getJson(url)).status, 503, "still nothing inside the next cooldown");
  assert.equal(state.calls, 3);
});

test("F4: a cold request waits briefly, then answers 503 while the refresh carries on", async (t) => {
  const coldWait = SPONSORS_TIMING.coldWaitMs;
  SPONSORS_TIMING.coldWaitMs = 100;
  t.after(() => (SPONSORS_TIMING.coldWaitMs = coldWait));
  const { state, backend } = controlledList();
  state.mode = "hang";
  const url = await service(backend);
  const started = Date.now();
  assert.equal((await getJson(url)).status, 503);
  assert.ok(Date.now() - started < 1000);
  state.release();
  await settle();
  assert.deepEqual((await getJson(url)).body, { sponsors: [{ name: "Donor 1", tier: "friend" }] });
  assert.equal(state.calls, 1);
});

test("GET /api/sponsors answers 503 when off and when the first refresh fails, 405 for other methods", async () => {
  assert.equal((await fetch(`${await service(null)}/api/sponsors`)).status, 503);
  const failing = await service({ describe: () => "fake", list: async () => { throw new Error("down"); } });
  const res = await fetch(`${failing}/api/sponsors`);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "sponsors_unavailable");
  assert.equal((await fetch(`${failing}/api/sponsors`, { method: "POST" })).status, 405);
});

test("GET /api/sponsors stops at 120 requests per address in 10 minutes", async () => {
  const url = await service({ describe: () => "fake", list: async () => ({ sponsors: [] }) }, { rateLimits: true });
  const get = () => fetch(`${url}/api/sponsors`, { headers: { "X-Real-IP": "203.0.113.9" } });
  for (let i = 0; i < 120; i++) assert.equal((await get()).status, 200);
  assert.equal((await get()).status, 429);
});

test("R3-3: an empty or unfinished checkout lookup isn't cached, so the donor appears once the checkout is there", async () => {
  const [sub, session] = donor("Late Checkout");
  const sessions = new Map();
  const stripe = fakeStripe({ subscriptions: [sub], sessions });
  const sponsors = stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, requestGapMs: 0 });
  assert.deepEqual(await sponsors.list(), { sponsors: [] });
  sessions.set(sub.id, { ...session, status: "open" });
  assert.deepEqual(await sponsors.list(), { sponsors: [] });
  sessions.set(sub.id, session);
  assert.deepEqual(await sponsors.list(), { sponsors: [{ name: "Late Checkout", tier: "friend" }] });
  assert.deepEqual(stripe.calls.sessions, [sub.id, sub.id, sub.id]);
  await sponsors.list();
  assert.equal(stripe.calls.sessions.length, 3, "a completed checkout is cached");
});

test("R3-4: a cold refresh paces its requests and keeps at most 3 lookups in flight", async () => {
  const pairs = Array.from({ length: 12 }, (_, i) => donor(`Donor ${i}`));
  const stripe = fakeStripe({
    subscriptions: pairs.map(([sub]) => sub),
    sessions: new Map(),
    sessionAnswer: async (id) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return ok([pairs.find(([sub]) => sub.id === id)[1]]);
    },
  });
  const body = await stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, requestGapMs: 30 }).list();
  assert.equal(body.sponsors.length, 12);
  assert.ok(stripe.calls.maxInFlight <= 3, `in flight ${stripe.calls.maxInFlight}`);
  const gaps = stripe.calls.startedAt.slice(1).map((at, i) => at - stripe.calls.startedAt[i]);
  assert.ok(Math.min(...gaps) >= 25, `smallest gap ${Math.min(...gaps)} ms`);
});

test("R3-4: a 429 fails the refresh and no request starts after it", async () => {
  const pairs = Array.from({ length: 40 }, (_, i) => donor(`Donor ${i}`));
  const stripe = fakeStripe({
    subscriptions: pairs.map(([sub]) => sub),
    sessions: new Map(),
    sessionAnswer: async (id, n) => (n === 2 ? new Response(JSON.stringify({ error: { code: "rate_limit" } }), { status: 429 }) : ok([pairs.find(([sub]) => sub.id === id)[1]])),
  });
  const failure = await stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, requestGapMs: 5 }).list().catch((error) => error);
  assert.ok(failure instanceof StripeReadError);
  assert.equal(failure.status, 429);
  const issued = stripe.calls.startedAt.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(stripe.calls.startedAt.length, issued, "no request after the refresh failed");
  assert.ok(stripe.calls.sessions.length <= 4, `lookups started ${stripe.calls.sessions.length}`);
});

test("R3-4: no request starts after the refresh deadline aborts it", async () => {
  const pairs = Array.from({ length: 40 }, (_, i) => donor(`Donor ${i}`));
  const stripe = fakeStripe({
    subscriptions: pairs.map(([sub]) => sub),
    sessions: new Map(),
    sessionAnswer: (id, n, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
  });
  await holdingTheLoop(async () => {
    await assert.rejects(stripeSponsors({ key: "rk_test_x", fetchImpl: stripe.fetchImpl, deadlineMs: 150, requestGapMs: 0 }).list());
    const issued = stripe.calls.startedAt.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(stripe.calls.startedAt.length, issued);
    assert.ok(stripe.calls.sessions.length <= 3, `lookups started ${stripe.calls.sessions.length}`);
  });
});
