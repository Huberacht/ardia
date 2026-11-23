import { readDocument, removeDocument } from "../../platform/documents";
import type { BrowserState } from "../browser/store";

export function removeLegacyFiles(s: Pick<BrowserState, "profiles">) {
  for (const id of Object.keys(s.profiles)) {
    const doc = `favicons-${id}.json`;
    try {
      if (readDocument(doc) === null) continue;
      removeDocument(doc);
    } catch (error) {
      console.warn(`[favicons] couldn't remove ${doc}`, error);
    }
  }
}
