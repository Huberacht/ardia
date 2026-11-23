import { CONTRIBUTES_KEYS, MENU_SLOTS, PERMISSION_KEYS, startsEagerly, type CommandSpec, type PluginContributions, type PluginManifest, type PluginPermissions, type ProgramSpec } from "../../lib/pluginManifest";
import { ANY_HOST, hostPatternCovers } from "../../lib/pluginNetwork";
import { consentLines } from "./consent";

export const UPDATE_PROMPT_REASONS = ["baseline", "permissions", "network", "runtime", "activation", "programs", "hooks", "settings", "contributions", "unknown"] as const;
export type UpdatePromptReason = (typeof UPDATE_PROMPT_REASONS)[number];
export type UpdateVerdict = { ok: true; added: string[] } | { ok: false; reason: UpdatePromptReason };

type Rule<T> = (approved: T, next: T) => UpdatePromptReason | null;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

const within = (approved: readonly unknown[], next: readonly unknown[]): boolean => {
  const known = new Set(approved.map(canonical));
  return next.every((item) => known.has(canonical(item)));
};

const listWithin =
  (reason: UpdatePromptReason): Rule<readonly unknown[]> =>
  (a, b) =>
    within(a, b) ? null : reason;

const cosmetic: Rule<unknown> = () => null;

const nullOrSame =
  (reason: UpdatePromptReason): Rule<unknown> =>
  (a, b) =>
    b === null || same(a, b) ? null : reason;

const TAB_RANK = { false: 0, read: 1, write: 2 } as const;

function networkWithin(a: PluginPermissions["network"], b: PluginPermissions["network"]): boolean {
  if (b === false) return true;
  if (a === ANY_HOST) return true;
  if (b === ANY_HOST || a === false) return false;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return b.every((host) => a.some((allowed) => hostPatternCovers(allowed, host)));
}

const PERMISSION_RULES: Record<keyof PluginPermissions, Rule<PluginPermissions>> = {
  tabs: (a, b) => (TAB_RANK[`${b.tabs}`] <= TAB_RANK[`${a.tabs}`] ? null : "permissions"),
  fullUrls: (a, b) => (!b.fullUrls || a.fullUrls ? null : "permissions"),
  activePage: (a, b) => (!b.activePage || a.activePage ? null : "permissions"),
  workspace: (a, b) => (!b.workspace || a.workspace ? null : "permissions"),
  commands: (a, b) => (!b.commands || a.commands ? null : "permissions"),
  storage: (a, b) => (!b.storage || a.storage ? null : "permissions"),
  secrets: (a, b) => (!b.secrets || a.secrets ? null : "permissions"),
  network: (a, b) => (networkWithin(a.network, b.network) ? null : "network"),
  control: (a, b) => (!b.control || a.control ? null : "permissions"),
};

function permissionsWithin(a: PluginPermissions, b: PluginPermissions): UpdatePromptReason | null {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!(PERMISSION_KEYS as readonly string[]).includes(key) || !Object.hasOwn(PERMISSION_RULES, key)) return "unknown";
  for (const key of PERMISSION_KEYS) {
    const reason = PERMISSION_RULES[key](a, b);
    if (reason) return reason;
  }
  return null;
}

const BACKGROUND_STARTS = ["*", "onStartupFinished"];

function activationWithin(a: readonly string[], b: readonly string[]): UpdatePromptReason | null {
  if (a.includes("*")) return null;
  const eager = (events: readonly string[]) => events.some((e) => BACKGROUND_STARTS.includes(e));
  for (const event of b) {
    if (BACKGROUND_STARTS.includes(event)) {
      if (!eager(a)) return "activation";
    } else if (event.startsWith("onEvent:")) {
      if (!a.includes(event) && !a.includes("onEvent:*")) return "activation";
    } else if (event.startsWith("onUrl:")) {
      const host = event.slice("onUrl:".length);
      if (!a.some((e) => e.startsWith("onUrl:") && hostPatternCovers(e.slice("onUrl:".length), host))) return "activation";
    } else if (!/^on(Command|View|Panel|Toolbar|Omnibox|Menu):/.test(event)) return "unknown";
  }
  return null;
}

function inOrderWithin(approved: readonly unknown[], next: readonly unknown[]): boolean {
  let at = 0;
  for (const item of next.map(canonical)) {
    while (at < approved.length && canonical(approved[at]) !== item) at++;
    if (at === approved.length) return false;
    at++;
  }
  return true;
}

function programsWithin(a: readonly ProgramSpec[], b: readonly ProgramSpec[]): UpdatePromptReason | null {
  for (const program of b) {
    const before = a.find((p) => p.name === program.name);
    if (!before || before.path !== program.path || !inOrderWithin(before.afterUpdate, program.afterUpdate)) return "programs";
  }
  return null;
}

const handsOverTab = (c: CommandSpec) => "open" in c.action && c.action.context;

