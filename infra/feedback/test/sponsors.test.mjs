import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { HOSTILE_VALUES, embedded } from "../../../scripts/security/hostile-inputs.mjs";
import { localEvents, localIssues, localStore } from "../lib/backends.mjs";
import { monthlySessionForm } from "../lib/donate.mjs";
import { createService } from "../lib/service.mjs";
import { SPONSOR_FIELD, SPONSORS_MAX, cleanSponsorName, sponsorTier, sponsorsFrom, stripeSponsors } from "../lib/sponsors.mjs";

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

let sessionSeq = 0;
const session = (name, { cents = 500, sub = `sub_${++sessionSeq}`, donate = "monthly_5", mode = "subscription", created = sessionSeq } = {}) => ({
  id: `cs_${sessionSeq}`,
  mode,
  status: "complete",
  created,
  amount_total: cents,
  subscription: sub,
  metadata: { donate },
  customer_details: { email: "donor@example.com", name: "Private Person", address: { city: "Secret City" } },
  custom_fields: name === undefined ? [] : [{ key: SPONSOR_FIELD.key, type: "text", text: { value: name } }],
});

const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;

function assertShowable(name, label) {
  assert.equal(typeof name, "string", label);
  assert.ok(Array.from(name).length <= SPONSOR_FIELD.maxLength, `${label}: too long`);
  assert.equal(name, name.trim(), `${label}: untrimmed`);
  assert.doesNotMatch(name, HIDDEN_CHARS, `${label}: hidden character`);
  assert.doesNotMatch(name, /\s{2}|[^\S ]/u, `${label}: odd spacing`);
  assert.match(name, /[\p{L}\p{N}]/u, `${label}: nothing readable`);
  assert.doesNotMatch(name, /:\/\/|www\.|\S@\S|^[a-z][a-z0-9+.-]*:\S/iu, `${label}: link or address`);
}

test("cleanSponsorName keeps ordinary names and companies, flattened to one plain line", () => {
  for (const [raw, want] of [
    ["Ada Lovelace", "Ada Lovelace"],
    ["  Zoë   Ångström ", "Zoë Ångström"],
    ["株式会社アーディア", "株式会社アーディア"],
    ["Ada\nLovelace", "Ada Lovelace"],
    ["Ada\u202eLovelace", "AdaLovelace"],
    ["Ad\u200ba", "Ada"],
    ["Acme Inc.", "Acme Inc."],
    ["J.R.R. Tolkien", "J.R.R. Tolkien"],
    ["Team: Ardia fans", "Team: Ardia fans"],
    ["e\u0301\u0301\u0301\u0301\u0301", "\u00e9\u0301\u0301"],
    ["x".repeat(80), "x".repeat(SPONSOR_FIELD.maxLength)],
    ["😀a".repeat(30), "😀a".repeat(SPONSOR_FIELD.maxLength / 2)],
  ]) assert.equal(cleanSponsorName(raw), want, JSON.stringify(raw));
});

test("cleanSponsorName refuses links, addresses and names with nothing to read", () => {
  for (const raw of ["https://evil.example", "visit www.evil.example", "acme.io", "Cal.com", "ada@example.com", "javascript:void(0)", "data:text/html,x", "   ", "\u200b\u202e", "!!!", "😀😀", "", null, 42, {}, ["Ada"]]) {
    assert.equal(cleanSponsorName(raw), null, JSON.stringify(raw));
  }
});

