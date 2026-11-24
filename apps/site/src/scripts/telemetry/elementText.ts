import { AUTOCAPTURE_PRIVATE_SELECTOR, NO_CAPTURE_SELECTOR } from "../../data/telemetry.ts";

export const HIDDEN_TEXT_SELECTOR = `${AUTOCAPTURE_PRIVATE_SELECTOR}, ${NO_CAPTURE_SELECTOR}`;
export const TEXT_MAX = 255;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const FIELD = /^(input|textarea|select|option)$/;
const WALK_BUDGET = TEXT_MAX * 4;

export interface TextNodeLike {
  readonly nodeType: number;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<TextNodeLike>;
}
export interface TextElementLike extends TextNodeLike {
  readonly tagName: string;
  readonly isContentEditable?: boolean;
  matches(selector: string): boolean;
  closest(selector: string): unknown;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
export const sensitive = (s: string) => /\b(?:\d[ -]?){13,16}\b/.test(s) || /\b\d{3}-\d{2}-\d{4}\b/.test(s);
export const isField = (el: TextElementLike) => FIELD.test(el.tagName.toLowerCase()) || el.isContentEditable === true;
export const textIsHidden = (el: TextElementLike) => !!el.closest(HIDDEN_TEXT_SELECTOR);

const finish = (text: string) => {
  const cut = clean(text).slice(0, TEXT_MAX);
  return sensitive(cut) ? "" : cut;
};

export function ownText(el: TextElementLike): string {
  if (isField(el) || textIsHidden(el)) return "";
  let text = "";
  for (const node of Array.from(el.childNodes)) if (node.nodeType === TEXT_NODE) text += ` ${node.textContent ?? ""}`;
  return finish(text);
}

export function elementText(el: TextElementLike): string {
  if (isField(el) || textIsHidden(el)) return "";
  const own = ownText(el);
  if (own) return own;
  let text = "";
  const walk = (node: TextNodeLike) => {
    for (const child of Array.from(node.childNodes)) {
      if (text.length > WALK_BUDGET) return;
      if (child.nodeType === TEXT_NODE) text += ` ${child.textContent ?? ""}`;
      else if (child.nodeType === ELEMENT_NODE) {
        const element = child as TextElementLike;
        if (!isField(element) && !element.matches(HIDDEN_TEXT_SELECTOR)) walk(element);
      }
    }
  };
  walk(el);
  return finish(text);
}
