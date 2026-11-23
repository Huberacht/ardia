import type { InspectionSession } from "./devToolsSession";
import { OpError } from "./workspaceTargets";

export const MAX_PROPERTIES = 64;
const MAX_RULES = 2000;
const MAX_INHERITED = 32;

type Fields = Record<string, unknown>;

export type SheetHeader = { url: string | null; origin: string | null; startLine: number; startColumn: number; isInline: boolean };
export type Specificity = [number, number, number];
export type Declaration = {
  value: string;
  important: boolean;
  origin: string;
  selector: string;
  specificity: Specificity | null;
  source: { styleSheetId: string | null; url: string | null; line: number | null; column: number | null; inline: boolean };
  inheritedFrom: number;
};
export type OverriddenDeclaration = Declaration & { reason: string };
export type PropertyCascade = { property: string; computed: string | null; winner: Declaration | null; overridden: OverriddenDeclaration[] };

type Candidate = Declaration & { order: number; active: boolean; invalid: boolean; disabled: boolean };

const INHERITED = new Set([
  "color", "cursor", "direction", "visibility", "quotes", "white-space", "word-spacing", "letter-spacing", "line-height", "text-align", "text-indent", "text-transform", "text-shadow", "tab-size", "writing-mode",
  "hyphens", "overflow-wrap", "word-break", "list-style", "list-style-type", "list-style-position", "list-style-image", "caption-side", "border-collapse", "border-spacing", "empty-cells", "orphans", "widows",
  "font", "font-family", "font-size", "font-style", "font-weight", "font-variant", "font-stretch", "font-feature-settings", "font-kerning", "font-size-adjust", "font-synthesis", "font-optical-sizing", "font-variation-settings",
  "text-rendering", "-webkit-font-smoothing", "color-scheme", "accent-color", "caret-color", "pointer-events", "user-select", "image-rendering", "text-underline-position", "text-decoration-skip-ink", "paint-order",
]);

const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: unknown, key: string): unknown => (isFields(value) && Object.hasOwn(value, key) ? value[key] : undefined);
const text = (value: unknown, max = 4096): string | null => (typeof value === "string" ? value.slice(0, max) : null);
const whole = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const isInherited = (property: string) => property.startsWith("--") || INHERITED.has(property);

