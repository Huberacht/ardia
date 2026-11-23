#!/usr/bin/env node
// The release perf gate's verdict over interleaved native-bench rounds, read pooled (docs/perf/README.md › Gating a
// release). Each round is one `native-bench --control` run; its out dir holds <label>/results.json for both sides.
//
//   node apps/browser/scripts/perf/gate-verdict.mjs --control <label> --candidate <label> <round dir> [<round dir> …]
//     --json <file>   also write the verdict as JSON
//
// A row fails when the pooled ranges separate (the candidate's best run is worse than the control's worst), or when the
// candidate is worse in every round (two rounds at least) and its pooled median is worse by more than the control's own
// round-to-round spread of medians. One round can only fail on separated ranges, so a stable gate runs two.
// Exit 0: every gate row passes; 1: a row fails; 2: a run was invalid (samples left out, a missing row); 64: usage.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { median, summary } from "./native-summary.mjs";

export const GATE_ROWS = [
  ["launch → window shown", "launch → window shown"],
  ["launch → with content", "launch → window shown with its content"],
  ["launch → JS running", "launch → JS running"],
  ["launch → first page painted", "launch → first page painted"],
  ["launch → first frame", "launch → first page's first frame"],
  ["new tab → first paint", "new tab → first paint (median of 5 per run)"],
  ["new tab → first frame", "new tab → its page's first frame (median of 5 per run)"],
  ["tab switch → shown", "tab switch → shown (median of 16 per run)"],
  ["new window → on screen", "new window → on screen (median per run)"],
  ["new window → first paint", "new window → first paint (median per run)"],
  ["new window → first frame", "new window → its page's first frame (median per run)"],
  ...[1, 20].flatMap((n) => [
    [`idle CPU ${n} tab, all`, `idle CPU, ${n} tab(s) (all processes)`],
    [`idle CPU ${n} tab, browser`, `idle CPU, ${n} tab(s) (browser process)`],
    [`idle wakeups ${n} tab, all`, `idle wakeups/s, ${n} tab(s) (all processes)`],
    [`idle wakeups ${n} tab, browser`, `idle wakeups/s, ${n} tab(s) (browser process)`],
  ]),
];

const VALIDITY_ROWS = ["samples left out: page couldn't paint (switch + new tab, per run)"];

const byName = (rows) => new Map(rows.map((r) => [r.name, r]));

export function rowVerdict(rounds) {
  const control = rounds.flatMap((r) => r.control.values);
  const candidate = rounds.flatMap((r) => r.candidate.values);
  const deltas = rounds.map((r) => median(r.candidate.values) - median(r.control.values));
  const controlMedians = rounds.map((r) => median(r.control.values));
  const spread = Math.max(...controlMedians) - Math.min(...controlMedians);
  const delta = median(candidate) - median(control);
  const separate = Math.min(...candidate) > Math.max(...control);
  const worseEveryRound = rounds.length >= 2 && deltas.every((d) => d > 0);
  const fail = separate || (worseEveryRound && delta > spread);
  const why = separate ? "ranges separate" : worseEveryRound ? (delta > spread ? `worse ×${rounds.length}, Δ > spread` : `worse ×${rounds.length} but Δ ≤ spread`) : "";
  const stat = (xs) => ({ min: Math.min(...xs), median: median(xs), max: Math.max(...xs), n: xs.length });
  return { control: stat(control), candidate: stat(candidate), delta, deltas, spread, separate, worseEveryRound, fail, why };
}

export function gateVerdict(rounds) {
  const problems = [];
  const rows = GATE_ROWS.map(([label, name]) => {
    const perRound = rounds.map((round, i) => {
      const c = byName(round.control).get(name), k = byName(round.candidate).get(name);
      if (!c?.values?.length || !k?.values?.length) problems.push(`round ${i + 1}: no samples for "${name}"`);
      return { control: c ?? { values: [] }, candidate: k ?? { values: [] } };
    });
    if (perRound.some((r) => !r.control.values.length || !r.candidate.values.length)) return { label, name, missing: true, fail: false };
    return { label, name, ...rowVerdict(perRound) };
  });
  rounds.forEach((round, i) => {
    for (const side of ["control", "candidate"])
      for (const name of VALIDITY_ROWS) {
        const left = (byName(round[side]).get(name)?.values ?? []).reduce((a, b) => a + b, 0);
        if (left > 0) problems.push(`round ${i + 1}, ${side}: ${left} samples left out because a page couldn't paint (screen locked or display asleep): rerun that round`);
      }
  });
  return { rounds: rounds.length, rows, problems, fails: rows.filter((r) => r.fail).map((r) => r.label) };
}

const fmt = (x) => (Math.abs(x) >= 10 ? x.toFixed(0) : x.toFixed(2));
const signed = (x) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${fmt(Math.abs(x))}`;

export function verdictTable(v, names) {
  const lines = [`| row | ${names[0]} pooled min / med / max (n) | ${names[1]} pooled min / med / max (n) | Δ med | per-round Δ med | ${names[0]} round spread | verdict |`, "|---|---|---|---|---|---|---|"];
  for (const r of v.rows) {
    if (r.missing) {
      lines.push(`| ${r.label} | — | — | — | — | — | missing |`);
      continue;
    }
    const s = (x) => `${fmt(x.min)} / ${fmt(x.median)} / ${fmt(x.max)} (${x.n})`;
    lines.push(`| ${r.label} | ${s(r.control)} | ${s(r.candidate)} | ${signed(r.delta)} | ${r.deltas.map(signed).join(" ")} | ${fmt(r.spread)} | ${r.fail ? "FAIL" : "pass"}${r.why ? ` (${r.why})` : ""} |`);
  }
  return lines.join("\n");
}

function main() {
  const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: { control: { type: "string" }, candidate: { type: "string" }, json: { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (opt.help || !opt.control || !opt.candidate || !positionals.length) {
    const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
    console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(opt.help ? 0 : 64);
  }
  const read = (dir, label) => summary(JSON.parse(readFileSync(join(dir, label, "results.json"), "utf8")));
  const v = gateVerdict(positionals.map((dir) => ({ control: read(dir, opt.control), candidate: read(dir, opt.candidate) })));
  console.log(verdictTable(v, [opt.control, opt.candidate]));
  for (const p of v.problems) console.log(`invalid: ${p}`);
  console.log(v.problems.length ? "gate: INVALID" : v.fails.length ? `gate: FAIL (${v.fails.join(", ")})` : `gate: pass (${v.rounds} round${v.rounds > 1 ? "s" : ""})`);
  if (opt.json) writeFileSync(opt.json, JSON.stringify(v, null, 1));
  process.exit(v.problems.length ? 2 : v.fails.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
