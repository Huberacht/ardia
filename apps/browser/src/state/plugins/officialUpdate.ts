import { CONTRIBUTES_KEYS, MENU_SLOTS, PERMISSION_KEYS, type CommandSpec, type PluginContributions, type PluginManifest, type PluginPermissions, type ProgramSpec } from "../../lib/pluginManifest";
import { ANY_HOST, hostPatternCovers } from "../../lib/pluginNetwork";
import { consentLines } from "./consent";

export const UPDATE_PROMPT_REASONS = ["baseline", "permissions", "network", "runtime", "activation", "programs", "hooks", "settings", "contributions", "unknown"] as const;
export type UpdatePromptReason = (typeof UPDATE_PROMPT_REASONS)[number];
export type UpdateVerdict = { ok: true; added: string[] } | { ok: false; reason: UpdatePromptReason };

type Rule<T> = (approved: T, next: T, both: { approved: PluginManifest; next: PluginManifest }) => UpdatePromptReason | null;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

const identical =
  (reason: UpdatePromptReason): Rule<unknown> =>
  (a, b) =>
    same(a, b) ? null : reason;

const cosmetic: Rule<unknown> = () => null;

const TAB_RANK = { false: 0, read: 1, write: 2 } as const;

function networkWithin(a: PluginPermissions["network"], b: PluginPermissions["network"]): boolean {
  if (b === false || a === ANY_HOST) return true;
  if (b === ANY_HOST || a === false || !Array.isArray(a) || !Array.isArray(b)) return false;
  return b.every((host) => a.some((allowed) => hostPatternCovers(allowed, host)));
}

const flagWithin = (a: boolean, b: boolean) => !b || a;

const PERMISSION_RULES: Record<keyof PluginPermissions, (a: PluginPermissions, b: PluginPermissions) => UpdatePromptReason | null> = {
  tabs: (a, b) => (TAB_RANK[`${b.tabs}`] <= TAB_RANK[`${a.tabs}`] ? null : "permissions"),
  fullUrls: (a, b) => (flagWithin(a.fullUrls, b.fullUrls) ? null : "permissions"),
  activePage: (a, b) => (flagWithin(a.activePage, b.activePage) ? null : "permissions"),
  workspace: (a, b) => (flagWithin(a.workspace, b.workspace) ? null : "permissions"),
  commands: (a, b) => (flagWithin(a.commands, b.commands) ? null : "permissions"),
  storage: (a, b) => (flagWithin(a.storage, b.storage) ? null : "permissions"),
  secrets: (a, b) => (flagWithin(a.secrets, b.secrets) ? null : "permissions"),
  network: (a, b) => (networkWithin(a.network, b.network) ? null : "network"),
  control: (a, b) => (flagWithin(a.control, b.control) ? null : "permissions"),
};

const permissionsWithin: Rule<PluginPermissions> = (a, b) => {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (!(PERMISSION_KEYS as readonly string[]).includes(key) || !Object.hasOwn(PERMISSION_RULES, key)) return "unknown";
  for (const key of PERMISSION_KEYS) {
    const reason = PERMISSION_RULES[key](a, b);
    if (reason) return reason;
  }
  return null;
};

const runs = (programs: readonly ProgramSpec[]) => programs.map((p) => ({ name: p.name, path: p.path, afterUpdate: p.afterUpdate }));

const programsWithin: Rule<ProgramSpec[]> = (a, b) => (same(runs(a), runs(b)) ? null : "programs");

const isAddableCommand = (c: CommandSpec) => "view" in c.action || "handler" in c.action;

const commandsWithin: Rule<CommandSpec[]> = (a, b) => {
  for (const before of a) {
    const after = b.find((c) => c.name === before.name);
    if (!after || !same(before, after)) return "contributions";
  }
  for (const command of b) if (!a.some((c) => c.name === command.name) && !isAddableCommand(command)) return "contributions";
  const kept = b.filter((c) => a.some((x) => x.name === c.name));
  return same(kept.map((c) => c.name), a.map((c) => c.name)) ? null : "contributions";
};

