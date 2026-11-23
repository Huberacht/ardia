type TextField = { value: string; selectionStart: number | null; selectionEnd: number | null; getAttribute(name: string): string | null };
type ClipboardEventLike = { type: string; clipboardData: { setData(format: string, data: string): void } | null; preventDefault(): void };
type FieldDocument = {
  activeElement: unknown;
  addEventListener(type: "copy" | "cut", listener: (event: ClipboardEventLike) => void, capture: boolean): void;
  execCommand(command: string): boolean;
};

export const ADDRESS_FIELD_TEST_ID = "ardia-address-field";

let target: { shown: string; url: string } | null = null;
let installedOn: FieldDocument | null = null;

const isAddressField = (element: unknown): element is TextField => {
  const field = element as Partial<TextField> | null;
  return !!field && typeof field.value === "string" && typeof field.selectionStart === "number" && typeof field.getAttribute === "function" && field.getAttribute("data-testid") === ADDRESS_FIELD_TEST_ID;
};

export function fieldCopyUrl(element: unknown): string | null {
  if (!target || !isAddressField(element)) return null;
  const whole = element.selectionStart === 0 && element.selectionEnd === element.value.length;
  return whole && element.value === target.shown ? target.url : null;
}

export function swapFieldCopy(doc: FieldDocument, event: ClipboardEventLike, later: (run: () => void) => void = queueMicrotask) {
  const field = doc.activeElement;
  const url = fieldCopyUrl(field);
  if (!url || !event.clipboardData) return;
  event.clipboardData.setData("text/plain", url);
  event.preventDefault();
  if (event.type === "cut") later(() => void (doc.activeElement === field && doc.execCommand("delete")));
}

export function copyFieldAs(shown: unknown, url: unknown, doc: FieldDocument | null = typeof document === "undefined" ? null : (document as unknown as FieldDocument)) {
  target = typeof shown === "string" && shown && typeof url === "string" && url ? { shown, url } : null;
  if (!doc || installedOn === doc) return;
  installedOn = doc;
  doc.addEventListener("copy", (event) => swapFieldCopy(doc, event), true);
  doc.addEventListener("cut", (event) => swapFieldCopy(doc, event), true);
}
