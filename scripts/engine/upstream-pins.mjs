#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `Compares the engine's Chromium and Helium pins with upstream and keeps one tracking issue while they are behind.

  node scripts/engine/upstream-pins.mjs                  print the report (needs GITHUB_TOKEN for the GitHub API)
  node scripts/engine/upstream-pins.mjs --json           print the report as JSON
  node scripts/engine/upstream-pins.mjs --check          check the pin files agree with each other, offline
  node scripts/engine/upstream-pins.mjs --issue          open, update or close the tracking issue in GITHUB_REPOSITORY
  node scripts/engine/upstream-pins.mjs --issue --dry-run  print what --issue would do, change nothing

Pins: engine/patches/build/env.sh, engine/patches/build/helium-pins.ini, scripts/windows/engine/helium-pins.ini and
the chromium of scripts/windows/engine/prebuilt.json. Upstream: the latest releases of imputnet/helium-chromium,
helium-macos, helium-linux and helium-windows, chromium_version.txt at the newest helium-chromium release, and
Chromium stable from chromiumdash for context.`;

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const PIN_FILES = {
  env: "engine/patches/build/env.sh",
  macLinuxIni: "engine/patches/build/helium-pins.ini",
  windowsIni: "scripts/windows/engine/helium-pins.ini",
  windowsPrebuilt: "scripts/windows/engine/prebuilt.json",
};
export const UPSTREAM_REPOS = {
  "helium-chromium": "imputnet/helium-chromium",
  "helium-macos": "imputnet/helium-macos",
  "helium-linux": "imputnet/helium-linux",
  "helium-windows": "imputnet/helium-windows",
};
export const PLATFORMS = [
  { id: "macos", name: "macOS", platformRepo: "helium-macos" },
  { id: "linux", name: "Linux", platformRepo: "helium-linux" },
  { id: "windows", name: "Windows", platformRepo: "helium-windows" },
];
export const ISSUE_TITLE = "Engine: Chromium or Helium upstream is ahead of our pins";
export const ISSUE_MARKER = "<!-- ardia-upstream-pins -->";
export const ISSUE_LABEL = "todo";
const CHROMIUM_STABLE_URL = "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=1";
const API = "https://api.github.com";

export class RateLimited extends Error {}

export function parseIni(text) {
  const sections = {};
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      section = sections[header[1].trim()] ??= {};
      continue;
    }
    const pair = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (pair && section) section[pair[1].trim()] = pair[2].trim();
  }
  return sections;
}

export function parseEnvExports(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^export ([A-Z_][A-Z0-9_]*)=("?)([^"$`]*)\2\s*$/);
    if (match) values[match[1]] = match[3];
  }
  return values;
}

export function pinsFromFiles({ env, macLinuxIni, windowsIni, windowsPrebuilt }) {
  const envValues = parseEnvExports(env);
  const macLinux = parseIni(macLinuxIni);
  const windows = parseIni(windowsIni);
  const prebuilt = JSON.parse(windowsPrebuilt);
  return {
    env: {
      chromium: envValues.CHROMIUM_VERSION,
      heliumChromium: envValues.HELIUM_TAG,
      heliumMacos: envValues.HELIUM_MACOS_TAG,
      heliumLinux: envValues.HELIUM_LINUX_TAG,
    },
    macLinuxIni: {
      chromium: macLinux.chromium?.version,
      heliumChromium: { tag: macLinux["helium-chromium"]?.tag, commit: macLinux["helium-chromium"]?.commit },
      heliumMacos: { tag: macLinux["helium-macos"]?.tag, commit: macLinux["helium-macos"]?.commit },
      heliumLinux: {
        tag: macLinux["helium-linux"]?.tag,
        commit: macLinux["helium-linux"]?.commit,
        heliumChromiumCommit: macLinux["helium-linux"]?.helium_chromium_commit,
      },
    },
    windowsIni: {
      chromium: windows.chromium?.version,
      heliumChromium: { tag: windows["helium-chromium"]?.tag, commit: windows["helium-chromium"]?.commit },
      heliumWindows: { tag: windows["helium-windows"]?.tag, commit: windows["helium-windows"]?.commit },
    },
    windowsPrebuilt: { chromium: prebuilt.chromium },
  };
}

