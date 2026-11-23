import assert from "node:assert/strict";
import { after, test } from "node:test";
import { embedded, HOSTILE_VALUES, LINE_TERMINATORS } from "../../../../../scripts/security/hostile-inputs.mjs";
const { S, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const stub = await import("../../test-native/index.ts");

const blocker = stub.contentBlockerSites;
const reset = () => {
  blocker.enabled = true;
  blocker.allowed.clear();
  blocker.written.length = 0;
};

after(() => {
  reset();
  S().updateSettings({ cliControl: false });
});

const { call, ok } = socketClient(321);
const SINK_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

test("a site added to the ad blocker's trusted list is listed, and taking it out removes only that entry", async () => {
  await freshWindow();
  reset();
  assert.deepEqual(await ok("sites.adBlocker", {}), { enabled: true, allowedSites: [] });
  assert.deepEqual(await ok("sites.allowAds", { site: "WWW.AppLovin.com" }), { site: "www.applovin.com", trusted: true, enabled: true, allowedSites: ["www.applovin.com"] });
  await ok("sites.allowAds", { site: "dash.ironsrc.com" });
  assert.deepEqual((await ok("sites.adBlocker", {})).allowedSites, ["dash.ironsrc.com", "www.applovin.com"]);
  assert.deepEqual(await ok("sites.blockAds", { site: "www.applovin.com" }), { site: "www.applovin.com", trusted: false, enabled: true, allowedSites: ["dash.ironsrc.com"] });
});

test("blockAds takes out only an entry the list shows, and names the broader entry that covers a site", async () => {
  await freshWindow();
  reset();
  await ok("sites.allowAds", { site: "applovin.com" });
  blocker.written.length = 0;
  const covered = await call("sites.blockAds", { site: "www.applovin.com" });
  assert.equal(covered.error?.code, "refused");
  assert.match(covered.error.message, /applovin\.com is, and covers it/);
  assert.equal((await call("sites.blockAds", { site: "other.example" })).error?.code, "refused");
  assert.deepEqual(blocker.written, [], "nothing reached the blocker");
});

test("a public suffix, IP address or name outside the public registries is refused, since it would trust sites run by others", async () => {
  await freshWindow();
  reset();
  for (const site of ["co.uk", "github.io", "com", "0.1", "127.0.0.1", "192.168.0.1", "intranet.corp", "localhost"]) {
    const reply = await call("sites.allowAds", { site });
    assert.equal(reply.error?.code, "bad_request", site);
  }
  for (const site of ["user.github.io", "shop.co.uk", "example.com"]) await ok("sites.allowAds", { site });
  assert.deepEqual(blocker.written, ["user.github.io", "shop.co.uk", "example.com"]);
});

test("with the ad blocker off in Settings, the trusted list still changes and the answer says it's off", async () => {
  await freshWindow();
  reset();
  blocker.enabled = false;
  assert.deepEqual(await ok("sites.allowAds", { site: "applovin.com" }), { site: "applovin.com", trusted: true, enabled: false, allowedSites: ["applovin.com"] });
});

test("only a plain host name reaches the ad blocker's trusted list: every hostile input is refused before the sink", async () => {
  await freshWindow();
  reset();
  const shapes = HOSTILE_VALUES.flatMap(({ id, value }) => (typeof value === "string" ? embedded(value, "example.com", ".example.com").map((v) => ({ id, value: v })) : [{ id, value }]));
  for (const extra of ["*.example.com", "example.com/path", "https://example.com", "example.com:8080", "example.com#x", "@@||example.com^", "||example.com^", "/^(?:ardia-blocking-off|)/", "", " example.com", "exa mple.com", "exämple.com", "com", "example.com."]) shapes.push({ id: `extra.${extra}`, value: extra });
  for (const { id, value } of shapes) {
    const reply = await call("sites.allowAds", { site: value });
    if (reply.error) continue;
    assert.equal(typeof value, "string", id);
  }
  assert.ok(blocker.written.length > 0, "some shapes are plain hosts once lowercased");
  for (const host of blocker.written) {
    assert.ok(!LINE_TERMINATORS.test(host), `a line break reached the sink: ${JSON.stringify(host)}`);
    assert.match(host, SINK_HOST, `the sink got ${JSON.stringify(host)}`);
  }
});
