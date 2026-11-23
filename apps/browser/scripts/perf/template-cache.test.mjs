import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copyCachedTemplate, defaultCacheDir, entryProblems, keyId, keyProblems, lookupTemplate, storeTemplate, templateKey, uboVersion } from "./template-cache.mjs";
import { componentsMismatch } from "./template-state.mjs";
import { UBO_ID } from "./ubo-cache.mjs";

const MB = 1048576;
const HOUR = 3600_000;
const identity = { version: "0.2.48", build: "139", cdhash: "ab12", ubo: "1.62.0" };
const key = templateKey({ identity, bundleSha: "beef", pagePort: 9476 });
const components = { CertificateRevocation: { version: "10918", checked: true }, PKIMetadata: { version: "1839", checked: true } };

const withDir = (fn) => async () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-template-cache-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

function fakeTemplate(dir, { storeMB = 34, blobsMB = 21 } = {}) {
  const store = join(dir, "Chromium", "Default", "Local Extension Settings", UBO_ID);
  const blobs = join(dir, "Chromium", "Default", "IndexedDB", `chrome-extension_${UBO_ID}_0.indexeddb.blob`, "1");
  mkdirSync(store, { recursive: true });
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(store, "000003.ldb"), Buffer.alloc(storeMB * MB));
  writeFileSync(join(store, "000004.log"), "x");
  writeFileSync(join(blobs, "1"), Buffer.alloc(blobsMB * MB));
  writeFileSync(join(dir, "session.json"), "{}");
  return { sizes: { uboStoreMB: storeMB + 1 / MB, uboBlobsMB: blobsMB, uboLogMB: 1 / MB }, components };
}

test("the key covers the app build, its code and uBO, the bench bundle and the page port, and any change gives another id", () => {
  assert.deepEqual(Object.keys(key).sort(), ["build", "bundleSha", "cdhash", "pagePort", "recipe", "revision", "ubo", "version"]);
  const ids = new Set([key, { ...key, build: "140" }, { ...key, cdhash: "cd34" }, { ...key, ubo: "1.63.0" }, { ...key, bundleSha: "f00d" }, { ...key, pagePort: 9477 }, { ...key, revision: key.revision + 1 }].map(keyId));
  assert.equal(ids.size, 7);
  assert.equal(keyId({ ...key }), keyId(Object.fromEntries(Object.entries(key).reverse())));
});

test("a key with an unknown part isn't cached: a random page port, an unsigned app or a missing uBO", () => {
  assert.deepEqual(keyProblems(key), []);
  assert.deepEqual(keyProblems({ ...key, pagePort: 0 }), ["the key's pagePort is unknown"]);
  assert.deepEqual(keyProblems({ ...key, cdhash: null, ubo: undefined }), ["the key's cdhash is unknown", "the key's ubo is unknown"]);
});

