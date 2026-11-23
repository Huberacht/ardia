import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ISSUE_LABEL,
  ISSUE_MARKER,
  ISSUE_TITLE,
  RateLimited,
  checkPinConsistency,
  compare,
  compareVersions,
  fetchUpstream,
  findTrackingIssue,
  makeClient,
  parseEnvExports,
  parseIni,
  pinsFromFiles,
  planIssue,
  readPins,
  renderReport,
  stateOf,
  syncIssue,
} from "./upstream-pins.mjs";

const SCRIPT = fileURLToPath(new URL("./upstream-pins.mjs", import.meta.url));
const HC = "f32f2c066787492b9ba112dc1be1ad230b53658a";

const FILES = {
  env: [
    'export CB="${AC_CHROMIUM_BUILD:-$HOME/chromium-build}"',
    "export CHROMIUM_VERSION=158.0.8127.36",
    "export HELIUM_TAG=0.22.2",
    "export HELIUM_MACOS_TAG=0.22.2.1",
    'export HELIUM_DIR="$CB/helium"',
    "export HELIUM_LINUX_TAG=0.22.2.1",
  ].join("\n"),
  macLinuxIni: `[chromium]
version = 158.0.8127.36

[helium-chromium]
url = https://github.com/imputnet/helium-chromium.git
tag = 0.22.2
commit = ${HC}

[helium-macos]
tag = 0.22.2.1
commit = 3a89c36d8835fa94b11a57df8cc54afc1d4eec8a

[helium-linux]
tag = 0.22.2.1
commit = d77f716db31b6009e88c75ce94d5a2bf21794286
helium_chromium_commit = ${HC}
`,
  windowsIni: `[chromium]
version = 158.0.8127.36

[helium-chromium]
tag = 0.22.2
commit = ${HC}

[helium-windows]
tag = 0.22.2.1
commit = 35ea155749e86c5bca6d5c80034709b0fe762432
`,
  windowsPrebuilt: JSON.stringify({ release: "windows-engine-20261119-1", chromium: "158.0.8127.36" }),
};

const CURRENT = {
  latest: { "helium-chromium": "0.22.2", "helium-macos": "0.22.2.1", "helium-linux": "0.22.2.1", "helium-windows": "0.22.2.1" },
  heliumChromiumChromium: "158.0.8127.36",
  chromiumStable: "159.0.8154.13",
  errors: [],
};

const pins = (edit = (files) => files) => pinsFromFiles(edit({ ...FILES }));

test("ini and env.sh parsing reads the pinned values and skips derived exports", () => {
  assert.deepEqual(parseIni("[a]\nx = 1\n; note\n[b]\ny=two = three\n"), { a: { x: "1" }, b: { y: "two = three" } });
  const env = parseEnvExports(FILES.env);
  assert.equal(env.CHROMIUM_VERSION, "158.0.8127.36");
  assert.equal(env.HELIUM_MACOS_TAG, "0.22.2.1");
  assert.equal(env.CB, undefined);
  assert.equal(env.HELIUM_DIR, undefined);
});

test("version order is numeric per dotted part", () => {
  assert.equal(compareVersions("0.22.2.1", "0.22.10.1"), -1);
  assert.equal(compareVersions("158.0.8127.36", "158.0.8127.36"), 0);
  assert.equal(compareVersions("0.22.2", "0.22.2.0"), 0);
  assert.equal(compareVersions("159.0.1.0", "158.9.9999.99"), 1);
  assert.equal(stateOf("0.22.1", "0.22.2"), "behind");
  assert.equal(stateOf("0.22.3", "0.22.2"), "ahead");
  assert.equal(stateOf("0.22.2", null), "unknown");
});

test("the fixture pins agree", () => {
  assert.deepEqual(checkPinConsistency(pins()), []);
});

test("the repository's pin files agree with each other", () => {
  assert.deepEqual(checkPinConsistency(readPins()), []);
});