export function readPins(root = REPO_ROOT) {
  const files = Object.fromEntries(Object.entries(PIN_FILES).map(([key, path]) => [key, readFileSync(join(root, path), "utf8")]));
  return pinsFromFiles(files);
}

export function checkPinConsistency(pins) {
  const problems = [];
  const required = [
    [`${PIN_FILES.env} CHROMIUM_VERSION`, pins.env.chromium],
    [`${PIN_FILES.env} HELIUM_TAG`, pins.env.heliumChromium],
    [`${PIN_FILES.env} HELIUM_MACOS_TAG`, pins.env.heliumMacos],
    [`${PIN_FILES.env} HELIUM_LINUX_TAG`, pins.env.heliumLinux],
    [`${PIN_FILES.macLinuxIni} [chromium] version`, pins.macLinuxIni.chromium],
    [`${PIN_FILES.macLinuxIni} [helium-chromium] tag`, pins.macLinuxIni.heliumChromium.tag],
    [`${PIN_FILES.macLinuxIni} [helium-chromium] commit`, pins.macLinuxIni.heliumChromium.commit],
    [`${PIN_FILES.macLinuxIni} [helium-macos] tag`, pins.macLinuxIni.heliumMacos.tag],
    [`${PIN_FILES.macLinuxIni} [helium-macos] commit`, pins.macLinuxIni.heliumMacos.commit],
    [`${PIN_FILES.macLinuxIni} [helium-linux] tag`, pins.macLinuxIni.heliumLinux.tag],
    [`${PIN_FILES.macLinuxIni} [helium-linux] commit`, pins.macLinuxIni.heliumLinux.commit],
    [`${PIN_FILES.macLinuxIni} [helium-linux] helium_chromium_commit`, pins.macLinuxIni.heliumLinux.heliumChromiumCommit],
    [`${PIN_FILES.windowsIni} [chromium] version`, pins.windowsIni.chromium],
    [`${PIN_FILES.windowsIni} [helium-chromium] tag`, pins.windowsIni.heliumChromium.tag],
    [`${PIN_FILES.windowsIni} [helium-chromium] commit`, pins.windowsIni.heliumChromium.commit],
    [`${PIN_FILES.windowsIni} [helium-windows] tag`, pins.windowsIni.heliumWindows.tag],
    [`${PIN_FILES.windowsIni} [helium-windows] commit`, pins.windowsIni.heliumWindows.commit],
    [`${PIN_FILES.windowsPrebuilt} chromium`, pins.windowsPrebuilt.chromium],
  ];
  for (const [where, value] of required) if (!value) problems.push(`${where} is missing`);
  if (problems.length) return problems;

  const agree = (what, entries) => {
    const [first, ...rest] = entries;
    for (const [where, value] of rest) {
      if (value !== first[1]) problems.push(`${what}: ${where} is ${value} but ${first[0]} is ${first[1]}`);
    }
  };
  agree("Chromium version", [
    [`${PIN_FILES.env} CHROMIUM_VERSION`, pins.env.chromium],
    [`${PIN_FILES.macLinuxIni} [chromium] version`, pins.macLinuxIni.chromium],
    [`${PIN_FILES.windowsIni} [chromium] version`, pins.windowsIni.chromium],
    [`${PIN_FILES.windowsPrebuilt} chromium`, pins.windowsPrebuilt.chromium],
  ]);
  agree("helium-chromium tag", [
    [`${PIN_FILES.env} HELIUM_TAG`, pins.env.heliumChromium],
    [`${PIN_FILES.macLinuxIni} [helium-chromium] tag`, pins.macLinuxIni.heliumChromium.tag],
    [`${PIN_FILES.windowsIni} [helium-chromium] tag`, pins.windowsIni.heliumChromium.tag],
  ]);
  agree("helium-chromium commit", [
    [`${PIN_FILES.macLinuxIni} [helium-chromium] commit`, pins.macLinuxIni.heliumChromium.commit],
    [`${PIN_FILES.macLinuxIni} [helium-linux] helium_chromium_commit`, pins.macLinuxIni.heliumLinux.heliumChromiumCommit],
    [`${PIN_FILES.windowsIni} [helium-chromium] commit`, pins.windowsIni.heliumChromium.commit],
  ]);
  agree("helium-macos tag", [
    [`${PIN_FILES.env} HELIUM_MACOS_TAG`, pins.env.heliumMacos],
    [`${PIN_FILES.macLinuxIni} [helium-macos] tag`, pins.macLinuxIni.heliumMacos.tag],
  ]);
  agree("helium-linux tag", [
    [`${PIN_FILES.env} HELIUM_LINUX_TAG`, pins.env.heliumLinux],
    [`${PIN_FILES.macLinuxIni} [helium-linux] tag`, pins.macLinuxIni.heliumLinux.tag],
  ]);
  for (const [name, tag] of [
    ["helium-macos", pins.macLinuxIni.heliumMacos.tag],
    ["helium-linux", pins.macLinuxIni.heliumLinux.tag],
    ["helium-windows", pins.windowsIni.heliumWindows.tag],
  ]) {
    if (!tag.startsWith(`${pins.env.heliumChromium}.`)) {
      problems.push(`${name} tag ${tag} is not a release of helium-chromium ${pins.env.heliumChromium} (expected ${pins.env.heliumChromium}.<n>)`);
    }
  }
  for (const [where, commit] of [
    [`${PIN_FILES.macLinuxIni} [helium-chromium] commit`, pins.macLinuxIni.heliumChromium.commit],
    [`${PIN_FILES.macLinuxIni} [helium-macos] commit`, pins.macLinuxIni.heliumMacos.commit],
    [`${PIN_FILES.macLinuxIni} [helium-linux] commit`, pins.macLinuxIni.heliumLinux.commit],
    [`${PIN_FILES.windowsIni} [helium-windows] commit`, pins.windowsIni.heliumWindows.commit],
  ]) {
    if (!/^[0-9a-f]{40}$/.test(commit)) problems.push(`${where} ${commit} is not a full commit hash`);
  }
  return problems;
}

