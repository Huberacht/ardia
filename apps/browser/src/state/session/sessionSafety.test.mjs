import assert from "node:assert/strict";
import { test } from "node:test";

const setTimeoutHoldingExit = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => {
  const timer = setTimeoutHoldingExit(callback, ms, ...args);
  return ms >= 1_000 ? timer.unref() : timer;
};
const { useBrowser } = await import("../browser/store.ts");
const { flushPersistence, loadSession, resumePersistence, sessionSaved, sessionWritesBlocked, startPersistence, SESSION_VERSION } = await import("./persist.ts");
const { finishQuitSaves } = await import("../app/quit.ts");
const { BACKUP_RETRY_MS, backupJson, backupName, localDay, MIGRATION_BACKUP, rollingBackups, sessionBackups, SESSION_BACKUPS } = await import("./sessionSafety.ts");
const { parsePinBackups, PINS_BACKUP_DOCUMENT } = await import("./pinGuard.ts");
const { takeSessionWrites } = await import("../telemetry/sessionWrites.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() {
  flushPersistence();
  for (let i = 0; i < 4; i++) {
    await turn();
    flushPersistence();
  }
}
const DAY_MS = 86_400_000;

function clean() {
  stub.docs.clear();
  stub.stagedDocs.clear();
  stub.unreadableDocs.clear();
  stub.copiedDocs.length = 0;
  stub.refusedCopies.on = false;
  stub.refusedSaves.on = false;
  stub.heldCopies.on = false;
  stub.heldCopies.queue.length = 0;
  stub.asyncExists.on = false;
  S().hydrate({});
}

function realSession(urls = ["https://kept.example/one", "https://kept.example/two"], { pin = null } = {}) {
  clean();
  const stop = startPersistence();
  const w = S().createWindow({ url: urls[0] });
  for (const url of urls.slice(1)) S().newTab(w, { url, background: true });
  if (pin) S().pinTabs([S().newTab(w, { url: pin, background: true })], true);
  flushPersistence();
  stop();
  const json = stub.docs.get("session.json");
  clean();
  return json;
}

const asideCopies = () => [...stub.docs.keys(), ...stub.unreadableDocs].filter((name) => /^session-unreadable-\d+-\d+\.json$/.test(name));
const tabUrls = () => Object.values(S().tabs).map((t) => t.url).sort();
const savedUrls = () => JSON.parse(stub.docs.get("session.json")).tabs.map((t) => t.url).sort();

const DAMAGED = {
  empty: "",
  blank: "  \n",
  truncated: null,
  "not an object": "[1,2,3]",
  "bad version": JSON.stringify({ version: "eleven", windows: [] }),
  newer: JSON.stringify({ version: SESSION_VERSION + 1, windows: [], tabs: [] }),
};

for (const [kind, damaged] of Object.entries(DAMAGED)) {
  test(`a session.json that is ${kind} is kept aside, never written over, and the newest backup comes back`, async () => {
    const good = realSession();
    const bad = damaged ?? good.slice(0, Math.floor(good.length / 2));
    stub.docs.set(SESSION_BACKUPS[0], backupJson("2026-01-05", 1, good));
    stub.docs.set("session.json", bad);
    const stop = startPersistence();
    assert.deepEqual(tabUrls(), ["https://kept.example/one", "https://kept.example/two"], "the backup's tabs are back");
    await settle();
    stop();
    const [copy] = asideCopies();
    assert.ok(copy, "the damaged file was copied aside");
    assert.equal(stub.docs.get(copy), bad, "byte for byte");
    assert.deepEqual(savedUrls(), ["https://kept.example/one", "https://kept.example/two"], "the restored session replaced it after the copy landed");
  });
}

test("a session.json that exists but can't be read is copied aside by the store before anything is written", async () => {
  const good = realSession();
  stub.docs.set(SESSION_BACKUPS[3], backupJson("2026-01-05", 1, good));
  stub.unreadableDocs.add("session.json");
  const stop = startPersistence();
  assert.deepEqual(tabUrls(), ["https://kept.example/one", "https://kept.example/two"]);
  await settle();
  stop();
  assert.equal(stub.copiedDocs[0][0], "session.json");
  assert.ok(stub.unreadableDocs.has(stub.copiedDocs[0][1]), "the unread bytes went to the copy");
  assert.deepEqual(savedUrls(), ["https://kept.example/one", "https://kept.example/two"]);
});

