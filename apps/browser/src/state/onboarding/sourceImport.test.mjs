import assert from "node:assert/strict";
import { test } from "node:test";
import { windows } from "../../test-native/shell.ts";
import { patchImport } from "../import/flow.ts";
import { IMPORT_WINDOW_ID } from "../settings/settingsWindows.ts";
import { watchImportEnd } from "./sourceImport.ts";

test("closing the import window before it finishes ends the onboarding import, and closing it after keeps it", () => {
  let abandoned = 0;
  const stop = watchImportEnd(() => abandoned++);
  patchImport({ step: { name: "choose", error: "The selected file is invalid. Please try again." } });
  windows.emit({ type: "close", id: IMPORT_WINDOW_ID });
  assert.equal(abandoned, 1);
  patchImport({ step: { name: "done", counts: {}, failures: [], notes: [], extensions: { profileId: "", list: [], opened: false, listing: null } } });
  windows.emit({ type: "close", id: IMPORT_WINDOW_ID });
  assert.equal(abandoned, 1);
  patchImport({ step: { name: "progress", status: {}, preparing: 0 } });
  windows.emit({ type: "close", id: "settings" });
  assert.equal(abandoned, 1);
  stop();
  windows.emit({ type: "close", id: IMPORT_WINDOW_ID });
  assert.equal(abandoned, 1);
});