test("every shared hostile input reaches the sponsor list clean or not at all", () => {
  let shown = 0;
  for (const { id, value } of HOSTILE_VALUES) {
    const shapes = typeof value === "string" ? embedded(value, "Ada ", " Lovelace") : [value];
    for (const [i, raw] of shapes.entries()) {
      const label = `${id}#${i}`;
      const listed = sponsorsFrom([session(raw)], null);
      assert.ok(listed.length <= 1, label);
      for (const sponsor of listed) {
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
  assert.equal(sponsorTier(100_000), "patron");
  assert.equal(sponsorTier(null), "friend");
});

test("sponsorsFrom lists active monthly donors who opted in, biggest tier first, then longest standing", () => {
  const active = new Map([
    ["sub_a", { id: "sub_a" }], ["sub_b", { id: "sub_b" }], ["sub_c", { id: "sub_c" }], ["sub_d", { id: "sub_d" }],
    ["sub_hidden", { id: "sub_hidden", metadata: { ardia_sponsor: "hide" } }], ["sub_e", { id: "sub_e" }],
  ]);
  const listed = sponsorsFrom([
    session("Late Friend", { sub: "sub_a", created: 30 }),
    session("Early Friend", { sub: "sub_b", created: 10 }),
    session("Big Co", { sub: "sub_c", cents: 100_000, donate: "monthly_1000", created: 40 }),
    session("Custom Backer", { sub: "sub_d", cents: 7_500, donate: "monthly_custom", created: 50 }),
    session("Cancelled", { sub: "sub_gone" }),
    session("Hidden By Owner", { sub: "sub_hidden" }),
    session(undefined, { sub: "sub_e" }),
    session("One Time", { mode: "payment", sub: null, donate: "once_5" }),
    session("Other Product", { sub: "sub_e", donate: "" }),
    session("early friend", { sub: "sub_a", created: 60 }),
  ], active);
  assert.deepEqual(listed, [
    { name: "Big Co", tier: "patron" },
    { name: "Custom Backer", tier: "backer" },
    { name: "Early Friend", tier: "friend" },
    { name: "Late Friend", tier: "friend" },
  ]);
});

test("sponsorsFrom keeps cancelled donors only when subscriptions can't be read, and caps the list", () => {
  assert.deepEqual(sponsorsFrom([session("Cancelled", { sub: "sub_gone" })], null), [{ name: "Cancelled", tier: "friend" }]);
  const many = Array.from({ length: SPONSORS_MAX + 20 }, (_, i) => session(`Donor ${i}`));
  assert.equal(sponsorsFrom(many, null).length, SPONSORS_MAX);
});

const stripeFake = (routes) => async (url, init) => {
  assert.equal(init.headers.Authorization, "Bearer rk_test_x");
  const { pathname, searchParams } = new URL(url);
  const route = routes[pathname];
  return route(searchParams);
};
const ok = (data, has_more = false) => new Response(JSON.stringify({ object: "list", data, has_more }), { status: 200 });

test("stripeSponsors pages through sessions and active subscriptions and returns names and tiers only", async () => {
  const seen = [];
  const fake = stripeFake({
    "/v1/checkout/sessions": (q) => {
      seen.push(`sessions:${q.get("status")}:${q.get("starting_after") ?? ""}`);
      return q.get("starting_after") ? ok([session("Second Page", { sub: "sub_2" })]) : ok([session("First Page", { sub: "sub_1" })], true);
    },
    "/v1/subscriptions": (q) => {
      seen.push(`subscriptions:${q.get("status")}`);
      return ok([{ id: "sub_1" }, { id: "sub_2" }]);
    },
  });
  const body = await stripeSponsors({ key: "rk_test_x", fetchImpl: fake, log: () => {} }).list();
  assert.deepEqual(body, { sponsors: [{ name: "First Page", tier: "friend" }, { name: "Second Page", tier: "friend" }] });
  assert.equal(seen.length, 3);
  assert.ok(seen.includes("sessions:complete:") && seen.includes("subscriptions:active"));
  assert.ok(seen.some((s) => /^sessions:complete:cs_\d+$/.test(s)));
  const text = JSON.stringify(body);
  for (const secret of ["donor@example.com", "Private Person", "Secret City", "500", "sub_", "cs_"]) assert.ok(!text.includes(secret), secret);
});

test("stripeSponsors lists every opted-in donor when the key can't read subscriptions, and fails on other errors", async () => {
  const logs = [];
  const denied = stripeFake({
    "/v1/checkout/sessions": () => ok([session("Still Listed", { sub: "sub_gone" })]),
    "/v1/subscriptions": () => new Response(JSON.stringify({ error: { type: "invalid_request_error" } }), { status: 403 }),
  });
  assert.deepEqual(await stripeSponsors({ key: "rk_test_x", fetchImpl: denied, log: (l) => logs.push(l) }).list(), { sponsors: [{ name: "Still Listed", tier: "friend" }] });
  assert.equal(logs.length, 1);
  const broken = stripeFake({
    "/v1/checkout/sessions": () => new Response("{}", { status: 403 }),
    "/v1/subscriptions": () => ok([]),
  });
  await assert.rejects(stripeSponsors({ key: "rk_test_x", fetchImpl: broken, log: () => {} }).list());
});

test("custom monthly checkouts ask for the same optional public name", () => {
  const form = monthlySessionForm(25, { product: "prod_x", returnUrl: "https://ardia.example" });
  assert.equal(form.get("custom_fields[0][key]"), SPONSOR_FIELD.key);
  assert.equal(form.get("custom_fields[0][type]"), "text");
  assert.equal(form.get("custom_fields[0][optional]"), "true");
  assert.equal(form.get("custom_fields[0][label][custom]"), SPONSOR_FIELD.label);
  assert.equal(form.get("custom_fields[0][text][maximum_length]"), String(SPONSOR_FIELD.maxLength));
});

test("GET /api/sponsors serves a cached list, keeps the last one when Stripe fails, and is cacheable", async () => {
  let clock = 1_000_000;
  let calls = 0;
  let failing = false;
  const url = await service({
    describe: () => "fake",
    list: async () => {
      calls++;
      if (failing) throw new Error("stripe down");
      return { sponsors: [{ name: `Donor ${calls}`, tier: "friend" }] };
    },
  }, { now: () => clock });
  const [a, b] = await Promise.all([fetch(`${url}/api/sponsors`), fetch(`${url}/api/sponsors`)]);
  assert.equal(a.status, 200);
  assert.match(a.headers.get("cache-control"), /^public, max-age=\d+$/);
  assert.equal(a.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await a.json(), { sponsors: [{ name: "Donor 1", tier: "friend" }] });
  assert.deepEqual(await b.json(), { sponsors: [{ name: "Donor 1", tier: "friend" }] });
  assert.equal(calls, 1);
  clock += 11 * 60 * 1000;
  failing = true;
  assert.deepEqual(await (await fetch(`${url}/api/sponsors`)).json(), { sponsors: [{ name: "Donor 1", tier: "friend" }] });
  assert.equal(calls, 2);
  assert.equal((await fetch(`${url}/api/sponsors`)).status, 200);
  assert.equal(calls, 2);
  clock += 61 * 1000;
  failing = false;
  assert.deepEqual(await (await fetch(`${url}/api/sponsors`)).json(), { sponsors: [{ name: "Donor 3", tier: "friend" }] });
});

test("GET /api/sponsors answers 503 when off, 502 when Stripe fails with nothing cached, 405 for other methods", async () => {
  assert.equal((await fetch(`${await service(null)}/api/sponsors`)).status, 503);
  const failing = await service({ describe: () => "fake", list: async () => { throw new Error("down"); } });
  const res = await fetch(`${failing}/api/sponsors`);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).backend, "sponsors");
  assert.equal((await fetch(`${failing}/api/sponsors`, { method: "POST" })).status, 405);
});

test("GET /api/sponsors stops at 30 requests per address in 10 minutes", async () => {
  const url = await service({ describe: () => "fake", list: async () => ({ sponsors: [] }) }, { rateLimits: true });
  const get = () => fetch(`${url}/api/sponsors`, { headers: { "X-Real-IP": "203.0.113.9" } });
  for (let i = 0; i < 30; i++) assert.equal((await get()).status, 200);
  assert.equal((await get()).status, 429);
});