test("an unreadable session.json is never written over while the copy keeps failing, and is once it lands", async () => {
  realSession();
  stub.unreadableDocs.add("session.json");
  stub.refusedCopies.on = true;
  const stop = startPersistence();
  S().createWindow({ url: "https://new.example/" });
  await settle();
  await sessionSaved();
  assert.ok(stub.unreadableDocs.has("session.json"), "still the unread file");
  assert.ok(!stub.docs.has("session.json"), "nothing written over it");
  stub.refusedCopies.on = false;
  const now = Date.now;
  Date.now = () => now() + 120_000;
  try {
    await settle();
  } finally {
    Date.now = now;
  }
  stop();
  assert.ok(stub.copiedDocs.length >= 2, "the copy was tried again");
  assert.equal(asideCopies().length, 1);
  assert.deepEqual(savedUrls(), ["https://new.example/"]);
});

test("with no backup, a damaged session.json is kept aside and Ardia starts fresh", async () => {
  clean();
  stub.docs.set("session.json", "{\"version\":11,\"tabs\":[");
  const stop = startPersistence();
  assert.deepEqual(S().windowOrder, []);
  await settle();
  stop();
  assert.equal(stub.docs.get(asideCopies()[0]), "{\"version\":11,\"tabs\":[");
  assert.equal(JSON.parse(stub.docs.get("session.json")).version, SESSION_VERSION);
});

test("when the store answers only later that an unread session.json exists, nothing is written until it is copied", async () => {
  realSession();
  stub.unreadableDocs.add("session.json");
  stub.asyncExists.on = true;
  const stop = startPersistence();
  S().createWindow({ url: "https://later.example/" });
  flushPersistence();
  assert.ok(!stub.docs.has("session.json"), "held while the answer is pending");
  await settle();
  stop();
  assert.equal(stub.copiedDocs.length, 1);
  assert.deepEqual(savedUrls(), ["https://later.example/"]);
});

test("a missing session.json is a first launch: nothing is copied and nothing is restored", async () => {
  const good = realSession();
  stub.docs.set(SESSION_BACKUPS[1], backupJson("2026-01-05", 1, good));
  const stop = startPersistence();
  assert.deepEqual(S().windowOrder, []);
  S().createWindow({ url: "https://first.example/" });
  flushPersistence();
  stop();
  assert.deepEqual(stub.copiedDocs, []);
  assert.deepEqual(savedUrls(), ["https://first.example/"]);
});

test("restore picks the newest backup that reads, skipping damaged, newer and unknown-shaped ones", () => {
  const older = realSession(["https://older.example/"]);
  const newest = realSession(["https://newest.example/"]);
  stub.docs.set(SESSION_BACKUPS[0], backupJson("2026-01-03", 5, older));
  stub.docs.set(SESSION_BACKUPS[1], backupJson("2026-01-04", 1, newest));
  stub.docs.set(SESSION_BACKUPS[2], backupJson("2026-01-05", 9, JSON.stringify({ version: SESSION_VERSION + 1, tabs: [] })));
  stub.docs.set(SESSION_BACKUPS[3], `{"backupDay":"2026-01-06","backupAt":1,"session":{"tabs":`);
  stub.docs.set(SESSION_BACKUPS[4], JSON.stringify({ backupDay: "not a day", session: JSON.parse(older) }));
  stub.docs.set(SESSION_BACKUPS[5], backupJson("2026-01-07", 1, "[]"));
  stub.docs.set("session.json", "nonsense");
  S().hydrate(loadSession());
  assert.deepEqual(tabUrls(), ["https://newest.example/"]);
  const [picked] = sessionBackups((doc) => doc, SESSION_VERSION, {}, Date.UTC(2026, 0, 10, 12));
  assert.equal(picked.day, "2026-01-04");
  assert.ok(picked.ageDays >= 5 && picked.ageDays <= 7);
});

test("a downgrade keeps the newer session.json aside and restores an older-version backup through the migrations", async () => {
  const good = JSON.parse(realSession(["https://before-upgrade.example/"]));
  const v9 = { ...good, version: 9 };
  stub.docs.set(SESSION_BACKUPS[6], backupJson("2026-01-05", 1, JSON.stringify(v9)));
  const newer = JSON.stringify({ ...good, version: SESSION_VERSION + 3 });
  stub.docs.set("session.json", newer);
  const stop = startPersistence();
  assert.deepEqual(tabUrls(), ["https://before-upgrade.example/"]);
  await settle();
  stop();
  assert.equal(stub.docs.get(asideCopies()[0]), newer);
});

