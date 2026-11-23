#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `Compares the engine's Chromium and Helium pins with upstream and keeps one tracking issue while they are behind.

  node scripts/engine/upstream-pins.mjs                    print the report (needs GITHUB_TOKEN for the GitHub API)
  node scripts/engine/upstream-pins.mjs --json             print the report as JSON
  node scripts/engine/upstream-pins.mjs --check            check the pin files agree with each other, offline
  node scripts/engine/upstream-pins.mjs --issue            open, update, reopen or close the tracking issue in
                                                           GITHUB_REPOSITORY
  node scripts/engine/upstream-pins.mjs --issue --dry-run  print what --issue would do, change nothing

Pins: engine/patches/build/env.sh, engine/patches/build/helium-pins.ini, scripts/windows/engine/helium-pins.ini and
scripts/windows/engine/prebuilt.json, whose source commit's helium-pins.ini says which Helium the published Windows
engine was built from. Upstream: the latest releases of imputnet/helium-chromium, helium-macos, helium-linux and
helium-windows, chromium_version.txt at the newest helium-chromium release, and Chromium stable from chromiumdash for
context. A run that can't read all of it exits 1 and changes no issue; a GitHub rate limit stops it cleanly.`;

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
export const CLOSE_MARKER = "<!-- ardia-upstream-pins:closed -->";
export const REOPEN_MARKER = "<!-- ardia-upstream-pins:reopened -->";
export const ISSUE_LABEL = "todo";
export const MAX_ISSUE_PAGES = 200;
const DEFAULT_REPOSITORY = "ardia-browser/ardia";
const CHROMIUM_STABLE_URL = "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=1";
const API = "https://api.github.com";
const VERSION = /^\d+(?:\.\d+)+$/;
const COMMIT = /^[0-9a-f]{40}$/;

export class RateLimited extends Error {}

export const isVersion = (value) => typeof value === "string" && VERSION.test(value);

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

export function windowsIniPins(text) {
  const windows = parseIni(text);
  return {
    chromium: windows.chromium?.version,
    heliumChromium: { tag: windows["helium-chromium"]?.tag, commit: windows["helium-chromium"]?.commit },
    heliumWindows: { tag: windows["helium-windows"]?.tag, commit: windows["helium-windows"]?.commit },
  };
}

export function pinsFromFiles({ env, macLinuxIni, windowsIni, windowsPrebuilt }) {
  const envValues = parseEnvExports(env);
  const macLinux = parseIni(macLinuxIni);
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
    windowsIni: windowsIniPins(windowsIni),
    windowsPrebuilt: { chromium: prebuilt.chromium, source: prebuilt.source },
  };
}

export function readPins(root = REPO_ROOT) {
  const files = Object.fromEntries(Object.entries(PIN_FILES).map(([key, path]) => [key, readFileSync(join(root, path), "utf8")]));
  return pinsFromFiles(files);
}

export function checkPinConsistency(pins) {
  const problems = [];
  const versions = [
    [`${PIN_FILES.env} CHROMIUM_VERSION`, pins.env.chromium],
    [`${PIN_FILES.env} HELIUM_TAG`, pins.env.heliumChromium],
    [`${PIN_FILES.env} HELIUM_MACOS_TAG`, pins.env.heliumMacos],
    [`${PIN_FILES.env} HELIUM_LINUX_TAG`, pins.env.heliumLinux],
    [`${PIN_FILES.macLinuxIni} [chromium] version`, pins.macLinuxIni.chromium],
    [`${PIN_FILES.macLinuxIni} [helium-chromium] tag`, pins.macLinuxIni.heliumChromium.tag],
    [`${PIN_FILES.macLinuxIni} [helium-macos] tag`, pins.macLinuxIni.heliumMacos.tag],
    [`${PIN_FILES.macLinuxIni} [helium-linux] tag`, pins.macLinuxIni.heliumLinux.tag],
    [`${PIN_FILES.windowsIni} [chromium] version`, pins.windowsIni.chromium],
    [`${PIN_FILES.windowsIni} [helium-chromium] tag`, pins.windowsIni.heliumChromium.tag],
    [`${PIN_FILES.windowsIni} [helium-windows] tag`, pins.windowsIni.heliumWindows.tag],
    [`${PIN_FILES.windowsPrebuilt} chromium`, pins.windowsPrebuilt.chromium],
  ];
  const commits = [
    [`${PIN_FILES.macLinuxIni} [helium-chromium] commit`, pins.macLinuxIni.heliumChromium.commit],
    [`${PIN_FILES.macLinuxIni} [helium-macos] commit`, pins.macLinuxIni.heliumMacos.commit],
    [`${PIN_FILES.macLinuxIni} [helium-linux] commit`, pins.macLinuxIni.heliumLinux.commit],
    [`${PIN_FILES.macLinuxIni} [helium-linux] helium_chromium_commit`, pins.macLinuxIni.heliumLinux.heliumChromiumCommit],
    [`${PIN_FILES.windowsIni} [helium-chromium] commit`, pins.windowsIni.heliumChromium.commit],
    [`${PIN_FILES.windowsIni} [helium-windows] commit`, pins.windowsIni.heliumWindows.commit],
    [`${PIN_FILES.windowsPrebuilt} source`, pins.windowsPrebuilt.source],
  ];
  for (const [where, value] of [...versions, ...commits]) if (!value) problems.push(`${where} is missing`);
  if (problems.length) return problems;
  for (const [where, value] of versions) {
    if (!isVersion(value)) problems.push(`${where} ${value} is not a dotted numeric version`);
  }
  for (const [where, value] of commits) {
    if (!COMMIT.test(value)) problems.push(`${where} ${value} is not a full commit hash`);
  }
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
  return problems;
}

