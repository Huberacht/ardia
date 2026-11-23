import assert from "node:assert/strict";
import test from "node:test";
import { EDIT_ITEMS, createEditTargets, editField, editMenu } from "./editCommands.ts";
import { copyFieldAs } from "./fieldCopy.ts";

const element = (kind, extra = {}) => ({
  matches: (selector) => kind === "field" ? selector.startsWith("textarea") : false,
  closest: (selector) => (kind === "menu" && selector.includes("ardia-menu") ? {} : kind === "cluster" && selector.includes('[role="button"][aria-label="Menu"]') ? {} : null),
  isConnected: true, selectionStart: 0, selectionEnd: 0, type: "text", value: "", readOnly: false, disabled: false,
  focused: 0,
  focus() { this.focused++; },
  ...extra,
});
const ids = (...actions) => new Set(EDIT_ITEMS.filter((item) => actions.includes(item.action)).map((item) => item.id));

test("the edit target is the shell text field that had focus before the menu took it, and the page otherwise", () => {
  const targets = createEditTargets();
  assert.deepEqual(targets.current(), { kind: "page" });
  const field = element("field");
  targets.focusIn(field);
  assert.equal(targets.current().field, field);
  targets.focusIn(element("menu"));
  assert.equal(targets.current().field, field, "opening the menu doesn't change what the entries act on");
  targets.focusIn(element("cluster"));
  assert.equal(targets.current().field, field, "tabbing to the … beside the window buttons keeps the field for Edit › Copy and Paste");
  targets.pageFocused();
  assert.deepEqual(targets.current(), { kind: "page" }, "a page that took focus is the target, though the field is still the document's active element");
  targets.focusIn(field);
  field.isConnected = false;
  assert.deepEqual(targets.current(), { kind: "page" }, "a field that is gone hands over to the page");
  targets.focusIn(element("field"));
  targets.focusIn(element("button"));
  assert.deepEqual(targets.current(), { kind: "page" }, "a button isn't editable, so the page is");
  targets.focusIn(null);
  assert.deepEqual(targets.current(), { kind: "page" });
});

test("the entries show only when they can act, and Cut and Copy need a selection", () => {
  assert.equal(editMenu(null, true), null);
  assert.equal(editMenu({ kind: "page" }, false), null, "a host without tab.edit can't edit a page");
  assert.deepEqual(editMenu({ kind: "page" }, true), { disabled: new Set() });
  assert.deepEqual(editMenu({ kind: "field", field: element("field", { value: "" }) }, false).disabled, ids("cut", "copy", "selectAll"));
  assert.deepEqual(editMenu({ kind: "field", field: element("field", { value: "abc", selectionStart: 0, selectionEnd: 2 }) }, false).disabled, new Set());
  assert.deepEqual(editMenu({ kind: "field", field: element("field", { value: "abc", selectionStart: 0, selectionEnd: 2, type: "password" }) }, false).disabled, ids("cut", "copy"));
  assert.deepEqual(editMenu({ kind: "field", field: element("field", { value: "abc", selectionStart: 1, selectionEnd: 3, readOnly: true }) }, false).disabled, ids("undo", "redo", "cut", "paste", "pasteAndMatchStyle"));
  assert.equal(editMenu({ kind: "field", field: element("field", { disabled: true }) }, true), null);
  const throwing = element("field", { value: "1" });
  Object.defineProperty(throwing, "selectionStart", { get() { throw new Error("no selection on this input type"); } });
  assert.deepEqual(editMenu({ kind: "field", field: throwing }, false).disabled, ids("cut", "copy"));
});