test("rolling backups: one per calendar day on the first save, seven kept, a day backed up in an earlier launch left alone", async () => {
  clean();
  const start = new Date(2026, 4, 3, 9).getTime();
  const first = rollingBackups();
  first.afterSave('{"version":11,"n":0}', start);
  await turn();
  first.afterSave('{"version":11,"n":1}', start + 3_600_000);
  await turn();
  assert.equal(JSON.parse(stub.docs.get(backupName(start))).session.n, 0, "only the first save of the day");
  const relaunch = rollingBackups();
  relaunch.afterSave('{"version":11,"n":2}', start + 7_200_000);
  await turn();
  assert.equal(JSON.parse(stub.docs.get(backupName(start))).session.n, 0, "a relaunch the same day keeps the morning's copy");
  for (let day = 1; day <= 9; day++) {
    relaunch.afterSave(`{"version":11,"n":${day + 10}}`, start + day * DAY_MS);
    await turn();
  }
  const kept = SESSION_BACKUPS.filter((name) => stub.docs.has(name)).map((name) => JSON.parse(stub.docs.get(name)));
  assert.equal(kept.length, 7);
  assert.deepEqual(kept.map((b) => b.backupDay).sort(), [3, 4, 5, 6, 7, 8, 9].map((d) => localDay(start + d * DAY_MS)));
  assert.deepEqual(Object.keys(Object.fromEntries(stub.docs)).filter((name) => name.startsWith("session-backup")).length, 7);
});

test("a failed backup write is tried again a few minutes later, not on every save", async () => {
  clean();
  const at = new Date(2026, 4, 3, 9).getTime();
  const backups = rollingBackups();
  stub.refusedSaves.on = true;
  try {
    backups.afterSave('{"version":11,"n":0}', at);
    await turn();
  } finally {
    stub.refusedSaves.on = false;
  }
  stub.stagedDocs.clear();
  backups.afterSave('{"version":11,"n":1}', at + 1000);
  await turn();
  assert.ok(!stub.docs.has(backupName(at)), "not tried again on every save");
  const now = Date.now;
  Date.now = () => now() + BACKUP_RETRY_MS + 1;
  try {
    backups.afterSave('{"version":11,"n":2}', at + 2000);
    await turn();
  } finally {
    Date.now = now;
  }
  assert.equal(JSON.parse(stub.docs.get(backupName(at))).session.n, 2);
});

test("the first save of a launch writes today's backup of the session it saved", async () => {
  clean();
  const stop = startPersistence();
  S().createWindow({ url: "https://today.example/" });
  flushPersistence();
  await turn();
  stop();
  const backup = JSON.parse(stub.docs.get(backupName(Date.now())));
  assert.equal(backup.backupDay, localDay(Date.now()));
  assert.deepEqual(backup.session.tabs.map((t) => t.url), ["https://today.example/"]);
});

test("a session.json that still needs migrating is backed up as it was before the migration rewrites it", async () => {
  const good = JSON.parse(realSession(["https://old-version.example/"]));
  const old = JSON.stringify({ ...good, version: 9 });
  stub.docs.set("session.json", old);
  const stop = startPersistence();
  S().updateTab(Object.keys(S().tabs)[0], { title: "first" });
  flushPersistence();
  assert.equal(stub.docs.get("session.json"), old, "the migrated session waits for the backup");
  await turn();
  const backup = stub.docs.get(backupName(Date.now()));
  assert.ok(backup, "landed before any session write");
  assert.equal(JSON.parse(backup).session.version, 9);
  S().updateTab(Object.keys(S().tabs)[0], { title: "touched" });
  flushPersistence();
  await turn();
  stop();
  assert.equal(JSON.parse(stub.docs.get("session.json")).version, SESSION_VERSION);
  assert.equal(JSON.parse(stub.docs.get(backupName(Date.now()))).session.version, 9, "the day's first save doesn't replace the pre-migration copy");
});

test("a damaged downloads.json is kept aside, by the store or from its text, and not written over until a copy lands", async () => {
  realSession();
  stub.docs.set("session.json", realSession());
  stub.docs.set("downloads.json", "{\"version\":3,\"downloads\":[{");
  stub.refusedCopies.on = true;
  stub.refusedSaves.on = true;
  const stop = startPersistence();
  S().upsertDownload({ id: "d1", url: "https://files.example/a.zip", filename: "a.zip", state: "complete", receivedBytes: 1, totalBytes: 1, startedAt: 0 });
  await settle();
  assert.equal(stub.docs.get("downloads.json"), "{\"version\":3,\"downloads\":[{");
  stub.refusedCopies.on = false;
  stub.refusedSaves.on = false;
  const now = Date.now;
  Date.now = () => now() + 120_000;
  try {
    await settle();
  } finally {
    Date.now = now;
  }
  stop();
  assert.ok(stub.docs.has([...stub.docs.keys()].find((name) => /^downloads-unreadable-/.test(name))));
  assert.equal(JSON.parse(stub.docs.get("downloads.json")).downloads[0].filename, "a.zip");
});

