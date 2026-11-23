import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { passwordsAdapter } = await import("./adapters.ts");
const { Clock, emptyScope, syncScope } = await import("@ardia/sync");

useBrowser.getState().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });

const BLANK = "pws:https://a.example\nada";
const KEPT = "pws:https://b.example\nbo";

function adapterWith(saved) {
  const read = async () => [
    { origin: "https://a.example", username: "ada", passwordless: true, created: 1 },
    { origin: "https://b.example", username: "bo", sealed: "sealed-bo", created: 2 },
  ];
  return passwordsAdapter("default", { read, save: async (...args) => (saved.push(args), true) })(true);
}

test("a login the engine lists as passwordless is neither uploaded nor read as a deletion", async () => {
  const extracted = await adapterWith([]).extract();
  assert.deepEqual([...extracted.values.keys()], [KEPT], "only the login with a password is offered to sync");
  assert.equal(extracted.ignore(BLANK), true, "the passwordless login's synced copy is left as it is, not deleted");
  assert.equal(extracted.ignore(KEPT), false);
});

test("a synced password is never written over a login this machine lists as passwordless", async () => {
  const saved = [];
  const adapter = adapterWith(saved);
  await adapter.extract();
  const visible = new Map([[BLANK, { o: "https://a.example", u: "ada", s: "sealed-remote" }]]);
  const ok = await adapter.apply(visible, new Set([BLANK]), () => undefined, { held: () => false, landed: () => {} });
  assert.equal(ok, true);
  assert.deepEqual(saved, []);
});

test("a login the Mac couldn't seal, listed as passwordless, publishes no deletion; a login really gone still does", async () => {
  const files = new Map();
  let counter = 0;
  const transport = {
    write: async (_scope, payload) => (files.set(`f${++counter}`, payload), `f${counter}`),
    read: async (_scope, known) => ({ files: [...files].filter(([id]) => !known.includes(id)).map(([id, payload]) => ({ id, payload })), pending: [], damaged: [], present: [...files.keys()] }),
    remove: async (_scope, ids) => ids.forEach((id) => files.delete(id)),
  };
  const ada = { origin: "https://a.example", username: "ada", sealed: "sealed-ada", created: 1 };
  const bo = { origin: "https://b.example", username: "bo", sealed: "sealed-bo", created: 2 };
  let listed = [ada, bo];
  const adapter = passwordsAdapter("default", { read: async () => listed, save: async () => true });
  const state = emptyScope();
  const clock = new Clock("mac");
  let now = 1_000_000;
  const cycle = () => syncScope({ scope: "p", state, transport, adapters: [adapter(true)], clock, device: "mac", now: () => (now += 60_000) });
  const deletions = () => [...files.values()].flatMap((payload) => JSON.parse(payload).ops ?? []).filter((op) => op.v === null).map((op) => op.k);
  await cycle();
  assert.deepEqual(deletions(), []);
  listed = [{ origin: ada.origin, username: ada.username, passwordless: true, created: ada.created }, bo];
  await cycle();
  assert.deepEqual(deletions(), [], "a login whose password couldn't be sealed this time is left as it is everywhere");
  listed = [bo];
  await cycle();
  assert.deepEqual(deletions(), [BLANK], "a login deleted on this Mac is still deleted everywhere, as before");
});
