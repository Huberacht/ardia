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
const SINK_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$|^localhost$/;

test("a site let through the ad blocker is listed, and blocking it again takes it off the list", async () => {
  await freshWindow();
  reset();
  assert.deepEqual(await ok("sites.adBlocker", {}), { enabled: true, allowedSites: [] });
  assert.deepEqual(await ok("sites.allowAds", { site: "AppLovin.com" }), { site: "applovin.com", adsAllowed: true, enabled: true, allowedSites: ["applovin.com"] });
  await ok("sites.allowAds", { site: "dash.ironsrc.com" });
  assert.deepEqual((await ok("sites.adBlocker", {})).allowedSites, ["applovin.com", "dash.ironsrc.com"]);
  assert.deepEqual(await ok("sites.blockAds", { site: "applovin.com" }), { site: "applovin.com", adsAllowed: false, enabled: true, allowedSites: ["dash.ironsrc.com"] });
});

test("with the ad blocker off in Settings, the socket changes no site, since unblocking one would turn it on everywhere", async () => {
  await freshWindow();
  reset();
  blocker.enabled = false;
  for (const method of ["sites.allowAds", "sites.blockAds"]) {
    const reply = await call(method, { site: "applovin.com" });
    assert.equal(reply.error?.code, "refused", method);
    assert.match(reply.error.message, /off in Settings/);
  }
  assert.deepEqual(blocker.written, []);
});

test("only a plain host name reaches the ad blocker's trusted list: every hostile input is refused before the sink", async () => {
  await freshWindow();
  reset();
  const shapes = HOSTILE_VALUES.flatMap(({ id, value }) => (typeof value === "string" ? embedded(value, "example.com", ".example.com").map((v) => ({ id, value: v })) : [{ id, value }]));
  for (const extra of ["*.example.com", "example.com/path", "https://example.com", "example.com:8080", "example.com#x", "@@||example.com^", "||example.com^", "/^(?:ardia-blocking-off|)/", "", " example.com", "exa mple.com", "exämple.com", "com"]) shapes.push({ id: `extra.${extra}`, value: extra });
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
