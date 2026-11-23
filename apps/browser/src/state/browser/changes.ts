import { consentOrNow, countFor } from "../telemetry/countFor";

const NONE: readonly string[] = [];
const memo = new WeakMap<object, WeakMap<object, readonly string[]>>();
const keyLists = new WeakMap<object, readonly string[]>();

type Link = { readonly from: number; readonly ids: readonly string[] };

export const LINKS_KEPT = 8;
export const LINKED_IDS_MAX = 256;

const stamps = new WeakMap<object, number>();
const chains = new WeakMap<object, readonly Link[]>();
let lastStamp = 0;

export const changeDetection = { linked: 0, scanned: 0, scannedEntries: 0 };
const countLinked = () => void changeDetection.linked++;
let lastScanSize = 0;
const countScanned = () => {
  changeDetection.scanned++;
  changeDetection.scannedEntries += lastScanSize;
};

export function takeChangeDetectionCounts() {
  const taken = { record_changes_linked: changeDetection.linked, record_changes_scanned: changeDetection.scanned, record_changes_scanned_entries: changeDetection.scannedEntries };
  changeDetection.linked = 0;
  changeDetection.scanned = 0;
  changeDetection.scannedEntries = 0;
  return taken;
}

export function keysOf(o: object): readonly string[] {
  let keys = keyLists.get(o);
  if (!keys) keyLists.set(o, (keys = Object.keys(o)));
  return keys;
}

function stampOf(o: object): number {
  let stamp = stamps.get(o);
  if (stamp === undefined) stamps.set(o, (stamp = ++lastStamp));
  return stamp;
}

export function linkChanges<R extends object>(next: R, prev: R, ids: readonly string[]): R {
  if (next === prev || chains.has(next)) return next;
  const older = chains.get(prev);
  const link: Link = { from: stampOf(prev), ids };
  chains.set(next, older ? [link, ...older.slice(0, LINKS_KEPT - 1)] : [link]);
  return next;
}

export function withEntry<T>(record: Record<string, T>, id: string, value: T): Record<string, T> {
  return linkChanges({ ...record, [id]: value }, record, [id]);
}

export function linkedChangedIds<T>(next: Record<string, T>, prev: Record<string, T>): readonly string[] | null {
  if (next === prev) return NONE;
  const hit = memo.get(next)?.get(prev);
  if (hit) return hit;
  const chain = chains.get(next);
  const from = chain && stamps.get(prev);
  if (!chain || from === undefined) return null;
  let reach = -1;
  let total = 0;
  for (let i = 0; i < chain.length; i++) {
    total += chain[i]!.ids.length;
    if (total > LINKED_IDS_MAX) return null;
    if (chain[i]!.from === from) {
      reach = i;
      break;
    }
  }
  if (reach < 0) return null;
  const ids: string[] = [];
  const seen = reach || chain[0]!.ids.length > 1 ? new Set<string>() : null;
  for (let i = reach; i >= 0; i--) {
    for (const id of chain[i]!.ids) {
      if (seen) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      if (next[id] !== prev[id]) ids.push(id);
    }
  }
  countFor(consentOrNow(undefined), countLinked);
  return remember(next, prev, ids);
}

export function scannedChangedIds<T>(next: Record<string, T>, prev: Record<string, T>): readonly string[] {
  const ids: string[] = [];
  const keys = keysOf(next);
  let added = 0;
  for (let i = 0; i < keys.length; i++) {
    const id = keys[i]!;
    const before = prev[id];
    if (next[id] === before) continue;
    ids.push(id);
    if (before === undefined) added++;
  }
  const before = keysOf(prev);
  if (before.length > keys.length - added) for (const id of before) if (next[id] === undefined) ids.push(id);
  return ids;
}

function remember(next: object, prev: object, ids: readonly string[]): readonly string[] {
  let byPrev = memo.get(next);
  if (!byPrev) memo.set(next, (byPrev = new WeakMap()));
  byPrev.set(prev, ids);
  return ids;
}

export function changedIds<T>(next: Record<string, T>, prev: Record<string, T>): readonly string[] {
  const linked = linkedChangedIds(next, prev);
  if (linked) return linked;
  const ids = scannedChangedIds(next, prev);
  lastScanSize = keysOf(next).length;
  countFor(consentOrNow(undefined), countScanned);
  return remember(next, prev, ids);
}
