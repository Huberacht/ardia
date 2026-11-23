import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

globalThis.__DEV__ = false;

const CANARY = {
  password: "Canary-Pw-7f3k!x-passw0rd",
  oauthToken: ["ghp", "CanaryOAuthToken0123456789abcdefXYZ"].join("_"),
  apiToken: "CanaryApiToken-9q8w7e6r5t4y3u2i",
  oauthClientSecret: "GOCSPX-CanaryClientSecret42zz",
  pluginSecret: "canary-plugin-secret-55-kv",
  syncPhrase: "canaryword alpha bravo charlie delta echo",
};

const keychain = new Map([
  ["ardia.plugin.notes.apiKey", CANARY.pluginSecret],
  ["github", CANARY.oauthToken],
  ["notion", CANARY.apiToken],
  ["gdrive", JSON.stringify({ access_token: CANARY.oauthToken, refresh_token: `${CANARY.oauthToken}-refresh`, expires_at: Date.now() + 3_600_000, client_secret: CANARY.oauthClientSecret })],
]);
const keychainWrites = [];
globalThis.acTestNativeModules = {
  ArdiaKeychain: {
    get: async (account) => keychain.get(account) ?? null,
    read: async (account) => (keychain.has(account) ? { status: "ok", value: keychain.get(account) } : { status: "missing" }),
    set: async (account, value) => (keychainWrites.push({ account, value }), keychain.set(account, value), !account.startsWith("ardia.plugin.refuse.")),
    delete: async (account) => keychain.delete(account),
  },
  ArdiaSync: {
    recoveryWords: async () => CANARY.syncPhrase.split(" "),
    enterPhrase: async (_account, text) => (enteredPhrases.push(text), { error: "mismatch" }),
    newDeviceId: () => "device-1",
  },
};
const enteredPhrases = [];

const posted = [];
globalThis.fetch = async (url, init = {}) => {
  posted.push({ url: String(url), headers: JSON.stringify(init.headers ?? {}), body: String(init.body ?? "") });
  return { status: 503, ok: false, headers: new Headers(), text: async () => "", json: async () => ({}) };
};

const stub = await import("./test-native/index.ts");
Object.assign(stub.appInfo, { appVersion: "0.3.0", appBuild: "300", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false });
stub.passwordStores.set(stub.current.device, new Map());
stub.docs.set("telemetry.json", JSON.stringify({ version: 1, sharing: true, decidedAt: 1, askDoneAt: 1, installId: "install-1", crashCursor: 0, lastVersion: "0.3.0", sessionOpen: false }));

const core = await import("../../../packages/core/src/secret.ts");
const { asSecret, reveal, isSecret, SECRET_KINDS, SecretEscapeError, setSecretEscapeMode } = core;
const client = await import("./state/telemetry/client.ts");
const local = await import("./state/telemetry/localStore.ts");
const { recordLog } = await import("./state/telemetry/logs.ts");
const { captureException, installErrorReporting } = await import("./state/telemetry/errors.ts");
const { watchSecretDrops, takeSecretValuesDropped } = await import("./state/telemetry/secretDrops.ts");
const { fittedEvent, fittedReply } = await import("./state/automation/socketWire.ts");
const { getPluginSecret, setPluginSecret } = await import("./state/plugins/secrets.ts");
const { secretsMethod } = await import("./state/plugins/channelData.ts");
const { getSecret, googleTokensOf, bearer, basic } = await import("./state/live/net.ts");
const { getPassword, savePassword } = await import("./platform/passwords.ts");
const { recoveryWords } = await import("./state/sync/recoveryKit.ts");
const { Clock } = await import("../../../packages/sync/src/hlc.ts");
const { syncScope } = await import("../../../packages/sync/src/scope.ts");
const { emptyScope } = await import("../../../packages/sync/src/scopeState.ts");

client.startClient();
watchSecretDrops();
installErrorReporting();
after(() => {
  client.setSharing(false, "settings");
  local.flushLocal();
});