const userOnly = (events: readonly string[]) => events.filter((e) => !e.startsWith("onCommand:")).sort();

const activationWithin: Rule<string[]> = (a, b, { approved, next }) => {
  if (!same(userOnly(a), userOnly(b))) return "activation";
  const added = b.filter((e) => e.startsWith("onCommand:") && !a.includes(e)).map((e) => e.slice("onCommand:".length));
  const addedCommands = next.commands.filter((c) => !approved.commands.some((x) => x.name === c.name)).map((c) => c.name);
  return added.every((name) => addedCommands.includes(name)) ? null : "activation";
};

const CONTRIBUTION_RULES: { [K in keyof PluginContributions]: Rule<PluginContributions[K]> } = {
  commands: commandsWithin,
  tools: identical("contributions"),
  hooks: identical("hooks"),
  settings: identical("settings"),
  programs: programsWithin,
  passwordManager: identical("contributions"),
  menus: identical("contributions"),
  toolbar: identical("contributions"),
  sidebarViews: identical("contributions"),
  panels: identical("contributions"),
  omnibox: identical("contributions"),
  themes: identical("contributions"),
  siteSwitches: identical("contributions"),
  pageBar: identical("contributions"),
};

const contributionsWithin: Rule<PluginContributions> = (a, b, both) => {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (!(CONTRIBUTES_KEYS as readonly string[]).includes(key) || !Object.hasOwn(CONTRIBUTION_RULES, key)) return "unknown";
  for (const key of CONTRIBUTES_KEYS) {
    const reason = (CONTRIBUTION_RULES[key] as Rule<unknown>)(a[key], b[key], both);
    if (reason) return reason;
  }
  return null;
};

function firstMainOnDemand(b: PluginManifest): boolean {
  const k = b.contributes;
  const elsewhere = b.page || k.panels.length || k.sidebarViews.length || k.toolbar.length || k.omnibox.length || k.tools.length || k.hooks.length || MENU_SLOTS.some((slot) => k.menus[slot].length);
  return !elsewhere && !b.sidecar && b.activationEvents.every((e) => e.startsWith("onCommand:"));
}

const mainWithin: Rule<PluginManifest["main"]> = (a, b, { approved, next }) => {
  if (a === null && b !== null) return !approved.sidecar && firstMainOnDemand(next) ? null : "runtime";
  return same(a, b) ? null : "runtime";
};

const MANIFEST_RULES: { [K in keyof PluginManifest]: Rule<PluginManifest[K]> } = {
  manifest: cosmetic,
  declaredManifest: cosmetic,
  name: (a, b) => (a === b ? null : "baseline"),
  official: (a, b) => (a && b ? null : "baseline"),
  title: cosmetic,
  description: cosmetic,
  version: cosmetic,
  requires: cosmetic,
  icon: cosmetic,
  keywords: cosmetic,
  telemetry: cosmetic,
  permissions: permissionsWithin,
  main: mainWithin,
  sidecar: identical("runtime"),
  activationEvents: activationWithin,
  contributes: contributionsWithin,
  alwaysOn: identical("runtime"),
  autoInstall: identical("runtime"),
  settings: identical("settings"),
  commands: commandsWithin,
  tools: identical("contributions"),
  hooks: identical("hooks"),
  programs: programsWithin,
  passwordManager: identical("contributions"),
  page: identical("contributions"),
  process: identical("runtime"),
};

export function updateWithin(approved: PluginManifest, next: PluginManifest): UpdateVerdict {
  for (const key of new Set([...Object.keys(approved), ...Object.keys(next)])) if (!Object.hasOwn(MANIFEST_RULES, key)) return { ok: false, reason: "unknown" };
  const both = { approved, next };
  for (const key of Object.keys(MANIFEST_RULES) as (keyof PluginManifest)[]) {
    const reason = (MANIFEST_RULES[key] as Rule<unknown>)(approved[key], next[key], both);
    if (reason) return { ok: false, reason };
  }
  const before = new Set(consentLines(approved).map((l) => l.text));
  return { ok: true, added: consentLines(next).map((l) => l.text).filter((text) => !before.has(text)) };
}
