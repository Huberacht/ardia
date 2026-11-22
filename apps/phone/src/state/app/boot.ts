import "../../platform/copy";
import type { ImportOutcome } from "../legacy/importer";
import { importOldApp, startWithoutOldApp } from "../legacy/upgrade";
import { keepWaitingLinks, listenForLinks } from "../links/links";
import { readPreferences, writePreference } from "../store/browserDatabase";
import { browserDatabase, browserDatabaseIsDurable } from "../store/database";
import { useBoot } from "./bootState";
import { launchArguments } from "./launchFlags";

export { useBoot };

let begin: (() => void) | null = null;

const SETTLED_IMPORT_KEY = "legacy.settled";
const SETTLED_OUTCOMES: readonly ImportOutcome[] = ["none", "imported", "startedFresh"];

function importSettledBefore(): ImportOutcome | null {
  try {
    if (!browserDatabaseIsDurable()) return null;
    const stored = readPreferences(browserDatabase())[SETTLED_IMPORT_KEY];
    return SETTLED_OUTCOMES.find((outcome) => outcome === stored) ?? null;
  } catch {
    return null;
  }
}

function rememberImportSettled(outcome: ImportOutcome) {
  try {
    if (browserDatabaseIsDurable()) writePreference(browserDatabase(), SETTLED_IMPORT_KEY, outcome);
  } catch {
    return;
  }
}

export function bootApp(start: () => void) {
  if (begin) return;
  begin = start;
  listenForLinks();
  if (launchArguments().isDemo) {
    finish("none");
    return;
  }
  const settled = importSettledBefore();
  if (settled) finish(settled);
  else void attempt();
}

async function attempt() {
  useBoot.setState({ busy: true });
  const result = await importOldApp();
  if (result.kind === "ready") finish(result.outcome);
  else {
    useBoot.setState((state) => ({ failures: state.failures + 1, busy: false }));
    keepWaitingLinks();
  }
}

function finish(outcome: ImportOutcome) {
  if (useBoot.getState().ready || !begin) return;
  begin();
  useBoot.setState({ ready: true, busy: false, outcome });
  if (!launchArguments().isDemo) rememberImportSettled(outcome);
}

export function retryImport() {
  const state = useBoot.getState();
  if (state.ready || state.busy || !begin) return;
  void attempt();
}

export async function startWithoutImporting() {
  const state = useBoot.getState();
  if (state.ready || state.busy || !begin) return;
  useBoot.setState({ busy: true });
  if (await startWithoutOldApp()) finish("startedFresh");
  else useBoot.setState((s) => ({ failures: s.failures + 1, busy: false }));
}
