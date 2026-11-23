import { copyDocument, documentExists, readDocument, saveDocument } from "../../platform/documents";
import { isFields, isString } from "../../lib/decode";
import { readSaved, readSavedValue, type Migrations, type SavedObject, type SavedProblem } from "../../lib/savedDocument";

export type UnusableReason = SavedProblem | "unreadable" | "rows";
export type FoundDocument =
  | { state: "missing" }
  | { state: "usable"; text: string; doc: SavedObject; from: number }
  | { state: "unusable"; reason: UnusableReason; text: string | null }
  | { state: "unknown"; exists: Promise<boolean> };

export function findDocument(name: string, version: number, migrations: Migrations, whole: (doc: SavedObject) => boolean = () => true): FoundDocument {
  let text: unknown = null;
  try {
    text = readDocument(name);
  } catch {
    text = null;
  }
  if (typeof text === "string") {
    const read = readSaved(text, version, migrations);
    if (!("doc" in read)) return { state: "unusable", reason: read.problem, text };
    return whole(read.doc) ? { state: "usable", text, doc: read.doc, from: read.from } : { state: "unusable", reason: "shape", text };
  }
  let exists: boolean | Promise<boolean>;
  try {
    exists = documentExists(name);
  } catch {
    exists = true;
  }
  if (exists === false) return { state: "missing" };
  if (exists === true) return { state: "unusable", reason: "unreadable", text: null };
  return { state: "unknown", exists: Promise.resolve(exists).then((found) => found !== false, () => true) };
}

const listOrAbsent = (value: unknown) => value === undefined || Array.isArray(value);
const fieldsOrAbsent = (value: unknown) => value === undefined || isFields(value);

const SESSION_LISTS = ["windows", "tabs", "groups", "splits", "windowOrder", "profileOrder", "closedTabs", "closedWindows"];
const SESSION_OBJECTS = ["profiles", "settings", "parkedPins"];

export const wholeSession = (doc: SavedObject) =>
  [...SESSION_LISTS, ...SESSION_OBJECTS].some((key) => doc[key] !== undefined) &&
  SESSION_LISTS.every((key) => listOrAbsent(doc[key])) &&
  SESSION_OBJECTS.every((key) => fieldsOrAbsent(doc[key]));

export const wholeDownloads = (doc: SavedObject) => Array.isArray(doc.downloads);

export function usableSessionValue(value: unknown, version: number, migrations: Migrations): SavedObject | null {
  const read = readSavedValue(value, version, migrations);
  return "doc" in read && wholeSession(read.doc) ? read.doc : null;
}

let asideCount = 0;

export const asideName = (name: string, now = Date.now()) => `${name.replace(/\.json$/, "")}-unreadable-${now}-${++asideCount}.json`;

export function keepCopy(name: string, copy: string, text: string | null): Promise<void> {
  const fallback = (error: unknown) => (text === null ? Promise.reject(error) : saveDocument(copy, text));
  try {
    return Promise.resolve(copyDocument(name, copy)).catch(fallback);
  } catch (error) {
    return fallback(error);
  }
}

export type WriteCheck = { hold: false } | { hold: true; againIn: number | null };
export type WriteGate = { check: () => WriteCheck; landing: () => Promise<void> | null; open: () => boolean; tryNow: () => void };

export const GATE_RETRY_MS = 2_000;
export const MAX_GATE_RETRY_MS = 60_000;
export const GATE_TIMEOUT_MS = 30_000;
const OPEN: WriteCheck = { hold: false };

function bounded(attempt: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, GATE_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([attempt, waited]).finally(() => clearTimeout(timer));
}

export function writeGate(task: () => Promise<void>, saveAgain: (delay: number) => void, failed: () => void = () => {}): WriteGate {
  let open = false;
  let running: Promise<void> | null = null;
  let landing: Promise<void> | null = null;
  let failures = 0;
  let againAt = 0;
  const start = () => {
    let attempt: Promise<void>;
    try {
      attempt = task();
    } catch (error) {
      attempt = Promise.reject(error);
    }
    const mine: Promise<void> = attempt.then(
      () => {
        open = true;
        running = null;
        saveAgain(0);
      },
      () => {
        running = null;
        failures++;
        failed();
        const delay = Math.min(MAX_GATE_RETRY_MS, GATE_RETRY_MS * 2 ** (failures - 1));
        againAt = Date.now() + delay;
        saveAgain(delay);
      },
    );
    running = mine;
    const waiting: Promise<void> = bounded(mine).then(() => {
      if (landing === waiting) landing = null;
    });
    landing = waiting;
  };
  start();
  return {
    check: () => {
      if (open) return OPEN;
      if (running) return { hold: true, againIn: null };
      const wait = againAt - Date.now();
      if (wait > 0) return { hold: true, againIn: wait };
      start();
      return { hold: true, againIn: null };
    },
    landing: () => (open ? null : landing),
    open: () => open,
    tryNow: () => {
      if (!open && !running) start();
    },
  };
}