export function estimateSpecificity(selector: string): Specificity {
  const stripped = selector.replace(/\\./g, "_").replace(/"[^"]*"|'[^']*'/g, "").replace(/:(?:where)\((?:[^()]|\([^()]*\))*\)/g, "");
  const ids = (stripped.match(/#[\w-]+/g) ?? []).length;
  const elements = (stripped.match(/::[\w-]+/g) ?? []).length;
  const classes = (stripped.replace(/::[\w-]+(\([^)]*\))?/g, " ").match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length;
  const types = (stripped.replace(/::?[\w-]+(\([^)]*\))?|#[\w-]+|\.[\w-]+|\[[^\]]*\]/g, " ").match(/(?:^|[\s>+~(,])([a-zA-Z][\w-]*)/g) ?? []).length + elements;
  return [ids, classes, types];
}

const compareSpecificity = (a: Specificity, b: Specificity) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function specificityOf(rule: unknown, matching: unknown): { selector: string; specificity: Specificity } {
  const selectors = list(field(field(rule, "selectorList"), "selectors"));
  const picked = list(matching).map((i) => (whole(i) !== null ? selectors[i as number] : undefined)).filter(isFields);
  const pool = picked.length ? picked : selectors.filter(isFields);
  let best: { selector: string; specificity: Specificity } | null = null;
  for (const selector of pool) {
    const selectorText = text(selector.text, 1024) ?? "";
    const given = field(selector, "specificity");
    const a = whole(field(given, "a")), b = whole(field(given, "b")), c = whole(field(given, "c"));
    const specificity: Specificity = a !== null && b !== null && c !== null ? [a, b, c] : estimateSpecificity(selectorText);
    if (!best || compareSpecificity(specificity, best.specificity) > 0) best = { selector: selectorText, specificity };
  }
  return best ?? { selector: text(field(field(rule, "selectorList"), "text"), 1024) ?? "", specificity: [0, 0, 0] };
}

function sourceOf(style: unknown, prop: unknown, headers: ReadonlyMap<string, SheetHeader>, inline: boolean): Declaration["source"] {
  const styleSheetId = text(field(style, "styleSheetId"), 256);
  const header = styleSheetId ? headers.get(styleSheetId) : undefined;
  const range = field(prop, "range") ?? field(style, "range");
  const line = whole(field(range, "startLine"));
  const column = whole(field(range, "startColumn"));
  return {
    styleSheetId,
    url: header?.url ?? null,
    line: line === null ? null : line + 1 + (header?.startLine ?? 0),
    column: column === null ? null : column + 1,
    inline: inline || header?.isInline === true,
  };
}

function candidatesOf(styles: { style: unknown; origin: string; selector: string; specificity: Specificity | null; inline: boolean }[], property: string, headers: ReadonlyMap<string, SheetHeader>, inheritedFrom: number, start: number): Candidate[] {
  const out: Candidate[] = [];
  let order = start;
  for (const entry of styles) {
    for (const prop of list(field(entry.style, "cssProperties"))) {
      order++;
      if (text(field(prop, "name"), 256)?.toLowerCase() !== property) continue;
      const disabled = field(prop, "disabled") === true;
      const invalid = field(prop, "parsedOk") === false;
      const value = text(field(prop, "value"), 2048) ?? "";
      out.push({
        value,
        important: field(prop, "important") === true,
        origin: entry.origin,
        selector: entry.selector,
        specificity: entry.specificity,
        source: sourceOf(entry.style, prop, headers, entry.inline),
        inheritedFrom,
        order,
        active: !disabled && !invalid,
        invalid,
        disabled,
      });
    }
  }
  return out;
}

const IMPORTANT_RANK: Readonly<Record<string, number>> = { "user-agent": 3, injected: 2, regular: 1, inspector: 1 };
const importantRank = (origin: string) => IMPORTANT_RANK[origin] ?? 1;

function pickWinner(candidates: Candidate[]): Candidate | null {
  const active = candidates.filter((c) => c.active);
  const important = active.filter((c) => c.important);
  const pool = important.length ? important : active;
  let winner: Candidate | null = null;
  for (const c of pool) {
    if (!winner) winner = c;
    else if (important.length ? importantRank(c.origin) > importantRank(winner.origin) || (importantRank(c.origin) === importantRank(winner.origin) && c.order > winner.order) : c.order > winner.order) winner = c;
  }
  return winner;
}

function reasonAgainst(loser: Candidate, winner: Candidate): string {
  if (loser.disabled) return "disabled";
  if (loser.invalid) return "invalid value";
  if (winner.important && !loser.important) return "the winner is !important";
  if (loser.inheritedFrom > 0 && winner.inheritedFrom === 0) return "declared on the element itself";
  if (loser.inheritedFrom > winner.inheritedFrom) return "inherited from a closer ancestor";
  if (winner.source.inline && winner.selector === "element.style" && loser.selector !== "element.style") return "inline style wins";
  if (loser.important && winner.important && importantRank(winner.origin) > importantRank(loser.origin)) return "a higher-priority origin's !important";
  if (loser.origin !== winner.origin && loser.origin === "user-agent") return "browser default overridden by the page";
  if (loser.specificity && winner.specificity && compareSpecificity(loser.specificity, winner.specificity) < 0) return "lower specificity";
  return "earlier in the cascade";
}

const strip = (c: Candidate): Declaration => ({ value: c.value, important: c.important, origin: c.origin, selector: c.selector, specificity: c.specificity, source: c.source, inheritedFrom: c.inheritedFrom });

function stylesOfLevel(level: unknown, withAttributes: boolean): { style: unknown; origin: string; selector: string; specificity: Specificity | null; inline: boolean }[] {
  const styles: { style: unknown; origin: string; selector: string; specificity: Specificity | null; inline: boolean }[] = [];
  const attributes = field(level, "attributesStyle");
  if (withAttributes && isFields(attributes)) styles.push({ style: attributes, origin: "regular", selector: "presentational attributes", specificity: [0, 0, 0], inline: false });
  for (const match of list(field(level, "matchedCSSRules")).slice(0, MAX_RULES)) {
    const rule = field(match, "rule");
    if (!isFields(rule)) continue;
    const { selector, specificity } = specificityOf(rule, field(match, "matchingSelectors"));
    styles.push({ style: rule.style, origin: text(rule.origin, 32) ?? "regular", selector, specificity, inline: false });
  }
  const inline = field(level, "inlineStyle");
  if (isFields(inline)) styles.push({ style: inline, origin: "regular", selector: "element.style", specificity: null, inline: true });
  return styles;
}

export function declaredProperties(matched: unknown): string[] {
  const names = new Set<string>();
  for (const entry of stylesOfLevel(matched, true)) {
    if (entry.origin === "user-agent") continue;
    for (const prop of list(field(entry.style, "cssProperties"))) {
      const name = text(field(prop, "name"), 256)?.toLowerCase();
      if (name && field(prop, "implicit") !== true && field(prop, "disabled") !== true) names.add(name);
      if (names.size >= MAX_PROPERTIES) return [...names];
    }
  }
  return [...names];
}

export function cascadeFor(matched: unknown, computed: unknown, properties: readonly string[], headers: ReadonlyMap<string, SheetHeader>): PropertyCascade[] {
  const computedValues = new Map<string, string>();
  for (const entry of list(field(computed, "computedStyle") ?? computed)) {
    const name = text(field(entry, "name"), 256);
    const value = text(field(entry, "value"), 2048);
    if (name && value !== null) computedValues.set(name, value);
  }
  const own = stylesOfLevel(matched, true);
  const inherited = list(field(matched, "inherited")).slice(0, MAX_INHERITED);
  return properties.slice(0, MAX_PROPERTIES).map((raw) => {
    const property = raw.toLowerCase();
    let candidates = candidatesOf(own, property, headers, 0, 0);
    let winner = pickWinner(candidates);
    if (!winner && isInherited(property)) {
      for (const [i, level] of inherited.entries()) {
        const found = candidatesOf(stylesOfLevel(level, false), property, headers, i + 1, (i + 1) * 1_000_000);
        candidates = [...candidates, ...found];
        winner = pickWinner(found);
        if (winner) break;
      }
    }
    const overridden = winner ? candidates.filter((c) => c !== winner).map((c) => ({ ...strip(c), reason: reasonAgainst(c, winner!) })) : candidates.map((c) => ({ ...strip(c), reason: c.disabled ? "disabled" : c.invalid ? "invalid value" : "not applied" }));
    return { property, computed: computedValues.get(property) ?? null, winner: winner ? strip(winner) : null, overridden: overridden.reverse() };
  });
}

export function headerOf(params: unknown): [string, SheetHeader] | null {
  const header = field(params, "header");
  const id = text(field(header, "styleSheetId"), 256);
  if (!id) return null;
  return [id, { url: text(field(header, "sourceURL"), 2048) || null, origin: text(field(header, "origin"), 32), startLine: whole(field(header, "startLine")) ?? 0, startColumn: whole(field(header, "startColumn")) ?? 0, isInline: field(header, "isInline") === true }];
}

export const SELECTOR_LIMIT = 1024;

export async function stylesFor(session: InspectionSession, selector: string, properties: readonly string[] | null) {
  const headers = new Map<string, SheetHeader>();
  const stop = session.on((method, params) => {
    if (method !== "CSS.styleSheetAdded" || headers.size >= 5000) return;
    const header = headerOf(params);
    if (header) headers.set(header[0], header[1]);
  });
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const doc = await session.send("DOM.getDocument", { depth: 0 });
    const rootId = whole(field(field(doc, "root"), "nodeId"));
    if (rootId === null) throw new OpError("failed", "The page has no document to inspect.");
    let nodeId: number | null;
    try {
      nodeId = whole((await session.send("DOM.querySelector", { nodeId: rootId, selector })).nodeId);
    } catch {
      throw new OpError("bad_request", `${selector.slice(0, 120)} isn't a valid CSS selector.`);
    }
    if (!nodeId) throw new OpError("failed", `Nothing on the page matches ${selector.slice(0, 120)}.`);
    const matched = await session.send("CSS.getMatchedStylesForNode", { nodeId });
    const computed = await session.send("CSS.getComputedStyleForNode", { nodeId });
    const wanted = properties?.length ? properties : declaredProperties(matched);
    return { selector, properties: cascadeFor(matched, computed, wanted, headers) };
  } finally {
    stop();
  }
}