test("the consistency check names each file that disagrees", () => {
  const chromium = checkPinConsistency(pins((f) => ({ ...f, windowsPrebuilt: JSON.stringify({ chromium: "157.0.1.2" }) })));
  assert.equal(chromium.length, 1);
  assert.match(chromium[0], /Chromium version: scripts\/windows\/engine\/prebuilt\.json chromium is 157\.0\.1\.2/);

  const commit = checkPinConsistency(pins((f) => ({ ...f, windowsIni: f.windowsIni.replace(`commit = ${HC}`, `commit = ${"a".repeat(40)}`) })));
  assert.deepEqual(commit.length, 1);
  assert.match(commit[0], /helium-chromium commit: scripts\/windows\/engine\/helium-pins\.ini/);

  const linuxBase = checkPinConsistency(pins((f) => ({ ...f, macLinuxIni: f.macLinuxIni.replace(`helium_chromium_commit = ${HC}`, `helium_chromium_commit = ${"b".repeat(40)}`) })));
  assert.match(linuxBase.join("\n"), /helium_chromium_commit is b{40}/);

  const tag = checkPinConsistency(pins((f) => ({ ...f, env: f.env.replace("HELIUM_TAG=0.22.2", "HELIUM_TAG=0.22.3") })));
  assert.match(tag.join("\n"), /helium-chromium tag: engine\/patches\/build\/helium-pins\.ini \[helium-chromium\] tag is 0\.22\.2 but engine\/patches\/build\/env\.sh HELIUM_TAG is 0\.22\.3/);
  assert.match(tag.join("\n"), /helium-macos tag 0\.22\.2\.1 is not a release of helium-chromium 0\.22\.3/);

  const macTag = checkPinConsistency(pins((f) => ({ ...f, env: f.env.replace("HELIUM_MACOS_TAG=0.22.2.1", "HELIUM_MACOS_TAG=0.22.2.2") })));
  assert.match(macTag.join("\n"), /helium-macos tag: engine\/patches\/build\/helium-pins\.ini \[helium-macos\] tag is 0\.22\.2\.1/);

  const missing = checkPinConsistency(pins((f) => ({ ...f, windowsIni: "[chromium]\nversion = 158.0.8127.36\n" })));
  assert.ok(missing.some((problem) => problem === "scripts/windows/engine/helium-pins.ini [helium-windows] tag is missing"));
});

test("--check passes offline on the repository", () => {
  const out = execFileSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: "" } });
  assert.match(out, /the pin files agree/);
});