test("pins restored from a backup are still guarded: dropping one first lands it in pins-backup.json", async () => {
  const good = realSession(["https://loose.example/"], { pin: "https://pin.example/" });
  stub.docs.set(SESSION_BACKUPS[2], backupJson("2026-01-05", 1, good));
  stub.docs.set("session.json", "garbage");
  const stop = startPersistence();
  await settle();
  const pinned = Object.values(S().tabs).find((t) => t.pin);
  assert.ok(pinned, "the pin came back from the backup");
  S().pinTabs([pinned.id], false);
  await settle();
  stop();
  const [entry] = parsePinBackups(stub.docs.get(PINS_BACKUP_DOCUMENT));
  assert.deepEqual(Object.values(entry.pins)[0].tabs.map((t) => t.url), ["https://pin.example/"]);
  assert.equal(stub.docs.get(asideCopies()[0]), "garbage");
});

test("telemetry counts the set-aside by reason and whether a backup came back, without content", async () => {
  const good = realSession();
  setConsentPeriod(true, "epoch-session-safety");
  takeSessionWrites();
  try {
    stub.docs.set(SESSION_BACKUPS[0], backupJson(localDay(Date.now() - 2 * DAY_MS), 1, good));
    stub.docs.set("session.json", JSON.stringify({ version: SESSION_VERSION + 1 }));
    stub.docs.set("downloads.json", "");
    const stop = startPersistence();
    await settle();
    stop();
    const counts = takeSessionWrites();
    assert.equal(counts.session_set_aside_newer, 1);
    assert.equal(counts.session_set_aside_invalid, 0);
    assert.equal(counts.session_restored_from_backup, 1);
    assert.equal(counts.session_restored_backup_days_max, 2);
    assert.equal(counts.downloads_set_aside, 1);
    assert.ok(counts.session_backups >= 1);
  } finally {
    setConsentPeriod(false, null);
  }
});

test("a current-version session.json whose core lists aren't lists is kept aside and the backup restored, not hydrated empty and saved over", async () => {
  const good = realSession();
  stub.docs.set(SESSION_BACKUPS[0], backupJson("2026-01-05", 1, good));
  const bad = JSON.stringify({ ...JSON.parse(good), windows: "x", tabs: "y" });
  stub.docs.set("session.json", bad);
  const stop = startPersistence();
  assert.deepEqual(tabUrls(), ["https://kept.example/one", "https://kept.example/two"]);
  await settle();
  stop();
  assert.equal(stub.docs.get(asideCopies()[0]), bad);
});

test("an order entry naming an Object property (windowOrder [\"constructor\"]) is dropped while reading, so that backup restores, passes as today's, and loadSession agrees", async () => {
  const older = realSession(["https://older.example/"]);
  const newest = JSON.parse(realSession(["https://newest.example/"]));
  const tampered = { ...newest, windowOrder: ["constructor"], profileOrder: ["toString"], focusedWindowId: "__proto__" };
  stub.docs.set(SESSION_BACKUPS[0], backupJson("2026-01-03", 1, older));
  stub.docs.set(SESSION_BACKUPS[1], backupJson("2026-01-04", 1, JSON.stringify(tampered)));
  stub.docs.set("session.json", "{");
  assert.deepEqual(Object.values(loadSession().tabs).map((t) => t.url), ["https://newest.example/"]);
  const stop = startPersistence();
  await settle();
  stop();
  assert.deepEqual(tabUrls(), ["https://newest.example/"]);
  const { wholeBackup } = await import("./launchSession.ts");
  assert.equal(wholeBackup(tampered), true);
});

test("when the store can't say whether an unread session.json exists, nothing is written over it", async () => {
  realSession();
  stub.unreadableDocs.add("session.json");
  stub.refusedCopies.on = true;
  const documents = stub.shellNativeModules.ArdiaDocuments;
  const exists = documents.documentExists;
  documents.documentExists = () => {
    throw new Error("probe failed");
  };
  try {
    const stop = startPersistence();
    S().createWindow({ url: "https://new.example/" });
    await settle();
    stop();
  } finally {
    documents.documentExists = exists;
  }
  assert.ok(stub.unreadableDocs.has("session.json"));
  assert.ok(!stub.docs.has("session.json"), "held, not written over");
});

