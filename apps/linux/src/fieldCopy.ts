type TextField = { value: string; selectionStart: number | null; selectionEnd: number | null };
type ClipboardEventLike = { type: string; clipboardData: { setData(format: string, data: string): void } | null; preventDefault(): void };
type FieldDocument = {
  activeElement: unknown;
  addEventListener(type: "copy" | "cut", listener: (event: ClipboardEventLike) => void, capture: boolean): void;
  execCommand(command: string): boolean;
};

let target: { shown: string; url: string } | null = null;
let installedOn: FieldDocument | null = null;

const isTextField = (element: unknown): element is TextField =>
  !!element && typeof (element as TextField).value === "string" && typeof (element as TextField).selectionStart === "number";

export function fieldCopyUrl(element: unknown): string | null {
  if (!target || !isTextField(element)) return null;
  const whole = element.selectionStart === 0 && element.selectionEnd === element.value.length;
  return whole && element.value === target.shown ? target.url : null;
}

export function swapFieldCopy(doc: FieldDocument, event: ClipboardEventLike) {
  const url = fieldCopyUrl(doc.activeElement);
  if (!url || !event.clipboardData) return;
  event.clipboardData.setData("text/plain", url);
  event.preventDefault();
  if (event.type === "cut") doc.execCommand("delete");
}

export function copyFieldAs(shown: unknown, url: unknown, doc: FieldDocument | null = typeof document === "undefined" ? null : (document as unknown as FieldDocument)) {
  target = typeof shown === "string" && shown && typeof url === "string" && url ? { shown, url } : null;
  if (!doc || installedOn === doc) return;
  installedOn = doc;
  doc.addEventListener("copy", (event) => swapFieldCopy(doc, event), true);
  doc.addEventListener("cut", (event) => swapFieldCopy(doc, event), true);
}