test("every platform is current when upstream matches the pins", () => {
  const report = compare(pins(), CURRENT);
  assert.deepEqual(report.platforms.map((p) => [p.id, p.state]), [["macos", "current"], ["linux", "current"], ["windows", "current"]]);
  assert.equal(report.behind, false);
  assert.equal(report.chromiumStable, "159.0.8154.13");
  assert.match(renderReport(report), /Summary: macOS current, Linux current, Windows current\./);
  assert.match(renderReport(report), /Chromium stable is 159\.0\.8154\.13 \(context only/);
});

test("a new platform release marks only that platform behind", () => {
  const report = compare(pins(), { ...CURRENT, latest: { ...CURRENT.latest, "helium-linux": "0.22.2.2" } });
  assert.deepEqual(report.platforms.map((p) => [p.id, p.state]), [["macos", "current"], ["linux", "behind"], ["windows", "current"]]);
  const linux = report.platforms.find((p) => p.id === "linux").parts.find((part) => part.part === "helium-linux");
  assert.deepEqual(linux, { part: "helium-linux", pinned: "0.22.2.1", upstream: "0.22.2.2", state: "behind" });
});

test("a new helium-chromium on a new Chromium puts every platform behind", () => {
  const report = compare(pins(), {
    ...CURRENT,
    latest: { "helium-chromium": "0.23.0", "helium-macos": "0.23.0.1", "helium-linux": "0.22.2.1", "helium-windows": "0.22.2.1" },
    heliumChromiumChromium: "159.0.8154.13",
  });
  assert.ok(report.platforms.every((p) => p.state === "behind"));
  assert.ok(report.platforms.every((p) => p.parts.find((part) => part.part === "chromium").state === "behind"));
  assert.equal(report.platforms.find((p) => p.id === "linux").parts.find((part) => part.part === "helium-linux").state, "current");
});

test("pins newer than the latest release read as ahead, not behind", () => {
  const report = compare(pins(), { ...CURRENT, latest: { ...CURRENT.latest, "helium-macos": "0.22.1.1" } });
  assert.equal(report.platforms.find((p) => p.id === "macos").state, "ahead");
  assert.equal(report.behind, false);
});

test("the issue is opened, updated, left alone or closed from the report", () => {
  const behind = compare(pins(), { ...CURRENT, latest: { ...CURRENT.latest, "helium-windows": "0.22.2.3" } });
  const create = planIssue(behind, null);
  assert.equal(create.action, "create");
  assert.equal(create.title, ISSUE_TITLE);
  assert.deepEqual(create.labels, [ISSUE_LABEL]);
  assert.ok(create.body.startsWith(ISSUE_MARKER));
  assert.match(create.body, /- Windows: helium-windows 0\.22\.2\.1 → 0\.22\.2\.3/);

  assert.deepEqual(planIssue(behind, { number: 9, body: create.body }), { action: "none", reason: "#9 is already up to date" });
  assert.equal(planIssue(behind, { number: 9, body: `${ISSUE_MARKER}\nold` }).action, "update");

  const current = compare(pins(), CURRENT);
  const close = planIssue(current, { number: 9, body: create.body });
  assert.equal(close.action, "close");
  assert.match(close.comment, /Every engine pin is current/);
  assert.equal(planIssue(current, null).action, "none");

  const partial = compare(pins(), { ...CURRENT, latest: { ...CURRENT.latest, "helium-macos": undefined }, errors: ["imputnet/helium-macos: HTTP 502"] });
  assert.equal(planIssue(partial, { number: 9, body: create.body }).action, "none");
});

test("the tracking issue is found by its marker among open issues, never a pull request", () => {
  const issues = [
    { number: 1, state: "open", body: "unrelated" },
    { number: 2, state: "open", body: `${ISSUE_MARKER} x`, pull_request: {} },
    { number: 3, state: "open", body: `${ISSUE_MARKER}\nbody` },
  ];
  assert.equal(findTrackingIssue(issues).number, 3);
  assert.equal(findTrackingIssue(issues.slice(0, 2)), null);
});

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
    const route = routes.find(([pattern]) => pattern.test(`${init?.method ?? "GET"} ${url}`));
    const [, status, payload, headers = {}] = route ?? [null, 404, { message: "Not Found" }];
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      json: async () => payload,
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
    };
  };
  return { impl, calls };
}

test("upstream is read from latest releases, tags when there is no release, and chromium_version.txt", async () => {
  const { impl, calls } = fakeFetch([
    [/GET .*helium-chromium\/releases\/latest$/, 200, { tag_name: "0.22.3" }],
    [/GET .*helium-macos\/releases\/latest$/, 200, { tag_name: "0.22.3.1" }],
    [/GET .*helium-linux\/releases\/latest$/, 404, {}],
    [/GET .*helium-linux\/tags/, 200, [{ name: "0.22.2.1" }, { name: "0.22.10.1" }, { name: "0.22.3.1" }]],
    [/GET .*helium-windows\/releases\/latest$/, 200, { tag_name: "0.22.2.1" }],
    [/GET .*helium-chromium\/contents\/chromium_version\.txt\?ref=0\.22\.3$/, 200, "158.0.8127.40\n"],
    [/GET https:\/\/chromiumdash/, 200, [{ version: "159.0.8154.13" }]],
  ]);
  const upstream = await fetchUpstream({ client: makeClient({ token: "t", fetchImpl: impl }), fetchImpl: impl });
  assert.deepEqual(upstream.latest, { "helium-chromium": "0.22.3", "helium-macos": "0.22.3.1", "helium-linux": "0.22.10.1", "helium-windows": "0.22.2.1" });
  assert.equal(upstream.heliumChromiumChromium, "158.0.8127.40");
  assert.equal(upstream.chromiumStable, "159.0.8154.13");
  assert.deepEqual(upstream.errors, []);
  const raw = calls.find((call) => call.url.includes("chromium_version.txt"));
  assert.ok(raw);
});

