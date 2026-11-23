import { copyDocument, documentExists, readDocument, saveDocument, writeDocument } from "../../platform/documents";
import { isFields, isString } from "../../lib/decode";
import { readSaved, readSavedValue, type Migrations, type SavedObject, type SavedProblem } from "../../lib/savedDocument";

export type UnusableReason = SavedProblem | "unreadable";
export type FoundDocument =
  | { state: "missing" }
  | { state: "usable"; text: string; doc: SavedObject; from: number }
  | { state: "unusable"; reason: UnusableReason; text: string | null }
  | { state: "unknown"; exists: Promise<boolean> };

export function findDocument(name: string, version: number, migrations: Migrations): FoundDocument {
  let text: unknown = null;
  try {
    text = readDocument(name);
  } catch {
    text = null;
  }
  if (typeof text === "string") {
    const read = readSaved(text, version, migrations);
    return "doc" in read ? { state: "usable", text, doc: read.doc, from: read.from } : { state: "unusable", reason: read.problem, text };
  }
  let exists: boolean | Promise<boolean>;
  try {
    exists = documentExists(name);
  } catch {
    exists = false;
  }
  if (exists === false) return { state: "missing" };
  if (exists === true) return { state: "unusable", reason: "unreadable", text: null };
  return { state: "unknown", exists: Promise.resolve(exists).then((found) => found !== false, () => true) };
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
export type WriteGate = { check: () => WriteCheck; landing: () => Promise<void> | null };

export const GATE_RETRY_MS = 2_000;
export const MAX_GATE_RETRY_MS = 60_000;
const OPEN: WriteCheck = { hold: false };

export function writeGate(task: () => Promise<void>, saveAgain: (delay: number) => void, failed: () => void = () => {}): WriteGate {
  let open = false;
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
    landing = attempt.then(
      () => {
        open = true;
        landing = null;
        saveAgain(0);
      },
      () => {
        landing = null;
        failures++;
        failed();
        const delay = Math.min(MAX_GATE_RETRY_MS, GATE_RETRY_MS * 2 ** (failures - 1));
        againAt = Date.now() + delay;
        saveAgain(delay);
      },
    );
  };
  start();
  return {
    check: () => {
      if (open) return OPEN;
      if (landing) return { hold: true, againIn: null };
      const wait = againAt - Date.now();
      if (wait > 0) return { hold: true, againIn: wait };
      start();
      return { hold: true, againIn: null };
    },
    landing: () => landing,
  };
}

export function keepAsideGate(name: string, found: FoundDocument, saveAgain: (delay: number) => void, noted: { unreadable: () => void; failed: () => void }): WriteGate | null {
  if (found.state === "unusable") return writeGate(() => keepCopy(name, asideName(name), found.text), saveAgain, noted.failed);
  if (found.state !== "unknown") return null;
  const keep = () =>
    found.exists.then((exists) => {
      if (!exists) return;
      noted.unreadable();
      return keepCopy(name, asideName(name), null);
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

export type RestoredBackup<T> = { value: T; name: string; day: string; ageDays: number };

export function newestBackup<T>(parse: (doc: SavedObject) => T | null, version: number, migrations: Migrations, now = Date.now()): RestoredBackup<T> | null {
  const found: { name: string; day: string; at: number; session: unknown }[] = [];
  for (const name of SESSION_BACKUPS) {
    let text: unknown = null;
    try {
      text = readDocument(name);
    } catch {
      continue;
    }
    if (typeof text !== "string" || !text) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isFields(raw) || !isString(raw.backupDay) || !DAY.test(raw.backupDay)) continue;
    found.push({ name, day: raw.backupDay, at: typeof raw.backupAt === "number" ? raw.backupAt : 0, session: raw.session });
  }
  found.sort((a, b) => b.day.localeCompare(a.day) || b.at - a.at);
  for (const backup of found) {
    const read = readSavedValue(backup.session, version, migrations);
    if (!("doc" in read)) continue;
    let value: T | null = null;
    try {
      value = parse(read.doc);
    } catch {
      value = null;
    }
    if (value === null) continue;
    return { value, name: backup.name, day: backup.day, ageDays: Math.max(0, dayNumber(localDay(now)) - dayNumber(backup.day)) };
  }
  return null;
}

export type RollingBackups = { afterSave: (sessionJson: string, now?: number) => void; beforeMigration: (sessionText: string, now?: number) => boolean };

export function rollingBackups(written: (beforeMigration: boolean) => void = () => {}): RollingBackups {
  let doneDay: string | null = null;
  let writing = false;
  const write = (sessionJson: string, now: number) => {
    const day = localDay(now);
    writing = true;
    return saveDocument(backupName(now), backupJson(day, now, sessionJson)).then(
      () => {
        writing = false;
        doneDay = day;
        written(false);
      },
      () => {
        writing = false;
      },
    );
  };
  return {
    afterSave: (sessionJson, now = Date.now()) => {
      const day = localDay(now);
      if (doneDay === day || writing) return;
      let held: unknown = null;
      try {
        held = readDocument(backupName(now));
      } catch {
        held = null;
      }
      if (typeof held === "string" && held.startsWith(backupHead(day))) {
        doneDay = day;
        return;
      }
      void write(sessionJson, now);
    },
    beforeMigration: (sessionText, now = Date.now()) => {
      try {
        writeDocument(backupName(now), backupJson(localDay(now), now, sessionText.trim()));
      } catch {
        return false;
      }
      written(true);
      return true;
    },
  };
}