export function compareVersions(a, b) {
  const left = String(a).split(".").map(Number);
  const right = String(b).split(".").map(Number);
  for (let at = 0; at < Math.max(left.length, right.length); at++) {
    const x = left[at] ?? 0;
    const y = right[at] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function stateOf(pinned, upstream) {
  if (!isVersion(pinned) || !isVersion(upstream)) return "unknown";
  const order = compareVersions(pinned, upstream);
  return order === 0 ? "current" : order < 0 ? "behind" : "ahead";
}

const WORST = ["unknown", "behind", "ahead", "current"];

function newestOf(...versions) {
  if (!versions.every(isVersion)) return null;
  return [...versions].sort(compareVersions).at(-1);
}

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
      const pinned = platformPins[id][part] ?? null;
      const latest = (part === "chromium" ? upstream.heliumChromiumChromium : upstream.latest[part]) ?? null;
      return { part, pinned, upstream: latest, state: stateOf(pinned, latest) };
    });
    if (id === "windows") {
      const pinned = upstream.prebuilt?.heliumWindows ?? null;
      const target = newestOf(platformPins.windows["helium-windows"], upstream.latest["helium-windows"]);
      parts.push({ part: "windows-prebuilt", pinned, upstream: target, state: stateOf(pinned, target) });
    }
    const state = WORST.find((candidate) => parts.some((part) => part.state === candidate)) ?? "current";
    return { id, name, state, parts };
  });
  const parts = platforms.flatMap((platform) => platform.parts);
  const errors = upstream.errors ?? [];
  return {
    platforms,
    complete: errors.length === 0 && parts.every((part) => part.state !== "unknown"),
    behind: parts.some((part) => part.state === "behind"),
    ahead: parts.some((part) => part.state === "ahead"),
    chromiumStable: upstream.chromiumStable ?? null,
    heliumChromiumTag: upstream.latest["helium-chromium"] ?? null,
    prebuiltSource: pins.windowsPrebuilt.source ?? null,
    errors,
  };
}

const PART_LABELS = {
  chromium: "Chromium (helium-chromium's chromium_version.txt)",
  "helium-chromium": "helium-chromium",
  "helium-macos": "helium-macos",
  "helium-linux": "helium-linux",
  "helium-windows": "helium-windows",
  "windows-prebuilt": "published engine (helium-windows at prebuilt.json's source)",
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
  if (report.prebuiltSource) {
    out.push(
      `The published Windows engine is compared by the helium-windows its source commit ${report.prebuiltSource.slice(0, 9)} pins, against the newer of our helium-windows pin and upstream's.`,
    );
  }
  if (report.chromiumStable) {
    out.push(`Chromium stable is ${report.chromiumStable} (context only; Helium decides which Chromium we can take).`);
  }
  for (const error of report.errors) out.push(`Could not read: ${error}`);
  return out.join("\n").trimEnd();
}

function partsIn(report, state) {
  return report.platforms.flatMap((platform) =>
    platform.parts.filter((part) => part.state === state).map((part) => `- ${platform.name}: ${PART_LABELS[part.part]} ${part.pinned} → ${part.upstream}`),
  );
}