test("a damaged session with no backup keeps the download history", async () => {
  realSession();
  stub.docs.set("session.json", "{");
  stub.docs.set("downloads.json", JSON.stringify({ version: 3, downloads: [{ id: "old", url: "https://files.example/old.zip", filename: "old.zip", state: "complete", receivedBytes: 1, totalBytes: 1, startedAt: 0 }] }));
  const stop = startPersistence();
  S().upsertDownload({ id: "d1", url: "https://files.example/new.zip", filename: "new.zip", state: "complete", receivedBytes: 1, totalBytes: 1, startedAt: 1 });
  await settle();
  stop();
  assert.deepEqual(JSON.parse(stub.docs.get("downloads.json")).downloads.map((d) => d.filename).sort(), ["new.zip", "old.zip"]);
});

test("when the pre-migration backup can't be saved, the migrated session isn't written over the old one", async () => {
  const good = JSON.parse(realSession(["https://old-version.example/"]));
  const old = JSON.stringify({ ...good, version: 9 });
  stub.docs.set("session.json", old);
  stub.refusedSaves.on = true;
  const stop = startPersistence();
  S().updateTab(Object.keys(S().tabs)[0], { title: "touched" });
  await settle();
  assert.equal(stub.docs.get("session.json"), old);
  stub.refusedSaves.on = false;
  stub.stagedDocs.clear();
  const now = Date.now;
  Date.now = () => now() + 120_000;
  try {
    await settle();
  } finally {
    Date.now = now;
  }
  stop();
  assert.equal(JSON.parse(stub.docs.get(backupName(Date.now()))).session.version, 9);
  assert.equal(JSON.parse(stub.docs.get("session.json")).version, SESSION_VERSION);
});

test("when the store answers only later that an unread session.json exists, the newest backup still comes back", async () => {
  const good = realSession();
  stub.docs.set(SESSION_BACKUPS[2], backupJson("2026-01-05", 1, good));
  stub.unreadableDocs.add("session.json");
  stub.asyncExists.on = true;
  const stop = startPersistence();
  assert.deepEqual(tabUrls(), ["https://kept.example/one", "https://kept.example/two"]);
  await settle();
  stop();
  assert.deepEqual(savedUrls(), ["https://kept.example/one", "https://kept.example/two"]);
});

test("quitting waits for a downloads.json copy still landing, then saves the pending download", async () => {
  realSession();
  stub.docs.set("session.json", realSession());
  stub.docs.set("downloads.json", "{\"version\":3,\"downloads\":[{");
  stub.unreadableDocs.add("downloads.json");
  stub.heldCopies.on = true;
  const stop = startPersistence();
  S().upsertDownload({ id: "d1", url: "https://files.example/a.zip", filename: "a.zip", state: "complete", receivedBytes: 1, totalBytes: 1, startedAt: 0 });
  flushPersistence({ final: true });
  const quitting = finishQuitSaves(5_000);
  await turn();
  assert.ok(stub.unreadableDocs.has("downloads.json"), "not written while the copy is landing");
  stub.heldCopies.on = false;
  for (const land of stub.heldCopies.queue.splice(0)) land();
  await quitting;
  stop();
  resumePersistence();
  assert.equal(JSON.parse(stub.docs.get("downloads.json")).downloads[0].filename, "a.zip");
});

test("received tabs wait while the session can't be written, so sync doesn't count them delivered", async () => {
  realSession();
  stub.unreadableDocs.add("session.json");
  stub.heldCopies.on = true;
  const stop = startPersistence();
  assert.equal(sessionWritesBlocked(), true);
  stub.heldCopies.on = false;
  for (const land of stub.heldCopies.queue.splice(0)) land();
  await settle();
  stop();
  assert.equal(sessionWritesBlocked(), false);
});

test("every retry of a failed copy goes to the same file, so failed tries don't pile up", async () => {
  realSession();
  stub.docs.set("session.json", "{");
  stub.refusedCopies.on = true;
  stub.refusedSaves.on = true;
  const stop = startPersistence();
  const now = Date.now;
  let skew = 0;
  Date.now = () => now() + skew;
  try {
    for (let i = 0; i < 4; i++) {
      skew += 120_000;
      await settle();
    }
  } finally {
    Date.now = now;
  }
  stop();
  assert.ok(stub.copiedDocs.length >= 3);
  assert.equal(new Set(stub.copiedDocs.map(([, to]) => to)).size, 1);
});

test("a damaged backup in today's slot is replaced on the day's first save", async () => {
  clean();
  const at = new Date(2026, 4, 3, 9).getTime();
  stub.docs.set(backupName(at), `{"backupDay":"${localDay(at)}","backupAt":1,"session":{"tabs":[`);
  rollingBackups().afterSave('{"version":11,"n":1}', at);
  await turn();
  assert.equal(JSON.parse(stub.docs.get(backupName(at))).session.n, 1);
});

