import assert from "node:assert/strict";
import { test } from "node:test";
const { readManifest } = await import("../../lib/pluginManifest.ts");
const { updateWithin, UPDATE_PROMPT_REASONS } = await import("./officialUpdate.ts");

const parse = (doc) => {
  const read = readManifest(JSON.stringify(doc));
  assert.deepEqual(read.problems, [], JSON.stringify(doc));
  return read.manifest;
};

const AFTER_UPDATE = [["skills", "install", "--auto"], ["skills", "refresh"], ["computer", "refresh"]];
const CLI_040 = {
  manifest: 1, name: "cli", title: "Command Line", description: "Drive Ardia from your terminal or an agent.", version: "0.4.0", icon: "terminal.fill",
  alwaysOn: true, official: true, permissions: ["control"], programs: [{ name: "ardia", path: "bin/ardia", afterUpdate: AFTER_UPDATE }],
};
const CLI_060 = {
  manifest: 2, name: "cli", title: "Command Line", description: "Drive Ardia from your terminal or an agent.", version: "0.6.0", requires: "0.2.48", icon: "terminal.fill",
  keywords: ["command line", "terminal"], alwaysOn: true, official: true, main: "dist/main.js", permissions: { control: true },
  contributes: {
    commands: [{ name: "show-status", title: "Command Line: Show Status", icon: "terminal", view: "status", keywords: ["ardia"] }],
    programs: [{ name: "ardia", path: "bin/ardia", claim: true, example: "ardia tabs", afterUpdate: AFTER_UPDATE }],
  },
  telemetry: { title: "The ardia command", items: ["Each command's name"] },
};
const v2 = (version, extra = {}, contributes = {}) => ({ ...CLI_060, version, ...extra, contributes: { ...CLI_060.contributes, ...contributes } });

test("an equal manifest under a new version, description, keywords and telemetry text passes, with nothing new to tell", () => {
  const verdict = updateWithin(parse(CLI_060), parse(v2("0.7.0", { description: "Changed words.", keywords: ["other"], telemetry: { title: "x", items: ["y"] } })));
  assert.deepEqual(verdict, { ok: true, added: [] });
});

test("the Python CLI 0.4.0 to 0.6.0: same permissions, so it passes, and the note lists what's new (an on-demand sandboxed view and a command-bar entry)", () => {
  const verdict = updateWithin(parse(CLI_040), parse(CLI_060));
  assert.equal(verdict.ok, true);
  assert.ok(verdict.added.some((line) => line.includes("Adds to the command bar: Command Line: Show Status")), verdict.added.join("\n"));
  assert.ok(verdict.added.some((line) => line.startsWith("Runs its code in Ardia's plugin sandbox, starting the first time you use it")), verdict.added.join("\n"));
  assert.ok(!verdict.added.some((line) => line.includes("PATH")), "PATH lines were already approved");
});

test("narrower passes: dropping control, a program, an after-update action or a network host", () => {
  const wide = parse(v2("0.6.0", { permissions: { control: true, network: ["api.example.com", "*.example.org"], tabs: "write" } }));
  assert.equal(updateWithin(wide, parse(v2("0.7.0", { permissions: { network: ["a.example.org"], tabs: "read" } }))).ok, true);
  assert.equal(updateWithin(wide, parse(v2("0.7.0", { permissions: { control: true } }, { programs: [] }))).ok, true);
  assert.equal(updateWithin(wide, parse(v2("0.7.0", { permissions: { control: true } }, { programs: [{ name: "ardia", path: "bin/ardia", claim: true, afterUpdate: [["skills", "refresh"]] }] }))).ok, true);
  assert.equal(updateWithin(parse(v2("0.6.0", { permissions: { control: true, network: "*" } })), parse(v2("0.7.0", { permissions: { control: true, network: ["x.example.com"] } }))).ok, true);
});

test("reordered lists compare as sets: after-update actions, hosts, keywords", () => {
  const a = parse(v2("0.6.0", { permissions: { control: true, network: ["a.example.com", "b.example.com"] } }));
  const b = parse(v2("0.7.0", { permissions: { control: true, network: ["b.example.com", "a.example.com"] } }, { programs: [{ name: "ardia", path: "bin/ardia", claim: true, afterUpdate: [...AFTER_UPDATE].reverse() }] }));
  assert.deepEqual(updateWithin(a, b), { ok: true, added: updateWithin(a, b).added });
  assert.equal(updateWithin(a, b).ok, true);
});