const PROFILE = "Default";
const ORIGIN = "https://login.example";

const SOURCES = {
  password: async () => {
    await savePassword(PROFILE, ORIGIN, "someone", asSecret("password", CANARY.password));
    return getPassword(PROFILE, ORIGIN, "someone");
  },
  oauthToken: async () => getSecret("github"),
  apiToken: async () => getSecret("notion"),
  oauthClientSecret: async () => googleTokensOf(await getSecret("gdrive")).client_secret,
  pluginSecret: async () => {
    const read = await getPluginSecret("notes", "apiKey");
    assert.ok(read.ok);
    return read.value;
  },
  syncPhrase: async () => recoveryWords(),
};

const SHAPED = new Set(["oauthToken"]);

function telemetryText() {
  client.saveQueueNow();
  local.flushLocal();
  return [stub.docs.get("telemetry-queue.json") ?? "", JSON.stringify(stub.telemetryLocal.records()), ...posted.filter((p) => p.url.includes("otel")).map((p) => p.body)].join("\n");
}

const leaked = (text, kind) => [CANARY[kind], CANARY[kind].slice(6, 22)].filter((needle) => text.includes(needle));

function dropping(run) {
  const previous = setSecretEscapeMode("drop");
  try {
    return run();
  } finally {
    setSecretEscapeMode(previous);
  }
}

async function droppingAsync(run) {
  const previous = setSecretEscapeMode("drop");
  try {
    return await run();
  } finally {
    setSecretEscapeMode(previous);
  }
}

function memoryTransport() {
  const files = [];
  return {
    files,
    transport: {
      write: async (_scope, payload) => (files.push(payload), `f${files.length}`),
      read: async (_scope, known) => ({ files: files.map((payload, i) => ({ id: `f${i + 1}`, payload })).filter((f) => !known.includes(f.id)), pending: [], damaged: [], present: files.map((_, i) => `f${i + 1}`) }),
      remove: async () => {},
    },
  };
}

async function syncWith(value) {
  const { files, transport } = memoryTransport();
  const t = 1_000_000;
  const adapter = { prefix: "x:", extract: () => ({ values: new Map([["x:held", value]]) }), apply: () => {} };
  await syncScope({ scope: "s", state: emptyScope(), transport, adapters: [adapter], clock: new Clock("A", null, () => t), device: "A", now: () => t });
  return files.join("\n");
}

for (const kind of SECRET_KINDS) {
  test(`a ${kind} canary from its real source never reaches telemetry, logs, crash reports, sync files or the control socket`, async () => {
    const secret = await SOURCES[kind]();
    assert.ok(isSecret(secret), "the source hands out a branded secret");
    assert.equal(secret.kind, kind);
    assert.equal(reveal(secret), CANARY[kind], "positive control: the sink that needs it still gets the plaintext");

    assert.throws(() => JSON.stringify({ secret }), SecretEscapeError, "JSON refuses it in tests");
    assert.throws(() => `${secret}`, SecretEscapeError, "text refuses it in tests");
    assert.throws(() => fittedReply(1, { result: { secret } }, undefined, null), SecretEscapeError);
    assert.throws(() => fittedEvent("tab.idle", 0, { nested: [secret] }, null), SecretEscapeError);
    await assert.rejects(syncWith({ v: secret }), SecretEscapeError);

    takeSecretValuesDropped();
    const sinkText = await droppingAsync(async () => {
      client.capture("secret_containment", { value: secret, label: `with ${secret}` }, client.consentNow(), { raw: { raw_value: secret, nested: { deep: secret } } });
      recordLog("error", [`[containment] failed with ${secret}`, secret, new Error(`refresh failed for ${secret}`)], client.consentToken());
      console.error(`[containment] console with ${secret}`, new Error(`console reason ${secret}`));
      captureException(new Error(`crash while holding ${secret}`), "onerror");
      captureException(Object.assign(new Error("thrown with a secret field"), { token: secret }), "onerror");
      const reply = fittedReply(2, { result: { secret, list: [secret] } }, undefined, null);
      const event = fittedEvent("tab.idle", 0, { secret }, null);
      const synced = await syncWith({ s: secret, list: [secret] });
      return [telemetryText(), reply, event, synced].join("\n");
    });
    assert.deepEqual(leaked(sinkText, kind), []);
    assert.ok(takeSecretValuesDropped() > 0, "dropped values are counted");

    if (SHAPED.has(kind)) {
      const plain = reveal(secret);
      recordLog("error", ["[containment] shaped", new Error(`Bad credentials: ${plain}`)], client.consentToken());
      captureException(new Error(`request with ${plain} failed`), "onerror");
      client.capture("secret_containment_shaped", { reason: `token ${plain}` }, client.consentNow());
      assert.deepEqual(leaked(telemetryText(), kind), [], "the scrubber catches the token's shape even once revealed");
    }
  });
}

