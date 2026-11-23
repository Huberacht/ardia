import type { ChildProcessCpu } from "../../platform/performance";

type Reading = { at: number; cpuMs: number };

export type ProcessHeat = { started: number; readings: Reading[]; cores: number; busySince: number | null };

export const BUSY_TICK_MS = 10_000;
export const HOT_CORES = 0.7;
export const SUSTAINED_MS = 120_000;
const LONGEST_GAP_MS = 2.5 * BUSY_TICK_MS;
const COVERED_SLACK_MS = BUSY_TICK_MS / 2;

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

export function validReadings(raw: unknown): ChildProcessCpu[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const valid: ChildProcessCpu[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { pid, started, cpuMs } = r as Record<string, unknown>;
    if (!isCount(pid) || !Number.isInteger(pid) || pid <= 0 || seen.has(pid) || !isCount(started) || !isCount(cpuMs)) continue;
    seen.add(pid);
    valid.push({ pid, started, cpuMs });
  }
  return valid;
}

export function readHeat(prev: ReadonlyMap<number, ProcessHeat>, readings: readonly ChildProcessCpu[], now: number, hotCores = HOT_CORES): Map<number, ProcessHeat> {
  const next = new Map<number, ProcessHeat>();
  for (const r of readings) {
    const was = prev.get(r.pid);
    const last = was?.readings[was.readings.length - 1];
    const continued = !!was && !!last && was.started === r.started && now > last.at && now - last.at <= LONGEST_GAP_MS && r.cpuMs >= last.cpuMs;
    const kept = continued ? was.readings : [];
    let from = 0;
    while (from + 1 < kept.length && kept[from + 1]!.at <= now - SUSTAINED_MS) from++;
    const window = [...kept.slice(from), { at: now, cpuMs: r.cpuMs }];
    const oldest = window[0]!;
    const cores = continued ? (r.cpuMs - last.cpuMs) / (now - last.at) : 0;
    const covered = now - oldest.at >= SUSTAINED_MS - COVERED_SLACK_MS;
    const busy = covered && (r.cpuMs - oldest.cpuMs) / (now - oldest.at) >= hotCores;
    next.set(r.pid, { started: r.started, readings: window, cores, busySince: busy ? (was?.busySince ?? now) : null });
  }
  return next;
}

export function sustainedBusy(heat: ReadonlyMap<number, ProcessHeat>): number[] {
  const pids: number[] = [];
  for (const [pid, h] of heat) if (h.busySince !== null) pids.push(pid);
  return pids;
}

const DEFAULT_PORTS: Readonly<Record<string, string>> = { http: "80", https: "443" };
const SITE_RULE = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/:?#]*)(?::(\*|\d{1,5}))?(\/[^?#]*)?(?:\?([^#]*))?$/i;

function queryHolds(url: URL, query: string): boolean {
  const pairs = [...url.searchParams].map(([key, value]) => `${key}=${value}`);
  for (const token of query.split("&")) {
    if (!token) continue;
    const prefix = token.endsWith("*");
    const raw = prefix ? token.slice(0, -1) : token;
    const eq = raw.indexOf("=");
    const wanted = eq < 0 ? decodeURIComponent(raw) : `${decodeURIComponent(raw.slice(0, eq))}=${decodeURIComponent(raw.slice(eq + 1))}`;
    const holds = prefix ? pairs.some((pair) => pair.startsWith(wanted)) : eq < 0 ? url.searchParams.has(wanted) : pairs.includes(wanted);
    if (!holds) return false;
  }
  return true;
}

export function matchesSiteRule(address: string, rule: string): boolean {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  const trimmed = rule.trim();
  if (trimmed === "*") return true;
  const m = SITE_RULE.exec(trimmed);
  if (!m) return false;
  const [, scheme, rawHost = "", port, path, query] = m;
  const protocol = url.protocol.slice(0, -1).toLowerCase();
  if (scheme && scheme.toLowerCase() !== protocol) return false;
  if (!scheme && !rawHost) return false;
  let host = rawHost.toLowerCase().replace(/\.$/, "");
  const exact = host.startsWith(".");
  if (exact) host = host.slice(1);
  else if (host.startsWith("*.")) host = host.slice(2);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host && host !== "*" && !(hostname === host || (!exact && hostname.endsWith(`.${host}`)))) return false;
  if (port && port !== "*" && (url.port || DEFAULT_PORTS[protocol] || "") !== port) return false;
  if (path && path !== "/" && !url.pathname.startsWith(path)) return false;
  try {
    return !query || queryHolds(url, query);
  } catch {
    return false;
  }
}

export const keptActive = (address: string, rules: readonly unknown[]) => rules.some((rule) => typeof rule === "string" && matchesSiteRule(address, rule));

export function siteToKeepActive(address: string): string | null {
  try {
    const url = new URL(address);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}
