import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { flushPersistence, loadSession, sessionSaved, startPersistence, SESSION_VERSION } = await import("./persist.ts");
const { backupJson, backupName, localDay, newestBackup, rollingBackups, SESSION_BACKUPS } = await import("./sessionSafety.ts");
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
  const picked = newestBackup((doc) => doc, SESSION_VERSION, {}, Date.UTC(2026, 0, 10, 12));
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

test("a failed backup write is tried again on a later save the same day", async () => {
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
  assert.equal(JSON.parse(stub.docs.get(backupName(at))).session.n, 1);
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
  const backup = stub.docs.get(backupName(Date.now()));
  assert.ok(backup, "written at launch, ahead of any session write");
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