const broader = [
  ["a new permission", v2("0.7.0", { permissions: { control: true, storage: true } }), "permissions"],
  ["tabs read to write", v2("0.7.0", { permissions: { control: true, tabs: "write" } }), "permissions", { permissions: { control: true, tabs: "read" } }],
  ["no network to a host", v2("0.7.0", { permissions: { control: true, network: ["api.example.com"] } }), "network"],
  ["a host to every site", v2("0.7.0", { permissions: { control: true, network: "*" } }), "network", { permissions: { control: true, network: ["api.example.com"] } }],
  ["a host outside the approved pattern", v2("0.7.0", { permissions: { control: true, network: ["evil.example.net"] } }), "network", { permissions: { control: true, network: ["*.example.com"] } }],
  ["a new program on PATH", v2("0.7.0", {}, { programs: [...CLI_060.contributes.programs, { name: "ardia-helper", path: "bin/h" }] }), "programs"],
  ["a new after-update action", v2("0.7.0", {}, { programs: [{ name: "ardia", path: "bin/ardia", claim: true, afterUpdate: [...AFTER_UPDATE, ["daemon", "start"]] }] }), "programs"],
  ["a new hook", v2("0.7.0", { activationEvents: ["onStartupFinished"] }, { hooks: ["tab.created"] }), "hooks", { activationEvents: ["onStartupFinished"] }],
  ["a new hook that would also start it in the background", v2("0.7.0", {}, { hooks: ["tab.created"] }), "activation"],
  ["code that starts in the background", v2("0.7.0", { activationEvents: ["onStartupFinished"] }), "activation"],
  ["a URL activation", v2("0.7.0", { activationEvents: ["onUrl:example.com"] }), "activation"],
  ["a settings default it writes", v2("0.7.0", {}, { settings: { defaults: { cliControl: true } } }), "settings"],
  ["a new toolbar button", v2("0.7.0", {}, { toolbar: [{ id: "status", title: "Status", icon: "terminal", command: "show-status" }] }), "contributions"],
  ["a new tool offered to other programs", v2("0.7.0", {}, { tools: [{ name: "peek", title: "Peek", description: "d" }] }), "contributions"],
];

for (const [what, next, reason, base] of broader) {
  test(`broader prompts: ${what}`, () => {
    const verdict = updateWithin(parse(base ? v2("0.6.0", base) : CLI_060), parse(next));
    assert.deepEqual(verdict, { ok: false, reason });
  });
}

test("a sidecar that wasn't approved, or a changed sidecar command, prompts", () => {
  const plain = { manifest: 2, name: "cli", title: "Command Line", version: "0.6.0", official: true, permissions: { control: true } };
  assert.deepEqual(updateWithin(parse(plain), parse({ ...plain, version: "0.7.0", sidecar: { run: ["bin/daemon"] } })), { ok: false, reason: "runtime" });
  assert.deepEqual(updateWithin(parse({ ...plain, sidecar: { run: ["bin/daemon"] } }), parse({ ...plain, version: "0.7.0", sidecar: { run: ["bin/daemon", "--listen"] } })), { ok: false, reason: "runtime" });
  assert.equal(updateWithin(parse({ ...plain, sidecar: { run: ["bin/daemon"] } }), parse({ ...plain, version: "0.7.0", sidecar: { run: ["bin/daemon"] } })).ok, true);
});

test("a new main that would start by itself prompts, an on-demand one doesn't", () => {
  assert.deepEqual(updateWithin(parse(CLI_040), parse(v2("0.6.0", { activationEvents: ["*"] }))), { ok: false, reason: "activation" });
  assert.equal(updateWithin(parse(CLI_040), parse(v2("0.6.0", { activationEvents: ["onCommand:show-status"] }))).ok, true);
});

test("a field the comparison doesn't know prompts: unknown manifest, permission and contribution keys", () => {
  const a = parse(CLI_060);
  assert.deepEqual(updateWithin(a, { ...parse(v2("0.7.0")), futureGrant: true }), { ok: false, reason: "unknown" });
  assert.deepEqual(updateWithin(a, { ...parse(v2("0.7.0")), permissions: { ...a.permissions, camera: true } }), { ok: false, reason: "unknown" });
  const next = parse(v2("0.7.0"));
  assert.deepEqual(updateWithin(a, { ...next, contributes: { ...next.contributes, keybindings: [] } }), { ok: false, reason: "unknown" });
  assert.deepEqual(updateWithin({ ...a, oldOnly: 1 }, next), { ok: false, reason: "unknown" });
  assert.deepEqual(updateWithin(a, { ...next, activationEvents: ["onSomethingNew:x"] }), { ok: false, reason: "unknown" });
});

test("a different name or a manifest not marked official never passes", () => {
  assert.deepEqual(updateWithin(parse(CLI_060), parse({ ...v2("0.7.0"), name: "clj" })), { ok: false, reason: "baseline" });
  const { official: _official, alwaysOn: _alwaysOn, ...unofficial } = v2("0.7.0");
  assert.deepEqual(updateWithin(parse(CLI_060), parse(unofficial)), { ok: false, reason: "baseline" });
});

test("every prompt reason has a name the telemetry counts use", () => {
  assert.deepEqual([...UPDATE_PROMPT_REASONS].sort(), ["activation", "baseline", "contributions", "hooks", "network", "permissions", "programs", "runtime", "settings", "unknown"]);
});