test("a backup that throws while being prepared (session restore off, a numeric pinned URL) is skipped for an older one", async () => {
  const older = realSession(["https://older.example/"]);
  const newest = JSON.parse(realSession(["https://newest.example/"], { pin: "https://pin.example/" }));
  newest.settings = { ...newest.settings, restoreSession: false };
  newest.tabs = newest.tabs.map((t) => (t.pin ? { ...t, pinnedUrl: 42 } : t));
  stub.docs.set(SESSION_BACKUPS[0], backupJson("2026-01-03", 1, older));
  stub.docs.set(SESSION_BACKUPS[1], backupJson("2026-01-04", 1, JSON.stringify(newest)));
  stub.docs.set("session.json", "{");
  const stop = startPersistence();
  await settle();
  stop();
  assert.deepEqual(tabUrls(), ["https://older.example/"]);
});

test("a download row with a numeric profile doesn't stop the launch; the good rows load", async () => {
  stub.docs.set("session.json", realSession());
  stub.docs.set("downloads.json", JSON.stringify({ version: 3, downloads: [{ id: "bad", state: "complete", profile: 5 }, { id: "good", url: "https://files.example/a.zip", filename: "a.zip", state: "complete", receivedBytes: 1, totalBytes: 1, startedAt: 0 }] }));
  const stop = startPersistence();
  await settle();
  stop();
  assert.deepEqual(S().downloads.map((d) => d.filename), ["a.zip"]);
  assert.deepEqual(tabUrls(), ["https://kept.example/one", "https://kept.example/two"]);
});

test("a version stamp alone is not a session: it is kept aside and the backup restored", async () => {
  const good = realSession();
  stub.docs.set(SESSION_BACKUPS[0], backupJson("2026-01-05", 1, good));
  const stamp = JSON.stringify({ version: SESSION_VERSION, hello: "world" });
  stub.docs.set("session.json", stamp);
  const stop = startPersistence();
  assert.deepEqual(tabUrls(), ["https://kept.example/one", "https://kept.example/two"]);
  await settle();
  stop();
  assert.equal(stub.docs.get(asideCopies()[0]), stamp);
});

test("a session whose rows the reader had to drop loads what is whole and keeps the original aside first", async () => {
  const good = JSON.parse(realSession());
  const damaged = JSON.stringify({ ...good, tabs: [...good.tabs, { id: "broken" }, 7] });
  stub.docs.set("session.json", damaged);
  setConsentPeriod(true, "epoch-session-rows");
  takeSessionWrites();
  try {
    const stop = startPersistence();
    assert.deepEqual(tabUrls(), ["https://kept.example/one", "https://kept.example/two"]);
    await settle();
    stop();
    assert.equal(takeSessionWrites().session_set_aside_rows, 1);
  } finally {
    setConsentPeriod(false, null);
  }
  assert.equal(stub.docs.get(asideCopies()[0]), damaged);
  assert.equal(JSON.parse(stub.docs.get("session.json")).tabs.length, 2);
});

test("quitting during a copy's retry wait tries the copy again at once and saves the pending download", async () => {
  stub.docs.set("session.json", realSession());
  stub.docs.set("downloads.json", "{\"version\":3,\"downloads\":[{");
  stub.refusedCopies.on = true;
  stub.refusedSaves.on = true;
  const stop = startPersistence();
  await settle();
  stub.refusedCopies.on = false;
  stub.refusedSaves.on = false;
  S().upsertDownload({ id: "d1", url: "https://files.example/a.zip", filename: "a.zip", state: "complete", receivedBytes: 1, totalBytes: 1, startedAt: 0 });
  flushPersistence({ final: true });
  await finishQuitSaves(3_000);
  stop();
  resumePersistence();
  assert.equal(JSON.parse(stub.docs.get("downloads.json")).downloads[0].filename, "a.zip");
});

test("a write gate runs one copy at a time and takes its success whenever it comes", async () => {
  const { writeGate } = await import("./sessionSafety.ts");
  let runs = 0;
  let finish;
  const gate = writeGate(() => (runs++, new Promise((resolve) => (finish = resolve))), () => {});
  for (let i = 0; i < 5; i++) assert.equal(gate.check().hold, true);
  gate.tryNow();
  assert.equal(runs, 1);
  finish();
  await turn();
  assert.equal(gate.open(), true);
  assert.equal(gate.check().hold, false);
});