export function renderIssueBody(report) {
  return [
    ISSUE_MARKER,
    "Upstream has moved past the engine's pins. The weekly Upstream pins workflow keeps this issue up to date and closes it once nothing is behind.",
    "",
    "Behind:",
    ...partsIn(report, "behind"),
    "",
    renderReport(report),
    "",
    "To catch up, bump the pins together (engine/patches/build/env.sh and both helium-pins.ini files) as docs/engine-build.md, “Tracking upstream”, describes, and publish a Windows engine built from them for scripts/windows/engine/prebuilt.json (docs/engine-build-windows.md).",
  ].join("\n");
}

export function renderCloseComment(report) {
  const ahead = partsIn(report, "ahead");
  const lead = ahead.length
    ? ["No engine pin is behind upstream any more, so this is done. These are ahead of upstream's latest release:", ...ahead]
    : ["Every engine pin matches upstream's latest release again, so this is done."];
  return [CLOSE_MARKER, ...lead, "", renderReport(report)].join("\n");
}

export function renderReopenComment() {
  return [REOPEN_MARKER, "Upstream has moved past the engine's pins again; the description lists what is behind."].join("\n");
}

export function planIssue(report, tracking) {
  if (!report.complete) return { action: "fail", reason: "upstream or the published engine's pins could not be read completely, so no issue is changed" };
  if (report.behind) {
    const body = renderIssueBody(report);
    if (!tracking) return { action: "create", title: ISSUE_TITLE, body, labels: [ISSUE_LABEL] };
    if (tracking.state !== "open") return { action: "reopen", number: tracking.number, body, comment: renderReopenComment() };
    if ((tracking.body ?? "").replace(/\r\n/g, "\n") === body) return { action: "none", reason: `#${tracking.number} is already up to date` };
    return { action: "update", number: tracking.number, body };
  }
  if (tracking?.state === "open") return { action: "close", number: tracking.number, comment: renderCloseComment(report) };
  return { action: "none", reason: "nothing is behind and no tracking issue is open" };
}

export function findTrackingIssue(issues) {
  const tracking = issues.filter((issue) => !issue.pull_request && (issue.body ?? "").includes(ISSUE_MARKER));
  const open = tracking.filter((issue) => issue.state === "open").sort((a, b) => a.number - b.number);
  if (open.length) return open[0];
  return tracking.sort((a, b) => b.number - a.number)[0] ?? null;
}

function isRateLimit(status, headers, text) {
  if (status === 429) return true;
  if (status !== 403) return false;
  return headers.get("x-ratelimit-remaining") === "0" || headers.get("retry-after") !== null || /rate limit/i.test(text);
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
    const text = response.status === 204 ? "" : await response.text();
    if (allowNotFound && response.status === 404) return null;
    if (isRateLimit(response.status, response.headers, text)) throw new RateLimited(`GitHub API rate limit reached on ${method} ${path}`);
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
    if (!text) return null;
    return accept.endsWith(".raw") ? text : JSON.parse(text);
  }
  return { request };
}

async function latestRelease(client, repo) {
  const release = await client.request("GET", `/repos/${repo}/releases/latest`);
  if (!release || release.draft || release.prerelease) throw new Error("no published release");
  if (!isVersion(release.tag_name)) throw new Error(`latest release tag ${JSON.stringify(release.tag_name)} is not a dotted numeric version`);
  return release.tag_name;
}

export function gitShowReader(root = REPO_ROOT) {
  return (commit, path) =>
    execFileSync("git", ["-C", root, "show", `${commit}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export async function fetchPrebuiltPins({ source, client, repo, readAtCommit }) {
  let text = null;
  if (readAtCommit) {
    try {
      text = readAtCommit(source, PIN_FILES.windowsIni);
    } catch {
      text = null;
    }
  }
  if (text === null) {
    text = await client.request("GET", `/repos/${repo}/contents/${PIN_FILES.windowsIni}?ref=${encodeURIComponent(source)}`, {
      accept: "application/vnd.github.raw",
    });
  }
  const pins = windowsIniPins(text);
  return { heliumChromium: pins.heliumChromium.tag ?? null, heliumWindows: pins.heliumWindows.tag ?? null };
}

export async function fetchUpstream({ client, fetchImpl = globalThis.fetch, prebuiltSource, repo, readAtCommit }) {
  const latest = {};
  const errors = [];
  const rethrowRateLimit = (error) => {
    if (error instanceof RateLimited) throw error;
  };
  await Promise.all(
    Object.entries(UPSTREAM_REPOS).map(async ([part, upstreamRepo]) => {
      try {
        latest[part] = await latestRelease(client, upstreamRepo);
      } catch (error) {
        rethrowRateLimit(error);
        errors.push(`${upstreamRepo}: ${error.message}`);
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
      const version = String(text ?? "").trim();
      if (!isVersion(version)) throw new Error(`${JSON.stringify(version)} is not a dotted numeric version`);
      heliumChromiumChromium = version;
    } catch (error) {
      rethrowRateLimit(error);
      errors.push(`chromium_version.txt at helium-chromium ${latest["helium-chromium"]}: ${error.message}`);
    }
  }
  let prebuilt = null;
  if (prebuiltSource) {
    try {
      prebuilt = await fetchPrebuiltPins({ source: prebuiltSource, client, repo, readAtCommit });
      if (!isVersion(prebuilt.heliumWindows)) throw new Error(`helium-windows tag ${JSON.stringify(prebuilt.heliumWindows)} is not a dotted numeric version`);
    } catch (error) {
      rethrowRateLimit(error);
      prebuilt = null;
      errors.push(`${PIN_FILES.windowsIni} at prebuilt.json's source ${prebuiltSource}: ${error.message}`);
    }
  }
  let chromiumStable = null;
  try {
    const response = await fetchImpl(CHROMIUM_STABLE_URL, { headers: { "user-agent": "ardia-upstream-pins" } });
    if (response.ok) {
      const version = (await response.json())[0]?.version;
      chromiumStable = isVersion(version) ? version : null;
    }
  } catch {
    chromiumStable = null;
  }
  return { latest, heliumChromiumChromium, chromiumStable, prebuilt, errors };
}

