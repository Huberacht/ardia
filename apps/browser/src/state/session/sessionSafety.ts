import { copyDocument, documentExists, listDocuments, readDocument, removeDocument, saveDocument } from "../../platform/documents";
import { consentToken, type ConsentToken } from "../telemetry/consentPeriod";
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

const SESSION_LISTS = ["windows", "tabs", "groups", "splits", "windowOrder", "profileOrder"];
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

export function keepCopy(name: string, copy: string): Promise<void> {
  try {
    return Promise.resolve(copyDocument(name, copy));
  } catch (error) {
    return Promise.reject(error);
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
  if (found.state === "unusable") return writeGate(() => keepCopy(name, aside), saveAgain, noted.failed);
  let counted = false;
  const keep = () =>
    found.exists.then((exists) => {
      if (!exists) return;
      if (!counted) noted.unreadable();
      counted = true;
      return keepCopy(name, aside);
    });
  return writeGate(keep, saveAgain, noted.failed);
}

export const DAILY_BACKUP = "session-backup-";
export const MIGRATION_BACKUP = "session-premigration-";
export const DAILY_BACKUPS_KEPT = 7;
export const MIGRATION_BACKUPS_KEPT = 3;
export const BACKUP_EVERY_MS = 24 * 60 * 60_000;
export const BACKUP_RETRY_MS = 5 * 60_000;

type BackupName = { name: string; at: number };
type BackupFile = BackupName & { session: unknown };

const STAMP = /^(\d{1,16})\.json$/;

function backupNames(prefix: string): BackupName[] {
  let names: unknown = [];
  try {
    names = listDocuments(prefix);
  } catch {
    names = [];
  }
  if (!Array.isArray(names)) return [];
  return names
    .filter((name): name is string => typeof name === "string" && name.startsWith(prefix))
    .flatMap((name) => {
      const stamp = STAMP.exec(name.slice(prefix.length));
      return stamp ? [{ name, at: Number(stamp[1]) }] : [];
    })
    .sort((a, b) => b.at - a.at);
}

export const backupJson = (at: number, sessionJson: string) => `{"backupAt":${Math.round(at)},"session":${sessionJson}}`;

function readBackup({ name, at }: BackupName): BackupFile | null {
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
  if (!isFields(raw) || !isFields(raw.session)) return null;
  return { name, at: typeof raw.backupAt === "number" && Number.isFinite(raw.backupAt) ? raw.backupAt : at, session: raw.session };
}

export type RestoredBackup<T> = { value: T; name: string; at: number; ageDays: number };

export function sessionBackups<T>(parse: (doc: SavedObject) => T | null, version: number, migrations: Migrations, now = Date.now()): RestoredBackup<T>[] {
  const found = [...backupNames(DAILY_BACKUP), ...backupNames(MIGRATION_BACKUP)].map(readBackup).filter((b): b is BackupFile => b !== null);
  found.sort((a, b) => b.at - a.at);
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
    if (value !== null) usable.push({ value, name: backup.name, at: backup.at, ageDays: Math.max(0, Math.floor((now - backup.at) / BACKUP_EVERY_MS)) });
  }
  return usable;
}

export type RollingBackups = { afterSave: (sessionJson: string, now?: number) => void; beforeMigration: (sessionText: string, now?: number) => Promise<void> };
export type BackupRules = { whole: (session: unknown) => boolean; recovering: () => boolean; written: (beforeMigration: boolean, consent: ConsentToken | null) => void };

function freshName(prefix: string, now: number): string {
  const taken = new Set(backupNames(prefix).map((b) => b.name));
  let at = Math.max(0, Math.round(now));
  while (taken.has(`${prefix}${at}.json`)) at++;
  return `${prefix}${at}.json`;
}

export function rollingBackups(rules: BackupRules): RollingBackups {
  let writing = false;
  let nextCheckAt = 0;
  let retryAt = 0;
  const prune = (prefix: string, kept: number, written: string) => {
    if (rules.recovering()) return;
    const names = backupNames(prefix);
    const newestWhole = names.find((b) => rules.whole(readBackup(b)?.session))?.name;
    for (const { name } of names.slice(kept)) {
      if (name === written || name === newestWhole) continue;
      try {
        removeDocument(name);
      } catch {
        continue;
      }
    }
  };
  const write = (prefix: string, kept: number, sessionJson: string, now: number, beforeMigration: boolean) => {
    const name = freshName(prefix, now);
    const consent = consentToken();
    writing = true;
    return saveDocument(name, backupJson(now, sessionJson)).then(
      () => {
        writing = false;
        rules.written(beforeMigration, consent);
        prune(prefix, kept, name);
      },
      (error: unknown) => {
        writing = false;
        retryAt = Date.now() + BACKUP_RETRY_MS;
        throw error;
      },
    );
  };
  return {
    afterSave: (sessionJson, now = Date.now()) => {
      if (writing || now < nextCheckAt || Date.now() < retryAt) return;
      const recent = backupNames(DAILY_BACKUP).find((b) => Math.abs(now - b.at) < BACKUP_EVERY_MS && rules.whole(readBackup(b)?.session));
      if (recent) {
        nextCheckAt = now + BACKUP_EVERY_MS - Math.abs(now - recent.at);
        return;
      }
      void write(DAILY_BACKUP, DAILY_BACKUPS_KEPT, sessionJson, now, false).then(
        () => void (nextCheckAt = now + BACKUP_EVERY_MS),
        () => {},
      );
    },
    beforeMigration: (sessionText, now = Date.now()) => write(MIGRATION_BACKUP, MIGRATION_BACKUPS_KEPT, sessionText.trim(), now, true),
  };
}