export function compareVersions(a, b) {
  const left = String(a).replace(/^v/, "").split(".");
  const right = String(b).replace(/^v/, "").split(".");
  for (let at = 0; at < Math.max(left.length, right.length); at++) {
    const x = left[at] ?? "0";
    const y = right[at] ?? "0";
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function stateOf(pinned, upstream) {
  if (!pinned || !upstream) return "unknown";
  const order = compareVersions(pinned, upstream);
  return order === 0 ? "current" : order < 0 ? "behind" : "ahead";
}

const WORST = ["behind", "unknown", "ahead", "current"];

export function compare(pins, upstream) {
  const platformPins = {
    macos: { chromium: pins.env.chromium, "helium-chromium": pins.env.heliumChromium, "helium-macos": pins.env.heliumMacos },
    linux: { chromium: pins.env.chromium, "helium-chromium": pins.env.heliumChromium, "helium-linux": pins.env.heliumLinux },
    windows: {
      chromium: pins.windowsIni.chromium,
      "helium-chromium": pins.windowsIni.heliumChromium.tag,
      "helium-windows": pins.windowsIni.heliumWindows.tag,
    },
  };
  const platforms = PLATFORMS.map(({ id, name, platformRepo }) => {
    const parts = ["helium-chromium", platformRepo, "chromium"].map((part) => {
      const pinned = platformPins[id][part];
      const latest = part === "chromium" ? upstream.heliumChromiumChromium : upstream.latest[part];
      return { part, pinned, upstream: latest ?? null, state: stateOf(pinned, latest) };
    });
    const state = WORST.find((candidate) => parts.some((part) => part.state === candidate)) ?? "current";
    return { id, name, state, parts };
  });
  const behind = platforms.some((platform) => platform.state === "behind");
  const unknown = platforms.some((platform) => platform.state === "unknown");
  return {
    platforms,
    behind,
    unknown,
    chromiumStable: upstream.chromiumStable ?? null,
    heliumChromiumTag: upstream.latest["helium-chromium"] ?? null,
    errors: upstream.errors ?? [],
  };
}

const PART_LABELS = {
  chromium: "Chromium (helium-chromium's chromium_version.txt)",
  "helium-chromium": "helium-chromium",
  "helium-macos": "helium-macos",
  "helium-linux": "helium-linux",
  "helium-windows": "helium-windows",
};

export function renderReport(report) {
  const lines = ["| Platform | Pin | Ours | Upstream | State |", "| --- | --- | --- | --- | --- |"];
  for (const platform of report.platforms) {
    for (const part of platform.parts) {
      lines.push(`| ${platform.name} | ${PART_LABELS[part.part]} | ${part.pinned ?? "?"} | ${part.upstream ?? "?"} | ${part.state} |`);
    }
  }
  const summary = report.platforms.map((platform) => `${platform.name} ${platform.state}`).join(", ");
  const out = [`Summary: ${summary}.`, "", ...lines, ""];
  if (report.chromiumStable) {
    out.push(`Chromium stable is ${report.chromiumStable} (context only; Helium decides which Chromium we can take).`);
  }
  for (const error of report.errors) out.push(`Could not read: ${error}`);
  return out.join("\n").trimEnd();
}

export function renderIssueBody(report) {
  const behind = report.platforms
    .filter((platform) => platform.state === "behind")
    .flatMap((platform) => platform.parts.filter((part) => part.state === "behind").map((part) => `- ${platform.name}: ${PART_LABELS[part.part]} ${part.pinned} → ${part.upstream}`));
  return [
    ISSUE_MARKER,
    "Upstream has moved past the engine's pins. The weekly Upstream pins workflow keeps this issue up to date and closes it once every pin is current.",
    "",
    "Behind:",
    ...behind,
    "",
    renderReport(report),
    "",
    "To catch up, bump the pins together (engine/patches/build/env.sh, both helium-pins.ini files and, after the Windows engine is published, scripts/windows/engine/prebuilt.json) as described in docs/engine-build.md, “Tracking upstream”.",
  ].join("\n");
}

export function renderCloseComment(report) {
  return ["Every engine pin is current with upstream again, so this is done.", "", renderReport(report)].join("\n");
}

export function planIssue(report, openIssue) {
  if (report.unknown || report.errors.length) return { action: "none", reason: "upstream could not be read completely, so the issue is left alone" };
  if (report.behind) {
    const body = renderIssueBody(report);
    if (!openIssue) return { action: "create", title: ISSUE_TITLE, body, labels: [ISSUE_LABEL] };
    if ((openIssue.body ?? "").replace(/\r\n/g, "\n") === body) return { action: "none", reason: `#${openIssue.number} is already up to date` };
    return { action: "update", number: openIssue.number, body };
  }
  if (openIssue) return { action: "close", number: openIssue.number, comment: renderCloseComment(report) };
  return { action: "none", reason: "every pin is current and no tracking issue is open" };
}

export function findTrackingIssue(issues) {
  return issues.find((issue) => !issue.pull_request && issue.state === "open" && (issue.body ?? "").includes(ISSUE_MARKER)) ?? null;
}

export function makeClient({ token, fetchImpl = globalThis.fetch }) {
  async function request(method, path, { body, accept = "application/vnd.github+json", allowNotFound = false } = {}) {
    const response = await fetchImpl(path.startsWith("http") ? path : `${API}${path}`, {
      method,
      headers: {
        accept,
        "x-github-api-version": "2022-11-28",
        "user-agent": "ardia-upstream-pins",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (allowNotFound && response.status === 404) return null;
    if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
      throw new RateLimited(`GitHub API rate limit reached on ${method} ${path}`);
    }
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
    if (response.status === 204) return null;
    return accept.endsWith(".raw") ? response.text() : response.json();
  }
  return { request };
}

async function latestTag(client, repo) {
  const release = await client.request("GET", `/repos/${repo}/releases/latest`, { allowNotFound: true });
  if (release?.tag_name) return release.tag_name;
  const tags = await client.request("GET", `/repos/${repo}/tags?per_page=100`);
  return tags.map((tag) => tag.name).sort(compareVersions).at(-1) ?? null;
}

export async function fetchUpstream({ client, fetchImpl = globalThis.fetch }) {
  const latest = {};
  const errors = [];
  await Promise.all(
    Object.entries(UPSTREAM_REPOS).map(async ([part, repo]) => {
      try {
        latest[part] = await latestTag(client, repo);
      } catch (error) {
        if (error instanceof RateLimited) throw error;
        errors.push(`${repo}: ${error.message}`);
      }
    }),
  );
  let heliumChromiumChromium = null;
  if (latest["helium-chromium"]) {
    try {
      const text = await client.request(
        "GET",
        `/repos/${UPSTREAM_REPOS["helium-chromium"]}/contents/chromium_version.txt?ref=${encodeURIComponent(latest["helium-chromium"])}`,
        { accept: "application/vnd.github.raw" },
      );
      heliumChromiumChromium = text.trim();
    } catch (error) {
      if (error instanceof RateLimited) throw error;
      errors.push(`chromium_version.txt at helium-chromium ${latest["helium-chromium"]}: ${error.message}`);
    }
  }
  let chromiumStable = null;
  try {
    const response = await fetchImpl(CHROMIUM_STABLE_URL, { headers: { "user-agent": "ardia-upstream-pins" } });
    if (response.ok) chromiumStable = (await response.json())[0]?.version ?? null;
  } catch {
    chromiumStable = null;
  }
  return { latest, heliumChromiumChromium, chromiumStable, errors };
}

async function listOpenLabelled(client, repo) {
  const issues = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await client.request("GET", `/repos/${repo}/issues?state=open&labels=${ISSUE_LABEL}&per_page=100&page=${page}`);
    issues.push(...batch);
    if (batch.length < 100) break;
  }
  return issues;
}

export async function syncIssue({ client, repo, report, dryRun, log = console.log }) {
  const open = findTrackingIssue(await listOpenLabelled(client, repo));
  const plan = planIssue(report, open);
  const prefix = dryRun ? "[dry run] would " : "";
  if (plan.action === "none") {
    log(`Tracking issue: nothing to do (${plan.reason}).`);
    return plan;
  }
  if (plan.action === "create") {
    log(`Tracking issue: ${prefix}open "${plan.title}" labelled ${plan.labels.join(", ")}.`);
    if (!dryRun) {
      const created = await client.request("POST", `/repos/${repo}/issues`, { body: { title: plan.title, body: plan.body, labels: plan.labels } });
      log(`Opened ${created.html_url}`);
    }
  } else if (plan.action === "update") {
    log(`Tracking issue: ${prefix}update #${plan.number}.`);
    if (!dryRun) await client.request("PATCH", `/repos/${repo}/issues/${plan.number}`, { body: { body: plan.body } });
  } else if (plan.action === "close") {
    log(`Tracking issue: ${prefix}comment on and close #${plan.number}.`);
    if (!dryRun) {
      await client.request("POST", `/repos/${repo}/issues/${plan.number}/comments`, { body: { body: plan.comment } });
      await client.request("PATCH", `/repos/${repo}/issues/${plan.number}`, { body: { state: "closed", state_reason: "completed" } });
    }
  }
  return plan;
}

async function main(argv) {
  const args = new Set(argv);
  if (args.has("-h") || args.has("--help")) {
    console.log(HELP);
    return 0;
  }
  const pins = readPins();
  const problems = checkPinConsistency(pins);
  if (args.has("--check")) {
    if (problems.length) {
      for (const problem of problems) console.error(`upstream-pins: ${problem}`);
      return 1;
    }
    console.log("upstream-pins: the pin files agree");
    return 0;
  }
  for (const problem of problems) console.error(`upstream-pins: warning: ${problem}`);
  const client = makeClient({ token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN });
  try {
    const report = compare(pins, await fetchUpstream({ client }));
    if (args.has("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const text = renderReport(report);
      console.log(text);
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Upstream pins\n\n${text}\n`);
      }
    }
    if (args.has("--issue")) {
      const repo = process.env.GITHUB_REPOSITORY;
      if (!repo) throw new Error("--issue needs GITHUB_REPOSITORY (owner/name)");
      await syncIssue({ client, repo, report, dryRun: args.has("--dry-run") || process.env.DRY_RUN === "true" });
    }
    return report.errors.length ? 1 : 0;
  } catch (error) {
    if (error instanceof RateLimited) {
      console.log(`::notice::${error.message}; stopping without changes, the next run picks it up`);
      return 0;
    }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
