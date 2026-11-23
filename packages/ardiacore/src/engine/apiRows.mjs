import { readFileSync } from "node:fs";

export const readApi = () => readFileSync(new URL("./api.ts", import.meta.url), "utf8");
export const readManifest = () => JSON.parse(readFileSync(new URL("./generated/manifest.json", import.meta.url), "utf8"));

const capitalized = (name) => name[0].toUpperCase() + name.slice(1);
const ROW = /^ {2}"([a-zA-Z]+\.[a-zA-Z]+)":/gm;

export function typeRows(api, manifest, name) {
  const heads = [...api.matchAll(new RegExp(`^export type ${name} =(.*)$`, "gm"))];
  if (heads.length !== 1) throw new Error(`api.ts declares ${name} ${heads.length} times`);
  const head = heads[0];
  const shape = head[1].match(/^ ((?:[A-Za-z]+ & )*)\{$/);
  if (!shape) throw new Error(`${name} is generated domains and one row literal, as \`export type ${name} = HistoryCalls & {\`: got ${JSON.stringify(head[0])}`);
  const start = head.index + head[0].length;
  const end = api.indexOf("\n}", start);
  if (end < 0 || !api.startsWith("\n};\n", end)) throw new Error(`${name}'s row literal ends its type: \`};\` with nothing after it`);
  const body = api.slice(start, end);
  const stray = body.split("\n").find((line) => line.trim() && !/^ {2}"[a-zA-Z]+\.[a-zA-Z]+": .+;$/.test(line));
  if (stray !== undefined) throw new Error(`${name}'s row literal holds only rows, one per line: ${JSON.stringify(stray)}`);
  const kind = name.endsWith("Calls") ? "calls" : "events";
  const generated = new Map(Object.entries(manifest.domains).map(([domain, entry]) => [`${capitalized(domain)}${capitalized(kind)}`, { domain, entry }]));
  const operands = shape[1].split(" & ").filter(Boolean);
  const rows = [];
  for (const operand of operands) {
    const found = generated.get(operand);
    if (!found) throw new Error(`${name} composes ${operand}, which isn't a generated domain's ${kind}`);
    const verbs = kind === "calls" ? Object.keys(found.entry.calls) : found.entry.events;
    rows.push(...verbs.map((verb) => `${found.domain}.${verb}`));
  }
  const hand = [...body.matchAll(ROW)].map((match) => match[1]);
  return { operands, hand, rows: new Set([...rows, ...hand]) };
}