export async function listAllIssues(client, repo, maxPages = MAX_ISSUE_PAGES) {
  const issues = [];
  for (let page = 1; ; page++) {
    if (page > maxPages) throw new Error(`more than ${maxPages} pages of issues in ${repo}; refusing to guess whether the tracking issue exists`);
    const batch = await client.request("GET", `/repos/${repo}/issues?state=all&per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`issues page ${page} of ${repo} is not a list`);
    issues.push(...batch);
    if (batch.length < 100) return issues;
  }
}

async function lastComment(client, repo, number) {
  let last = null;
  for (let page = 1; page <= MAX_ISSUE_PAGES; page++) {
    const batch = await client.request("GET", `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    if (batch.length) last = batch.at(-1);
    if (batch.length < 100) return last;
  }
  throw new Error(`more than ${MAX_ISSUE_PAGES} pages of comments on #${number}`);
}

export async function syncIssue({ client, repo, report, dryRun, log = console.log, maxPages = MAX_ISSUE_PAGES }) {
  if (!report.complete) {
    const plan = planIssue(report, null);
    log(`Tracking issue: left alone (${plan.reason}).`);
    return plan;
  }
  const tracking = findTrackingIssue(await listAllIssues(client, repo, maxPages));
  const plan = planIssue(report, tracking);
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
  } else if (plan.action === "reopen") {
    log(`Tracking issue: ${prefix}reopen #${plan.number} with the new list.`);
    if (!dryRun) {
      await client.request("PATCH", `/repos/${repo}/issues/${plan.number}`, { body: { state: "open", body: plan.body } });
      await client.request("POST", `/repos/${repo}/issues/${plan.number}/comments`, { body: { body: plan.comment } });
    }
  } else if (plan.action === "update") {
    log(`Tracking issue: ${prefix}update #${plan.number}.`);
    if (!dryRun) await client.request("PATCH", `/repos/${repo}/issues/${plan.number}`, { body: { body: plan.body } });
  } else if (plan.action === "close") {
    const already = (await lastComment(client, repo, plan.number))?.body?.includes(CLOSE_MARKER) ?? false;
    log(`Tracking issue: ${prefix}${already ? "close" : "comment on and close"} #${plan.number}.`);
    if (!dryRun) {
      if (!already) await client.request("POST", `/repos/${repo}/issues/${plan.number}/comments`, { body: { body: plan.comment } });
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
  const repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
  const client = makeClient({ token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN });
  try {
    const upstream = await fetchUpstream({
      client,
      repo,
      prebuiltSource: pins.windowsPrebuilt.source,
      readAtCommit: gitShowReader(),
    });
    const report = compare(pins, upstream);
    if (args.has("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const text = renderReport(report);
      console.log(text);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Upstream pins\n\n${text}\n`);
    }
    if (args.has("--issue")) {
      if (!process.env.GITHUB_REPOSITORY) throw new Error("--issue needs GITHUB_REPOSITORY (owner/name)");
      await syncIssue({ client, repo, report, dryRun: args.has("--dry-run") || process.env.DRY_RUN === "true" });
    }
    if (!report.complete) {
      console.error("upstream-pins: incomplete data, see the report");
      return 1;
    }
    return 0;
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