test("a failed pre-migration backup is retried on its own, without any local change, and then lets received tabs in", async () => {
  const good = JSON.parse(realSession(["https://old-version.example/"]));
  stub.docs.set("session.json", JSON.stringify({ ...good, version: 9 }));
  stub.refusedSaves.on = true;
  const stop = startPersistence();
  await settle();
  assert.equal(sessionWritesBlocked(), true);
  stub.refusedSaves.on = false;
  stub.stagedDocs.clear();
  const now = Date.now;
  Date.now = () => now() + 120_000;
  try {
    await settle();
  } finally {
    Date.now = now;
  }
  stop();
  assert.equal(sessionWritesBlocked(), false);
  assert.equal(JSON.parse(stub.docs.get(backupName(Date.now()))).session.version, 9);
});

test("today's slot holding a backup that parses but isn't a session is replaced", async () => {
  clean();
  const at = new Date(2026, 4, 3, 9).getTime();
  stub.docs.set(backupName(at), JSON.stringify({ backupDay: localDay(at), backupAt: 1, session: { version: SESSION_VERSION, windows: "bad" } }));
  rollingBackups(() => {}, (value) => value.windows !== "bad" && Array.isArray(value.windows)).afterSave('{"version":11,"windows":[],"tabs":[],"n":1}', at);
  await turn();
  assert.equal(JSON.parse(stub.docs.get(backupName(at))).session.n, 1);
});

test("a pin that hydrating drops (its profile is gone) makes the launch keep the original aside before the first save", async () => {
  const good = JSON.parse(realSession(["https://loose.example/"], { pin: "https://pin.example/" }));
  const orphaned = JSON.stringify({ ...good, tabs: good.tabs.map((t) => (t.pin ? { ...t, profileId: "gone-profile" } : t)) });
  stub.docs.set("session.json", orphaned);
  const stop = startPersistence();
  S().updateSettings({ appearance: "light" });
  await settle();
  stop();
  assert.equal(stub.docs.get(asideCopies()[0]), orphaned, "the dropped pin is still on disk, beside");
});

test("an intact older backup wins over a newer one whose rows the reader had to drop", async () => {
  const older = realSession(["https://older.example/"], { pin: "https://pin.example/" });
  const newest = JSON.parse(realSession(["https://newest.example/"]));
  stub.docs.set(SESSION_BACKUPS[0], backupJson("2026-01-03", 1, older));
  stub.docs.set(SESSION_BACKUPS[1], backupJson("2026-01-04", 1, JSON.stringify({ ...newest, tabs: [...newest.tabs, { id: "half" }] })));
  stub.docs.set("session.json", "{");
  const stop = startPersistence();
  await settle();
  stop();
  assert.ok(tabUrls().includes("https://older.example/"));
  assert.ok(tabUrls().includes("https://pin.example/"));
});

test("a damaged backup is the fallback when it is the only one, with what of it is whole", async () => {
  const newest = JSON.parse(realSession(["https://only.example/"]));
  stub.docs.set(SESSION_BACKUPS[1], backupJson("2026-01-04", 1, JSON.stringify({ ...newest, tabs: [...newest.tabs, { id: "half" }] })));
  stub.docs.set("session.json", "{");
  const stop = startPersistence();
  await settle();
  stop();
  assert.deepEqual(tabUrls(), ["https://only.example/"]);
});

test("a backup slot written by a newer Ardia is left alone by an older one", async () => {
  clean();
  const at = new Date(2026, 4, 3, 9).getTime();
  const newer = backupJson(localDay(at - 7 * DAY_MS), 1, JSON.stringify({ version: SESSION_VERSION + 1, windows: [], tabs: [] }));
  stub.docs.set(backupName(at), newer);
  const { newerBackup, wholeBackup } = await import("./launchSession.ts");
  rollingBackups(() => {}, wholeBackup, (_, session) => newerBackup(session)).afterSave('{"version":11,"windows":[],"tabs":[]}', at);
  await turn();
  assert.equal(stub.docs.get(backupName(at)), newer);
});

test("today's slot holding a backup that reads but can't be restored (a numeric pinnedUrl) is written again", async () => {
  const bad = JSON.parse(realSession(["https://x.example/"], { pin: "https://pin.example/" }));
  clean();
  const at = new Date(2026, 4, 3, 9).getTime();
  stub.docs.set(backupName(at), backupJson(localDay(at), 1, JSON.stringify({ ...bad, tabs: bad.tabs.map((t) => (t.pin ? { ...t, pinnedUrl: 42 } : t)) })));
  const { newerBackup, wholeBackup } = await import("./launchSession.ts");
  rollingBackups(() => {}, wholeBackup, (_, session) => newerBackup(session)).afterSave('{"version":11,"windows":[],"tabs":[],"n":1}', at);
  await turn();
  assert.equal(JSON.parse(stub.docs.get(backupName(at))).session.n, 1);
});