test("dropped secrets are counted for usage_counts in production mode, and only while sharing", () => {
  takeSecretValuesDropped();
  const secret = asSecret("apiToken", CANARY.apiToken);
  dropping(() => {
    JSON.stringify({ secret });
    String(secret);
  });
  assert.equal(takeSecretValuesDropped(), 2);
  assert.equal(takeSecretValuesDropped(), 0);
  assert.equal(dropping(() => JSON.stringify({ a: 1, secret })), '{"a":1}');
  assert.equal(dropping(() => JSON.stringify([secret])), "[null]");
});

test("the legitimate sinks get the plaintext and nothing else does", async () => {
  const token = await getSecret("github");
  assert.equal(bearer(token), `Bearer ${CANARY.oauthToken}`);
  assert.ok(basic("me", token).startsWith("Basic "));
  const answered = await secretsMethod({ name: "notes", run: 1 }, { permissions: { secrets: true } }, "secrets.get", { key: "apiKey" });
  assert.deepEqual(answered, { result: CANARY.pluginSecret }, "the owning plugin reads its own secret");
  const refused = await secretsMethod({ name: "notes", run: 1 }, { permissions: { secrets: true } }, "secrets.set", { key: "bad key!", value: CANARY.pluginSecret });
  assert.deepEqual(leaked(JSON.stringify(refused), "pluginSecret"), []);
  const failed = await setPluginSecret("refuse", "apiKey", CANARY.pluginSecret);
  assert.equal(failed.ok, false);
  assert.deepEqual(leaked(JSON.stringify(failed), "pluginSecret"), []);
  assert.ok(keychainWrites.some((w) => w.account === "ardia.plugin.refuse.apiKey" && w.value === CANARY.pluginSecret), "the Keychain is the sink that stores it");
  const { enterRecoveryPhrase } = await import("./state/sync/engine.ts");
  await enterRecoveryPhrase("/sync", asSecret("syncPhrase", CANARY.syncPhrase)).catch(() => null);
  assert.deepEqual(enteredPhrases, [CANARY.syncPhrase], "the native sync module gets the phrase");
});

test("an unreadable Google sign-in fails without echoing the stored value", () => {
  for (const stored of [`{"access_token": ${CANARY.oauthClientSecret}`, JSON.stringify({ access_token: CANARY.oauthClientSecret })]) {
    assert.throws(
      () => googleTokensOf(asSecret("oauthToken", stored)),
      (error) => !String(error.message).includes(CANARY.oauthClientSecret) && error.kind === "signedOut",
    );
  }
});

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCANNED = ["apps/browser/src", "apps/linux/src", "packages/core/src", "packages/sync/src", "packages/ardiacore/src", "packages/shell/src", "packages/import/src", "packages/phone/src"];
const SKIP = /\.test\.|\/secretSinkTypes\.ts$|\/test-native\/|\/node_modules\//;

