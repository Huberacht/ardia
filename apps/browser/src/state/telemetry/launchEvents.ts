import { useBrowser } from "../browser/store";
import { capture, stillValid, type ConsentToken, type startClient } from "./usageClient";
import { contextProperties, hardwareProperties, launchGuardProperties } from "./diagnostics";
import { topAppsSharingAtLaunch } from "./topAppsSharing";
import { appInfo } from "./transport";
import { engineMatchProperties } from "./engineMatch";
import { HOST_SHELL } from "./hostShell";
import { reportShellMigration } from "./shellMigration";
import { documentSaved, readDocument, saveDocument } from "../../platform/documents";

const rebootedSince = (lastLaunchAt: number | null) => {
  const boot = appInfo().bootTime;
  return lastLaunchAt != null && boot != null ? boot > lastLaunchAt : null;
};

export async function launchEvents(session: ReturnType<typeof startClient>, consent: ConsentToken | null) {
  const topApps = topAppsSharingAtLaunch(useBrowser.getState(), session.updatedFrom);
  const hardware = await hardwareProperties();
  const previous = session.previous === "unclean" ? { ...contextProperties(session.context, "prev_", Date.now()), rebooted_since: rebootedSince(session.lastLaunchAt) } : {};
  capture("app_launched", { previous_session: session.previous, ...hardware, ...previous, ...launchGuardProperties(), ...engineMatchProperties(appInfo().engineMatch) }, consent);
  if (session.updatedFrom) capture("app_updated", { from_version: session.updatedFrom }, consent);
  capture("top_apps_sharing", topApps, consent);
  if (HOST_SHELL === "webui") await reportShellMigrationAtLaunch(consent);
}

export function reportShellMigrationAtLaunch(consent: ConsentToken | null) {
  return reportShellMigration({
    read: readDocument,
    save: async (name, contents) => {
      await saveDocument(name, contents);
      await documentSaved(name);
    },
    sharing: () => stillValid(consent),
    send: (properties) => capture("shell_migration", properties, consent),
  }).catch(() => "unsaved" as const);
}