test("download rows the reader rejects keep downloads.json aside before it is rewritten, and the good rows load", async () => {
  stub.docs.set("session.json", realSession());
  const original = JSON.stringify({ version: 3, downloads: [{ id: "bad", state: "complete", profile: 5 }, { id: "good", url: "https://files.example/a.zip", filename: "a.zip", state: "complete", receivedBytes: 1, totalBytes: 1, startedAt: 0 }] });
  stub.docs.set("downloads.json", original);
  const stop = startPersistence();
  S().upsertDownload({ id: "d1", url: "https://files.example/b.zip", filename: "b.zip", state: "complete", receivedBytes: 1, totalBytes: 1, startedAt: 1 });
  await settle();
  stop();
  const aside = [...stub.docs.keys()].find((name) => /^downloads-unreadable-/.test(name));
  assert.equal(stub.docs.get(aside), original);
  assert.deepEqual(JSON.parse(stub.docs.get("downloads.json")).downloads.map((d) => d.filename).sort(), ["a.zip", "b.zip"]);
});

test("loadSession picks the same session launch does, skipping a backup that throws while it is prepared", () => {
  const older = realSession(["https://older.example/"]);
  const newest = JSON.parse(realSession(["https://newest.example/"], { pin: "https://pin.example/" }));
  newest.settings = { ...newest.settings, restoreSession: false };
  newest.tabs = newest.tabs.map((t) => (t.pin ? { ...t, pinnedUrl: 42 } : t));
  stub.docs.set(SESSION_BACKUPS[0], backupJson("2026-01-03", 1, older));
  stub.docs.set(SESSION_BACKUPS[1], backupJson("2026-01-04", 1, JSON.stringify(newest)));
  stub.docs.set("session.json", "{");
  const data = loadSession();
  assert.deepEqual(Object.values(data.tabs).map((t) => t.url), ["https://older.example/"]);
});

test("a pre-migration backup never replaces a newer Ardia's backup in today's slot; it goes to its own file and still gates the rewrite", async () => {
  const good = JSON.parse(realSession(["https://v10.example/"]));
  const newer = backupJson(localDay(Date.now()), 1, JSON.stringify({ ...good, version: SESSION_VERSION + 1 }));
  stub.docs.set(backupName(Date.now()), newer);
  const old = JSON.stringify({ ...good, version: 10 });
  stub.docs.set("session.json", old);
  const stop = startPersistence();
  S().updateTab(Object.keys(S().tabs)[0], { title: "touched" });
  flushPersistence();
  assert.equal(stub.docs.get("session.json"), old, "held until the snapshot lands");
  await settle();
  stop();
  assert.equal(stub.docs.get(backupName(Date.now())), newer);
  assert.equal(JSON.parse(stub.docs.get(MIGRATION_BACKUP)).session.version, 10);
  assert.equal(JSON.parse(stub.docs.get("session.json")).version, SESSION_VERSION);
});

test("a partial backup that a launch restored from is copied aside before its slot is written again", async () => {
  const good = JSON.parse(realSession(["https://loose.example/"], { pin: "https://pin.example/" }));
  const partial = backupJson(localDay(Date.now()), 1, JSON.stringify({ ...good, tabs: good.tabs.map((t) => (t.pin ? { ...t, profileId: "gone-profile" } : t)) }));
  stub.docs.set(backupName(Date.now()), partial);
  stub.docs.set("session.json", "{");
  const stop = startPersistence();
  S().updateSettings({ appearance: "light" });
  await settle();
  stop();
  const kept = [...stub.docs.entries()].find(([name]) => /^session-backup-\w+-unreadable-/.test(name));
  assert.ok(kept, "the restored backup was kept aside");
  assert.equal(kept[1], partial);
  assert.ok(kept[1].includes("https://pin.example/"));
});

test("parked pins the reader has to discard keep session.json aside before the first save", async () => {
  const good = JSON.parse(realSession(["https://a.example/"]));
  const profileId = Object.keys(good.profiles)[0];
  const damaged = JSON.stringify({ ...good, parkedPins: { [profileId]: { tabs: [{ id: "p", url: "https://parked.example/", profileId }], groups: "broken" } } });
  stub.docs.set("session.json", damaged);
  const stop = startPersistence();
  S().updateSettings({ appearance: "light" });
  await settle();
  stop();
  assert.equal(stub.docs.get(asideCopies()[0]), damaged);
});