test("an entry is refused when any key part changed, when it is too old, or when its record or files are off", () => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  const record = { sizes: { uboStoreMB: 34, uboBlobsMB: 21, uboLogMB: 0 }, components };
  const entry = { key, made: new Date(now - 2 * HOUR).toISOString(), record };
  assert.deepEqual(entryProblems(entry, key, { now }), []);
  assert.match(entryProblems(entry, { ...key, build: "140" }, { now }).join(), /build changed \(139 → 140\)/);
  assert.match(entryProblems(entry, { ...key, ubo: "1.63.0" }, { now }).join(), /ubo changed/);
  assert.match(entryProblems({ ...entry, made: new Date(now - 13 * HOUR).toISOString() }, key, { now }).join(), /13\.0 h old, over 12 h/);
  assert.deepEqual(entryProblems({ ...entry, made: new Date(now - 13 * HOUR).toISOString() }, key, { now, maxAgeHours: 24 }), []);
  assert.match(entryProblems({ ...entry, made: new Date(now + HOUR).toISOString() }, key, { now }).join(), /no valid date/);
  assert.match(entryProblems({ ...entry, record: { ...record, sizes: { ...record.sizes, uboStoreMB: 3 } } }, key, { now }).join(), /uBO's store is 3\.0 MB/);
  assert.match(entryProblems({ ...entry, record: { ...record, components: { PKIMetadata: { version: null } } } }, key, { now }).join(), /PKIMetadata isn't installed/);
  assert.match(entryProblems(entry, key, { now, sizes: { ...record.sizes, uboBlobsMB: 20 } }).join(), /files changed/);
  assert.deepEqual(entryProblems(null, key), ["no cached template"]);
});

test("store then look up: a hit copies the very template back, and a new build, a stale entry or an edited file misses", withDir((dir) => {
  const cache = join(dir, "cache");
  const made = join(dir, "made");
  const record = fakeTemplate(made);
  const now = Date.now();
  storeTemplate(cache, key, made, record, { now: now - HOUR });
  const hit = lookupTemplate(cache, key, { now });
  assert.equal(hit.hit, true, hit.problems?.join());
  const into = join(dir, "side", "template");
  copyCachedTemplate(hit, into);
  assert.equal(lookupTemplate(join(dir, "nothing"), key).hit, false);
  assert.deepEqual(lookupTemplate(cache, { ...key, build: "140" }).problems, ["no cached template"]);
  assert.match(lookupTemplate(cache, key, { now: now + 12 * HOUR }).problems.join(), /over 12 h/);
  writeFileSync(join(hit.template, "Chromium", "Default", "Local Extension Settings", UBO_ID, "000005.ldb"), Buffer.alloc(MB));
  assert.match(lookupTemplate(cache, key, { now }).problems.join(), /files changed/);
  storeTemplate(cache, key, made, record, { now });
  assert.equal(lookupTemplate(cache, key, { now }).hit, true);
}));

test("templates of a release build live with it in dist; anything else in the bench's out dir", () => {
  assert.equal(defaultCacheDir("/r/dist/0.2.48/export/Ardia.app", "/o"), "/r/dist/0.2.48/bench/templates");
  assert.equal(defaultCacheDir("/r/dist/0.2.49-rc/export/Ardia.app", "/o"), "/r/dist/0.2.49-rc/bench/templates");
  assert.equal(defaultCacheDir("/tmp/dl/Ardia.app", "/o"), "/o/.templates");
  assert.equal(defaultCacheDir("/r/build/export/Ardia.app", "/o"), "/o/.templates");
});

test("uBO's version comes from the bundled extension's manifest", withDir((dir) => {
  assert.equal(uboVersion(join(dir, "Ardia.app")), null);
  mkdirSync(join(dir, "Ardia.app/Contents/Resources/Extensions/ublock"), { recursive: true });
  writeFileSync(join(dir, "Ardia.app/Contents/Resources/Extensions/ublock/manifest.json"), JSON.stringify({ version: "1.62.0" }));
  assert.equal(uboVersion(join(dir, "Ardia.app")), "1.62.0");
}));

test("the two sides' templates must carry the same startup component versions", () => {
  assert.deepEqual(componentsMismatch([{ components }, { components }]), []);
  assert.deepEqual(componentsMismatch([{ components }]), []);
  assert.deepEqual(componentsMismatch([{ components }, { components: { ...components, CertificateRevocation: { version: "10920" } } }]), ["component CertificateRevocation differs (10918 vs 10920)"]);
});

test("xbench's templates carry their own check (a restored page) and extra key parts, and skip the size check when there's no uBO", withDir((dir) => {
  const cache = join(dir, "cache");
  const made = join(dir, "made");
  mkdirSync(join(made, "home"), { recursive: true });
  const xkey = templateKey({ identity: { ...identity, ubo: "none" }, bundleSha: "none", pagePort: 9462, recipe: "xbench-dia", harness: 1, launchTab: "on", window: "40,80", screen: 1117, env: "none" });
  assert.deepEqual(keyProblems(xkey), []);
  assert.notEqual(keyId(xkey), keyId({ ...xkey, window: "0,0" }));
  const validate = (record) => (record?.pages?.length ? [] : ["it restores no page"]);
  storeTemplate(cache, xkey, made, { pages: ["http://127.0.0.1:9462/static?id=seed"], sizes: null });
  assert.equal(lookupTemplate(cache, xkey, { validate, sizesOf: () => null }).hit, true);
  storeTemplate(cache, xkey, made, { pages: [], sizes: null });
  assert.deepEqual(lookupTemplate(cache, xkey, { validate, sizesOf: () => null }).problems, ["it restores no page"]);
}));
