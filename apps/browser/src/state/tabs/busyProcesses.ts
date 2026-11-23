import type { ChildProcessCpu } from "../../platform/performance";

type Reading = { at: number; cpuMs: number };

export type ProcessHeat = { started: number; kind: ChildProcessCpu["kind"]; readings: Reading[]; cores: number; busySince: number | null };

export const BUSY_TICK_MS = 10_000;
export const HOT_CORES = 0.7;
export const SUSTAINED_MS = 120_000;
const LONGEST_GAP_MS = 2.5 * BUSY_TICK_MS;
const COVERED_SLACK_MS = BUSY_TICK_MS / 2;

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
    next.set(r.pid, { started: r.started, kind: r.kind, readings: window, cores, busySince: busy ? (was?.busySince ?? now) : null });
  }
  return next;
}

export const busyFor = (heat: ProcessHeat, now: number) => (heat.busySince === null ? 0 : now - heat.busySince + SUSTAINED_MS);

export function sustainedBusy(heat: ReadonlyMap<number, ProcessHeat>): number[] {
  const pids: number[] = [];
  for (const [pid, h] of heat) if (h.busySince !== null) pids.push(pid);
  return pids;
}

const hostOf = (url: string) => {
  const m = /^https?:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(url);
  return m ? m[1]!.toLowerCase().replace(/\.$/, "") : "";
};

export function siteToKeepActive(url: string): string | null {
  const host = hostOf(url);
  return host ? host.replace(/^www\./, "") : null;
}

export function keptActive(url: string, sites: readonly string[]): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return sites.some((site) => {
    const kept = hostOf(`http://${site.trim().replace(/^[a-z][\w+.-]*:\/\//i, "").replace(/^(\[\*\.\]|\*\.)/, "")}`);
    return !!kept && (host === kept || host.endsWith(`.${kept}`));
  });
}
