#!/usr/bin/env node
// Apps a bench launched with `open` (outside its process group), recorded so a supervisor can stop them.
//
//   node apps/browser/scripts/perf/bench-registry.mjs stop <dir> [--quit-secs <n>] [--kill-secs <n>]
//
// Benches call registerApp() as soon as they know a launched app's pid, into $GATE_APPS_DIR (set by gate.sh; nothing is
// recorded without it). `stop` quits every recorded app that is still running as the executable it was recorded with
// (SIGTERM to the app, then SIGKILL to it and every process under it after --quit-secs, default 15), and exits 0 once all
// of them are gone, 1 when some are still there after --kill-secs (default 5) more.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export function registerApp({ pid, exe, dataDir = null }, dir = process.env.GATE_APPS_DIR) {
  if (!dir || !(pid > 0) || !exe) return null;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${pid}.json`);
  writeFileSync(file, JSON.stringify({ pid, exe, dataDir, by: process.pid, at: new Date().toISOString() }));
  return file;
}

export function registered(dir) {
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    try {
      const entry = JSON.parse(readFileSync(join(dir, n), "utf8"));
      return entry.pid > 0 && entry.exe ? [entry] : [];
    } catch {
      return [];
    }
  });
}

export function processTable() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 << 20 });
  return out.split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(([, pid, ppid, command]) => ({ pid: +pid, ppid: +ppid, command }));
}

export function runningAs(entry, table) {
  const row = table.find((p) => p.pid === entry.pid);
  return !!row && (row.command === entry.exe || row.command.startsWith(`${entry.exe} `));
}

export function treeOf(pid, table) {
  const tree = [pid];
  for (let i = 0; i < tree.length; i++) for (const p of table) if (p.ppid === tree[i] && !tree.includes(p.pid)) tree.push(p.pid);
  return tree;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signal = (pid, sig) => {
  try {
    process.kill(pid, sig);
  } catch {}
};
const aliveNow = (pids) => {
  const live = new Set(processTable().map((p) => p.pid));
  return pids.filter((p) => live.has(p));
};

export async function stopApps(dir, { quitSecs = 15, killSecs = 5 } = {}) {
  const table = processTable();
  const targets = registered(dir).filter((e) => runningAs(e, table));
  const pids = [...new Set(targets.flatMap((e) => treeOf(e.pid, table)))];
  for (const e of targets) signal(e.pid, "SIGTERM");
  for (const end = Date.now() + quitSecs * 1000; aliveNow(pids).length && Date.now() < end; ) await sleep(200);
  for (const p of aliveNow(pids)) signal(p, "SIGKILL");
  for (const end = Date.now() + killSecs * 1000; aliveNow(pids).length && Date.now() < end; ) await sleep(100);
  return { stopped: targets.map((e) => e.pid), left: aliveNow(pids) };
}

async function main() {
  const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: { "quit-secs": { type: "string", default: "15" }, "kill-secs": { type: "string", default: "5" }, help: { type: "boolean", short: "h" } } });
  if (opt.help || positionals[0] !== "stop" || !positionals[1]) {
    const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
    console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(opt.help ? 0 : 64);
  }
  const { stopped, left } = await stopApps(positionals[1], { quitSecs: +opt["quit-secs"], killSecs: +opt["kill-secs"] });
  if (stopped.length) console.log(`bench-registry: stopped ${stopped.join(", ")}`);
  if (left.length) console.log(`bench-registry: still running after SIGKILL: ${left.join(", ")}`);
  process.exit(left.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
