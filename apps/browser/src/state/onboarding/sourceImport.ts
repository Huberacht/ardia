import { onWindowEvent } from "../../platform/windows";
import { importNow } from "../import/flow";
import { IMPORT_WINDOW_ID } from "../settings/settingsWindows";

export function watchImportEnd(onAbandoned: () => void): () => void {
  const watch = onWindowEvent((e) => {
    if (e.type === "close" && e.id === IMPORT_WINDOW_ID && importNow().step.name !== "done") onAbandoned();
  });
  return () => watch.remove();
}