test("a rate limit stops the run instead of reading as an error", async () => {
  const { impl } = fakeFetch([[/releases\/latest$/, 403, {}, { "x-ratelimit-remaining": "0" }]]);
  await assert.rejects(fetchUpstream({ client: makeClient({ token: "t", fetchImpl: impl }), fetchImpl: impl }), RateLimited);
});

test("a failed upstream read is reported and leaves Chromium stable optional", async () => {
  const { impl } = fakeFetch([
    [/helium-chromium\/releases\/latest$/, 502, {}],
    [/helium-macos\/releases\/latest$/, 200, { tag_name: "0.22.2.1" }],
    [/helium-linux\/releases\/latest$/, 200, { tag_name: "0.22.2.1" }],
    [/helium-windows\/releases\/latest$/, 200, { tag_name: "0.22.2.1" }],
  ]);
  const upstream = await fetchUpstream({ client: makeClient({ token: "t", fetchImpl: impl }), fetchImpl: impl });
  assert.deepEqual(upstream.errors, ["imputnet/helium-chromium: GET /repos/imputnet/helium-chromium/releases/latest: HTTP 502"]);
  assert.equal(upstream.chromiumStable, null);
  const report = compare(pins(), upstream);
  assert.equal(report.unknown, true);
  assert.equal(planIssue(report, null).action, "none");
});

test("syncIssue writes nothing in a dry run and opens, then closes, the issue for real", async () => {
  const behind = compare(pins(), { ...CURRENT, latest: { ...CURRENT.latest, "helium-macos": "0.22.2.2" } });
  const quiet = () => {};

  const dry = fakeFetch([[/GET .*\/issues\?state=open&labels=todo/, 200, []]]);
  await syncIssue({ client: makeClient({ token: "t", fetchImpl: dry.impl }), repo: "o/r", report: behind, dryRun: true, log: quiet });
  assert.deepEqual(dry.calls.map((call) => call.method), ["GET"]);

  const open = fakeFetch([
    [/GET .*\/issues\?state=open&labels=todo/, 200, []],
    [/POST .*\/repos\/o\/r\/issues$/, 201, { html_url: "https://github.com/o/r/issues/5" }],
  ]);
  await syncIssue({ client: makeClient({ token: "t", fetchImpl: open.impl }), repo: "o/r", report: behind, dryRun: false, log: quiet });
  const created = open.calls.find((call) => call.method === "POST");
  assert.equal(created.body.title, ISSUE_TITLE);
  assert.deepEqual(created.body.labels, ["todo"]);

  const existing = { number: 5, state: "open", body: created.body.body };
  const close = fakeFetch([
    [/GET .*\/issues\?state=open&labels=todo/, 200, [existing]],
    [/POST .*\/issues\/5\/comments$/, 201, {}],
    [/PATCH .*\/issues\/5$/, 200, {}],
  ]);
  await syncIssue({ client: makeClient({ token: "t", fetchImpl: close.impl }), repo: "o/r", report: compare(pins(), CURRENT), dryRun: false, log: quiet });
  assert.deepEqual(close.calls.map((call) => call.method), ["GET", "POST", "PATCH"]);
  assert.deepEqual(close.calls[2].body, { state: "closed", state_reason: "completed" });
});