test("a shell text field is edited with the web platform after it gets its focus back", async () => {
  const field = element("field", { value: "abc" });
  const run = [];
  const port = (paste, text = "clip") => ({ exec: (command, value) => (run.push([command, value]), command === "paste" ? paste : true), readClipboard: async () => text });
  for (const action of ["undo", "redo", "cut", "copy", "selectAll"]) assert.equal(await editField(field, action, port(true)), true);
  assert.deepEqual(run, [["undo", undefined], ["redo", undefined], ["cut", undefined], ["copy", undefined], ["selectAll", undefined]]);
  assert.equal(field.focused, 5);
  run.length = 0;
  assert.equal(await editField(field, "paste", port(true)), true);
  assert.deepEqual(run, [["paste", undefined]]);
  run.length = 0;
  assert.equal(await editField(field, "pasteAndMatchStyle", port(false)), true);
  assert.deepEqual(run, [["paste", undefined], ["insertText", "clip"]], "where the engine refuses a scripted paste, the clipboard's text is inserted");
  run.length = 0;
  assert.equal(await editField(field, "paste", port(false, "")), false);
  assert.deepEqual(run, [["paste", undefined]]);
  field.isConnected = false;
  run.length = 0;
  assert.equal(await editField(field, "copy", port(true)), false);
  assert.deepEqual(run, []);
});

const addressField = (value, start, end) => element("field", { value, selectionStart: start, selectionEnd: end, getAttribute: (name) => (name === "data-testid" ? "ardia-address-field" : null) });

function fieldCopyDocument() {
  const listeners = {};
  const doc = {
    activeElement: null,
    depth: 0,
    deleted: [],
    addEventListener: (type, listener) => void (listeners[type] = listener),
    execCommand(command) {
      if (this.depth > 0) return false;
      this.deleted.push(command);
      return true;
    },
    fire(type) {
      const event = { type, data: null, prevented: false, clipboardData: { setData: (_, data) => void (event.data = data) }, preventDefault: () => void (event.prevented = true) };
      listeners[type](event);
      return event;
    },
  };
  return doc;
}

test("copying or cutting the whole address field puts the cleaned address on the clipboard, as the Mac's native swap does", async () => {
  const doc = fieldCopyDocument();
  const shown = "shop.example/item?id=7&utm_source=mail";
  copyFieldAs(shown, "https://shop.example/item?id=7", doc);
  doc.activeElement = addressField(shown, 0, shown.length);
  assert.equal(doc.fire("copy").data, "https://shop.example/item?id=7");
  assert.equal(doc.fire("cut").data, "https://shop.example/item?id=7");
  await Promise.resolve();
  assert.deepEqual(doc.deleted, ["delete"]);
  doc.activeElement = addressField(shown, 3, shown.length);
  const partial = doc.fire("copy");
  assert.deepEqual([partial.data, partial.prevented], [null, false]);
  doc.activeElement = addressField("typed text", 0, 10);
  assert.equal(doc.fire("copy").prevented, false);
  copyFieldAs(null, null, doc);
  doc.activeElement = addressField(shown, 0, shown.length);
  assert.equal(doc.fire("copy").prevented, false);
});

test("another field holding the same text as the address field is copied as it is", () => {
  const doc = fieldCopyDocument();
  copyFieldAs("example.com", "https://example.com/", doc);
  doc.activeElement = element("field", { value: "example.com", selectionStart: 0, selectionEnd: 11, getAttribute: () => null });
  const event = doc.fire("copy");
  assert.deepEqual([event.data, event.prevented], [null, false]);
});

test("Edit > Cut on the whole address puts the cleaned address on the clipboard and still empties the field, outside the cut command", async () => {
  const doc = fieldCopyDocument();
  const shown = "shop.example/item?id=7&utm_source=mail";
  copyFieldAs(shown, "https://shop.example/item?id=7", doc);
  const field = addressField(shown, 0, shown.length);
  doc.activeElement = field;
  let clipboard = null;
  const port = {
    exec(command) {
      doc.depth++;
      try {
        if (command === "cut") clipboard = doc.fire("cut").data;
        return true;
      } finally {
        doc.depth--;
      }
    },
    readClipboard: async () => "",
  };
  assert.equal(await editField(field, "cut", port), true);
  await Promise.resolve();
  assert.equal(clipboard, "https://shop.example/item?id=7");
  assert.deepEqual(doc.deleted, ["delete"]);
});
