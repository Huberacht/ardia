import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { launch, quit, quitOnSignals, stopInstances } from "./js-bench.mjs";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const slowToQuit = async () => {
  const child = spawn(process.execPath, ["-e", `process.on("SIGTERM", () => setTimeout(() => process.exit(0), 800)); setInterval(() => {}, 1000);`], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  return child.pid;
};

test("stopping waits for an instance that was already quitting instead of finding nothing to do", { timeout: 20_000 }, async () => {
  const pid = await slowToQuit();
  const quitting = quit(pid);
  await stopInstances({ binaries: new Set() });
  assert.ok(!alive(pid), "stopInstances returned while the instance was still quitting");
  await quitting;
});

test("a signal keeps its handler through cleanup, so a second one can't cut it short, and exits only after the instances are gone", { timeout: 20_000 }, async () => {
  const pid = await slowToQuit();
  quit(pid);
  const exits = [];
  let resolveExit;
  const exited = new Promise((r) => (resolveExit = r));
  const dispose = quitOnSignals([], { exit: (code) => {
    exits.push({ code, alive: alive(pid) });
    resolveExit();
  } });
  const before = process.listenerCount("SIGTERM");
  process.emit("SIGTERM");
  assert.equal(process.listenerCount("SIGTERM"), before);
  process.emit("SIGTERM");
  await exited;
  await new Promise((r) => setTimeout(r, 50));
  dispose();
  assert.ok(exits.length >= 1);
  assert.ok(exits.every((e) => e.code === 143 && !e.alive), JSON.stringify(exits));
});

test("once stopping has begun, nothing new is launched", async () => {
  await assert.rejects(launch("/nonexistent/Ardia.app", "/tmp/none", 9999), /stopping/);
});