const WRAP_SITES = {
  "apps/browser/src/platform/keychain.ts": ["*"],
  "apps/browser/src/platform/passwords.ts": ["password"],
  "apps/browser/src/state/site/savedPasswords.ts": ["password"],
  "apps/browser/src/state/import/apply.ts": ["password"],
  "apps/browser/src/components/settings/panes/ProfilePasswords.tsx": ["password"],
  "apps/browser/src/state/live/net.ts": ["oauthToken", "oauthClientSecret"],
  "apps/browser/src/state/live/sources.ts": ["oauthToken", "apiToken", "oauthClientSecret"],
  "apps/browser/src/state/plugins/secrets.ts": ["pluginSecret"],
  "apps/browser/src/state/sync/recoveryKit.ts": ["syncPhrase"],
  "apps/browser/src/components/settings/panes/SyncSheets.tsx": ["syncPhrase"],
  "apps/linux/src/syncEngine.ts": ["syncPhrase"],
  "apps/linux/src/syncAuthority.ts": ["*"],
};

const REVEAL_SINKS = {
  "apps/browser/src/platform/keychain.ts": "the Keychain stores the plaintext",
  "apps/browser/src/platform/passwords.ts": "Chrome's password store saves and updates the plaintext",
  "apps/browser/src/state/live/net.ts": "Authorization headers and token request bodies to the account's own provider, and the Keychain copy of Google's tokens",
  "apps/browser/src/state/plugins/channelData.ts": "secrets.get answers the plugin that owns the secret",
  "apps/browser/src/state/sync/engine.ts": "the native sync module unlocks with the recovery phrase",
  "apps/browser/src/components/settings/panes/ProfilePasswords.tsx": "the password sheet shows and edits the password the user unlocked",
  "apps/browser/src/components/settings/panes/SyncSheets.tsx": "Show Words displays the recovery phrase to the user",
  "apps/linux/src/syncAuthority.ts": "a Linux window hands a sync call's secret to the window that runs sync, over the app's own channel, and it is branded again on arrival",
};

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|tsx)$/.test(entry.name) && !SKIP.test(`/${path}`)) out.push(path);
    }
  };
  for (const dir of SCANNED) walk(dir);
  return out;
}

const importsFromCore = (source, name) => new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"(?:@ardia/core|[./]+secret(?:\\.ts)?)"`).test(source);

test("every secret kind has a containment case, and every place that makes or reveals a secret is registered", () => {
  assert.deepEqual(Object.keys(SOURCES).sort(), [...SECRET_KINDS].sort(), "a new secret kind needs a source in SOURCES and a canary in CANARY");
  assert.deepEqual(Object.keys(CANARY).sort(), [...SECRET_KINDS].sort());
  const wraps = {};
  const reveals = new Set();
  for (const file of sourceFiles()) {
    if (file === "packages/core/src/secret.ts") continue;
    const source = readFileSync(join(ROOT, file), "utf8");
    if (importsFromCore(source, "asSecret")) {
      const kinds = [...source.matchAll(/\basSecret\(\s*"([A-Za-z]+)"/g)].map((m) => m[1]);
      wraps[file] = /\basSecret\(\s*(?:kind|[\w.]+\.relayedSecret)\b/.test(source) ? ["*"] : [...new Set(kinds)].sort();
    }
    if (importsFromCore(source, "reveal") && /\breveal\(/.test(source)) reveals.add(file);
  }
  const registered = Object.fromEntries(Object.entries(WRAP_SITES).map(([file, kinds]) => [file, [...kinds].sort()]));
  assert.deepEqual(wraps, registered, "a file that makes secrets is listed in WRAP_SITES with the kinds it makes");
  for (const kinds of Object.values(wraps)) for (const kind of kinds) assert.ok(kind === "*" || SECRET_KINDS.includes(kind), kind);
  assert.deepEqual([...reveals].sort(), Object.keys(REVEAL_SINKS).sort(), "reveal() runs only at a registered sink; add the file and why it needs the plaintext");
});