function commandsWithin(a: readonly CommandSpec[], b: readonly CommandSpec[]): UpdatePromptReason | null {
  for (const command of b) {
    const before = a.find((c) => c.name === command.name);
    if (before && (!same(before.action, command.action) || !same(before.when ?? null, command.when ?? null))) return "contributions";
    const action = command.action;
    if ("tool" in action || "open" in action || "view" in action || "panel" in action || "handler" in action) {
      if (handsOverTab(command) && !a.some(handsOverTab)) return "contributions";
      continue;
    }
    return "unknown";
  }
  return null;
}

const settingsWithin = (a: PluginContributions["settings"], b: PluginContributions["settings"]): UpdatePromptReason | null => (same(a.defaults, b.defaults) ? null : "settings");

const toolsWithin: Rule<PluginContributions["tools"]> = (a, b) => (b.every((t) => a.some((x) => x.name === t.name)) ? null : "contributions");

const menusWithin: Rule<PluginContributions["menus"]> = (a, b) => {
  const slots = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const slot of slots) {
    const before = Object.hasOwn(a, slot) ? (a as Record<string, unknown[]>)[slot]! : [];
    const after = Object.hasOwn(b, slot) ? (b as Record<string, unknown[]>)[slot]! : [];
    if (!within(before, after)) return "contributions";
  }
  return null;
};

const CONTRIBUTION_RULES: { [K in keyof PluginContributions]: Rule<PluginContributions[K]> } = {
  commands: commandsWithin,
  tools: toolsWithin,
  hooks: listWithin("hooks"),
  settings: settingsWithin,
  programs: programsWithin,
  passwordManager: nullOrSame("contributions"),
  menus: menusWithin,
  toolbar: listWithin("contributions"),
  sidebarViews: listWithin("contributions"),
  panels: listWithin("contributions"),
  omnibox: listWithin("contributions"),
  themes: listWithin("contributions"),
  siteSwitches: listWithin("contributions"),
  pageBar: nullOrSame("contributions"),
};

function contributionsWithin(a: PluginContributions, b: PluginContributions): UpdatePromptReason | null {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!(CONTRIBUTES_KEYS as readonly string[]).includes(key) || !Object.hasOwn(CONTRIBUTION_RULES, key)) return "unknown";
  for (const key of CONTRIBUTES_KEYS) {
    const rule = CONTRIBUTION_RULES[key] as Rule<unknown>;
    const reason = rule(a[key], b[key]);
    if (reason) return reason;
  }
  return null;
}

const processWithin: Rule<PluginManifest["sidecar"]> = (a, b) => (b === null || (a !== null && same(a.run, b.run)) ? null : "runtime");

const flagWithin =
  (reason: UpdatePromptReason): Rule<boolean> =>
  (a, b) =>
    !b || a ? null : reason;

const MANIFEST_RULES: { [K in keyof PluginManifest]: Rule<PluginManifest[K]> } = {
  manifest: cosmetic,
  declaredManifest: cosmetic,
  name: (a, b) => (a === b ? null : "baseline"),
  title: cosmetic,
  description: cosmetic,
  version: cosmetic,
  requires: cosmetic,
  icon: cosmetic,
  keywords: cosmetic,
  telemetry: cosmetic,
  permissions: permissionsWithin,
  main: cosmetic,
  sidecar: processWithin,
  activationEvents: activationWithin,
  contributes: contributionsWithin,
  alwaysOn: flagWithin("runtime"),
  official: (a, b) => (a && b ? null : "baseline"),
  autoInstall: flagWithin("runtime"),
  settings: settingsWithin,
  commands: commandsWithin,
  tools: toolsWithin,
  hooks: listWithin("hooks"),
  programs: programsWithin,
  passwordManager: nullOrSame("contributions"),
  page: (a, b) => (b === null || a !== null ? null : "contributions"),
  process: processWithin,
};

function newRuntime(a: PluginManifest, b: PluginManifest): UpdatePromptReason | null {
  if (!b.main || a.main) return null;
  const k = b.contributes;
  const elsewhere = b.page || k.panels.length || k.sidebarViews.length || k.toolbar.length || k.omnibox.length || k.tools.length || MENU_SLOTS.some((slot) => k.menus[slot].length);
  if (a.sidecar || b.sidecar || startsEagerly(b.activationEvents) || elsewhere || !b.activationEvents.every((e) => e.startsWith("onCommand:"))) return "runtime";
  return null;
}

export function updateWithin(approved: PluginManifest, next: PluginManifest): UpdateVerdict {
  const keys = new Set([...Object.keys(approved), ...Object.keys(next)]);
  for (const key of keys) if (!Object.hasOwn(MANIFEST_RULES, key)) return { ok: false, reason: "unknown" };
  for (const key of Object.keys(MANIFEST_RULES) as (keyof PluginManifest)[]) {
    const rule = MANIFEST_RULES[key] as Rule<unknown>;
    const reason = rule(approved[key], next[key]);
    if (reason) return { ok: false, reason };
  }
  const runtime = newRuntime(approved, next);
  if (runtime) return { ok: false, reason: runtime };
  const before = new Set(consentLines(approved).map((l) => l.text));
  return { ok: true, added: consentLines(next).map((l) => l.text).filter((text) => !before.has(text)) };
}

