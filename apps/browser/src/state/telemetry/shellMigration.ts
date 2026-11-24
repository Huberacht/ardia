export const SHELL_MIGRATION_ATTEMPT_DOC = "rnw-migration-attempt.json";
export const SHELL_MIGRATION_REPORTED_DOC = "rnw-migration-reported.json";

const OUTCOMES = new Set(["migrated", "migrated_with_skips", "already_migrated", "nothing_to_migrate", "busy", "refused", "failed"]);
const STAGES = new Set(["layout", "lock", "documents", "config", "sync_keys", "credentials", "marker"]);
const COUNTS = [
  "documents",
  "placement",
  "config_files",
  "sync_keys",
  "credentials",
  "unchanged",
  "kept_aside",
  "skipped_links",
  "skipped_invalid",
  "skipped_too_large",
  "skipped_case_clash",
  "sync_keys_unreadable",
  "credentials_incomplete",
  "partials_swept",
] as const;
const COUNT_CAP = 1_000_000;
const DURATION_CAP_MS = 3_600_000;
const RUN = /^[0-9a-f]{32}$/;

type CountName = (typeof COUNTS)[number];
export type ShellMigrationProperties = { outcome: string; failed_stage?: string; attempt: number; duration_ms: number } & { [K in CountName]: number };
export type ShellMigrationReport = { run: string; properties: ShellMigrationProperties };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown, cap: number) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, cap) : 0);

function parsed(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function shellMigrationReport(text: string | null): ShellMigrationReport | null {
  const report = parsed(text);
  if (!isObject(report) || report.version !== 1) return null;
  const { run, outcome, failed_stage: stage } = report;
  if (typeof run !== "string" || !RUN.test(run) || typeof outcome !== "string" || !OUTCOMES.has(outcome)) return null;
  const counts = isObject(report.counts) ? report.counts : {};
  const properties = {
    outcome,
    ...(typeof stage === "string" && STAGES.has(stage) && { failed_stage: stage }),
    attempt: Math.max(1, count(report.attempt, COUNT_CAP)),
    duration_ms: count(report.duration_ms, DURATION_CAP_MS),
    ...Object.fromEntries(COUNTS.map((name) => [name, count(counts[name], COUNT_CAP)])),
  } as ShellMigrationProperties;
  return { run, properties };
}

const reportedRun = (text: string | null) => {
  const reported = parsed(text);
  return isObject(reported) && typeof reported.run === "string" ? reported.run : null;
};

export type ShellMigrationDocuments = { read(name: string): string | null; save(name: string, contents: string): void };

export function shellMigrationOnce(documents: ShellMigrationDocuments): ShellMigrationProperties | null {
  const report = shellMigrationReport(documents.read(SHELL_MIGRATION_ATTEMPT_DOC));
  if (!report || reportedRun(documents.read(SHELL_MIGRATION_REPORTED_DOC)) === report.run) return null;
  documents.save(SHELL_MIGRATION_REPORTED_DOC, JSON.stringify({ run: report.run }));
  return report.properties;
}
