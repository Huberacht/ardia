import { onConsentPeriodChange, type ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";
import { SOCKET_FAMILIES, type SocketFamily } from "../automation/socketCatalog";

export const TOKEN_COMMAND_DOMAINS = ["accessibility", "browser", "dom", "emulation", "fetch", "input", "network", "page", "runtime", "storage", "target", "other"] as const;
export type TokenCommandDomain = (typeof TOKEN_COMMAND_DOMAINS)[number];
type TokenCommandTotals = Partial<Record<TokenCommandDomain, number>>;

export type CliInstallReason = "auto" | "settings" | "upgrade";

const NONE = {
  cli_pill_shows: 0,
  cli_pill_compact_shows: 0,
  cli_auto_installs: 0,
  cli_auto_install_failures: 0,
  cli_auto_enables: 0,
  cli_upgrades: 0,
  cli_upgrade_failures: 0,
  cli_settings_installs: 0,
  cli_settings_install_failures: 0,
  windowless_pages_given_geometry: 0,
  windowless_pages_missing_geometry: 0,
  cli_socket_call_failures: 0,
  cli_socket_lines_shrunk: 0,
  cli_socket_password_manager_refusals: 0,
  ...(Object.fromEntries(SOCKET_FAMILIES.map((family) => [`cli_socket_calls_${family}`, 0])) as Record<`cli_socket_calls_${SocketFamily}`, number>),
  ...(Object.fromEntries(TOKEN_COMMAND_DOMAINS.map((domain) => [`cli_cdp_commands_${domain}`, 0])) as Record<`cli_cdp_commands_${TokenCommandDomain}`, number>),
};

const FIELDS = {
  auto: ["cli_auto_installs", "cli_auto_install_failures"],
  upgrade: ["cli_upgrades", "cli_upgrade_failures"],
  settings: ["cli_settings_installs", "cli_settings_install_failures"],
} as const;

let counts = { ...NONE };
let windowlessSeen = { given: 0, missed: 0 };
let tokenCommandsSeen: Record<TokenCommandDomain, number> = Object.fromEntries(TOKEN_COMMAND_DOMAINS.map((domain) => [domain, 0])) as Record<TokenCommandDomain, number>;

export const noteCliInstall = (reason: CliInstallReason, ok: boolean, consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void counts[FIELDS[reason][ok ? 0 : 1]]++);
export function noteCliPillShown(compact: boolean) {
  counts.cli_pill_shows++;
  if (compact) counts.cli_pill_compact_shows++;
}
export function noteSocketCall(family: SocketFamily, failed: boolean, consent?: ConsentToken | null) {
  const field = `cli_socket_calls_${family}` as const;
  countFor(consentOrNow(consent), () => void counts[field]++);
  if (failed) countFor(consentOrNow(consent), () => void counts.cli_socket_call_failures++);
}
export const noteSocketLineShrunk = (consent: ConsentToken | null) => countFor(consentOrNow(consent), () => void counts.cli_socket_lines_shrunk++);
export const noteSocketPasswordManagerRefused = (consent: ConsentToken | null) =>
  countFor(consentOrNow(consent), () => void counts.cli_socket_password_manager_refusals++);
export const noteCliAutoEnabled = () => void counts.cli_auto_enables++;

let windowlessBaselineStale = false;
let tokenCommandsBaselineStale = false;
onConsentPeriodChange(() => {
  windowlessBaselineStale = true;
  tokenCommandsBaselineStale = true;
});

export function noteWindowlessPages(totals: { given: number; missed: number } | undefined) {
  if (!totals) return;
  const given = Number(totals.given) || 0, missed = Number(totals.missed) || 0;
  if (windowlessBaselineStale) {
    windowlessBaselineStale = false;
    windowlessSeen = { given: Math.max(given, windowlessSeen.given), missed: Math.max(missed, windowlessSeen.missed) };
    return;
  }
  counts.windowless_pages_given_geometry += Math.max(0, given - windowlessSeen.given);
  counts.windowless_pages_missing_geometry += Math.max(0, missed - windowlessSeen.missed);
  windowlessSeen = { given: Math.max(given, windowlessSeen.given), missed: Math.max(missed, windowlessSeen.missed) };
}

export function noteTokenCommands(totals: TokenCommandTotals | undefined) {
  if (!totals) return;
  const stale = tokenCommandsBaselineStale;
  tokenCommandsBaselineStale = false;
  for (const domain of TOKEN_COMMAND_DOMAINS) {
    const total = Number(totals[domain]) || 0;
    if (!stale) counts[`cli_cdp_commands_${domain}`] += Math.max(0, total - tokenCommandsSeen[domain]);
    tokenCommandsSeen[domain] = Math.max(total, tokenCommandsSeen[domain]);
  }
}

export function noteEngineCliTotals(status: { windowlessPages?: { given: number; missed: number }; tokenCommands?: TokenCommandTotals }) {
  noteWindowlessPages(status.windowlessPages);
  noteTokenCommands(status.tokenCommands);
}

export function takeCliCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