export function keepAsideGate(name: string, found: FoundDocument, saveAgain: (delay: number) => void, noted: { unreadable: () => void; failed: () => void }): WriteGate | null {
  if (found.state !== "unusable" && found.state !== "unknown") return null;
  const aside = asideName(name);
  if (found.state === "unusable") return writeGate(() => keepCopy(name, aside, found.text), saveAgain, noted.failed);
  let counted = false;
  const keep = () =>
    found.exists.then((exists) => {
      if (!exists) return;
      if (!counted) noted.unreadable();
      counted = true;
      return keepCopy(name, aside, null);
    });
  return writeGate(keep, saveAgain, noted.failed);
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export const SESSION_BACKUPS = WEEKDAYS.map((day) => `session-backup-${day}.json`);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const twoDigits = (n: number) => String(n).padStart(2, "0");
export const localDay = (now: number) => {
  const at = new Date(now);
  return `${at.getFullYear()}-${twoDigits(at.getMonth() + 1)}-${twoDigits(at.getDate())}`;
};
export const backupName = (now: number) => SESSION_BACKUPS[new Date(now).getDay()]!;
const backupHead = (day: string) => `{"backupDay":${JSON.stringify(day)}`;
export const backupJson = (day: string, at: number, sessionJson: string) => `${backupHead(day)},"backupAt":${Math.round(at)},"session":${sessionJson}}`;

const dayNumber = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!) / 86_400_000;
};

type BackupFile = { name: string; day: string; at: number; session: unknown };

function readBackup(name: string): BackupFile | null {
  let text: unknown = null;
  try {
    text = readDocument(name);
  } catch {
    return null;
  }
  if (typeof text !== "string" || !text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isFields(raw) || !isString(raw.backupDay) || !DAY.test(raw.backupDay) || !isFields(raw.session)) return null;
  return { name, day: raw.backupDay, at: typeof raw.backupAt === "number" ? raw.backupAt : 0, session: raw.session };
}

export type RestoredBackup<T> = { value: T; name: string; day: string; ageDays: number };

export function sessionBackups<T>(parse: (doc: SavedObject) => T | null, version: number, migrations: Migrations, now = Date.now()): RestoredBackup<T>[] {
  const found = SESSION_BACKUPS.map(readBackup).filter((b): b is BackupFile => b !== null);
  found.sort((a, b) => b.day.localeCompare(a.day) || b.at - a.at);
  const today = dayNumber(localDay(now));
  const usable: RestoredBackup<T>[] = [];
  for (const backup of found) {
    const doc = usableSessionValue(backup.session, version, migrations);
    if (!doc) continue;
    let value: T | null = null;
    try {
      value = parse(doc);
    } catch {
      value = null;
    }
    if (value !== null) usable.push({ value, name: backup.name, day: backup.day, ageDays: Math.max(0, today - dayNumber(backup.day)) });
  }
  return usable;
}

export const BACKUP_RETRY_MS = 5 * 60_000;

export type RollingBackups = { afterSave: (sessionJson: string, now?: number) => void; beforeMigration: (sessionText: string, now?: number) => Promise<void> };

export function rollingBackups(written: (beforeMigration: boolean) => void = () => {}, usable: (session: unknown) => unknown = () => true): RollingBackups {
  let doneDay: string | null = null;
  let writing = false;
  let retryAt = 0;
  const write = (sessionJson: string, now: number, beforeMigration: boolean) => {
    const day = localDay(now);
    writing = true;
    return saveDocument(backupName(now), backupJson(day, now, sessionJson)).then(
      () => {
        writing = false;
        doneDay = day;
        written(beforeMigration);
      },
      (error: unknown) => {
        writing = false;
        retryAt = Date.now() + BACKUP_RETRY_MS;
        throw error;
      },
    );
  };
  const heldToday = (now: number, day: string) => {
    const held = readBackup(backupName(now));
    return held?.day === day && !!usable(held.session);
  };
  return {
    afterSave: (sessionJson, now = Date.now()) => {
      const day = localDay(now);
      if (doneDay === day || writing || Date.now() < retryAt) return;
      if (heldToday(now, day)) {
        doneDay = day;
        return;
      }
      void write(sessionJson, now, false).catch(() => {});
    },
    beforeMigration: (sessionText, now = Date.now()) => write(sessionText.trim(), now, true),
  };
}
