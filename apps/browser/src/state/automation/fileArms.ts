import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { armFilePanel, armsFilePanels as nativeArmsFilePanels, disarmFilePanels, filePanelArms, placeArmedDownload, type FileArmKind, type FileArmRow } from "../../platform/automation";
import { onDownload, type Download } from "../../platform/downloads";
import { secureRandomHex } from "../../platform/secureRandom";
import { foreignWriteHooks } from "../browser/foreignWriteHooks";
import { engineProfile } from "../browser/model";
import { useBrowser } from "../browser/store";
import { noteFileArm } from "../telemetry/cliCounts";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { claimDownload } from "./downloadHooks";
import type { SocketCall } from "./socketCatalog";
import { OpError } from "./workspaceTargets";

export const MAX_UPLOAD_PATHS = 64;
export const MAX_PATH_BYTES = 1024;
export const DEFAULT_ARM_SECONDS = 120;
export const MAX_ARM_SECONDS = 600;
export const MAX_ARMS = 16;
const POLL_MS = 2_000;
const KEEP_ENDED_MS = 600_000;

const armsFilePanels = () => PLATFORM_FEATURES.silentFilePanels && nativeArmsFilePanels();

export const UNSUPPORTED = "Answering file panels for the ardia command needs Ardia on macOS for now.";

export type DownloadProgress = { downloadId: string; state: "downloading" | "finished" | "failed" | "cancelled"; path: string | null; bytes: number; reason?: string };

type Tracked = {
  id: string;
  kind: FileArmKind;
  tab: string | null;
  engineProfile: string | null;
  before: ReadonlySet<string>;
  once: boolean;
  open: boolean;
  expiresAt: number;
  endedAt: number | null;
  answeredSeen: number;
  failureSeen: boolean;
  downloads: DownloadProgress[];
  consent: ConsentToken | null;
};

const tracked = new Map<string, Tracked>();
const byDownload = new Map<string, string>();
let downloadsWatched: { remove(): void } | null = null;
const settling = new Set<string>();
let tabsWatched: (() => void) | null = null;
let poll: ReturnType<typeof setInterval> | null = null;

const encoder = new TextEncoder();

export function localPathProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value) return "a path is a non-empty string";
  if (!value.startsWith("/")) return `${value.slice(0, 80)} isn't an absolute path`;
  if (/[\0\r\n]/.test(value)) return "a path can't hold a NUL or a line break";
  if (encoder.encode(value).length > MAX_PATH_BYTES) return `a path is at most ${MAX_PATH_BYTES} bytes`;
  if (value.split("/").some((part) => part === "." || part === "..")) return "a path can't step through . or ..";
  return null;
}

const REASONS: Record<string, string> = {
  notAbsolute: "isn't an absolute path",
  badCharacters: "holds a NUL or a line break",
  tooLong: "is too long",
  traversal: "steps through . or ..",
  missing: "doesn't exist",
  unreadable: "can't be read",
  notAFile: "isn't a file or folder",
  symlink: "is a symbolic link; name the file or folder itself",
  exists: "already exists; Ardia won't replace a file",
  folderMissing: "is in a folder that doesn't exist",
  notAFolder: "is inside something that isn't a folder",
  folderNotWritable: "is in a folder Ardia can't write to",
  badName: "has a name a file can't take",
};

function armRefusal(reason: string, path?: string): OpError {
  if (reason === "noTab") return new OpError("no_window", "That tab has no page loaded; wake it first.");
  if (reason === "tooMany") return new OpError("refused", `At most ${MAX_ARMS} file arms wait at once; clear some with files.disarm.`);
  if (reason === "onceForFile") return new OpError("bad_request", "A download path names one file; arm again for the next one, or name a folder to keep answering.");
  if (reason === "unsupported") return new OpError("refused", UNSUPPORTED);
  const why = REASONS[reason];
  if (why) return new OpError("bad_request", `${path ? path.slice(0, 200) : "The path"} ${why}.`);
  return new OpError("failed", `Ardia couldn't arm that (${reason.slice(0, 40)}).`);
}

function sweepTracked(now = Date.now()) {
  for (const [id, t] of tracked) {
    if (t.open && now >= t.expiresAt) {
      t.open = false;
      t.endedAt = now;
    }
    const busy = t.downloads.some((d) => d.state === "downloading");
    if (!t.open && !busy && t.endedAt !== null && now - t.endedAt > KEEP_ENDED_MS) {
      tracked.delete(id);
      for (const d of t.downloads) byDownload.delete(d.downloadId);
    }
  }
}

function end(t: Tracked) {
  if (!t.open) return;
  t.open = false;
  t.endedAt = Date.now();
}

function claimant(d: Download): Tracked | null {
  let pick: Tracked | null = null;
  for (const t of tracked.values()) {
    if (t.kind !== "download" || !t.open || Date.now() >= t.expiresAt || t.before.has(d.id)) continue;
    if (t.engineProfile !== null && (d.profile ?? "") !== t.engineProfile) continue;
    if (t.once && t.downloads.length) continue;
    if (!pick || (t.tab !== null && pick.tab === null)) pick = t;
  }
  return pick;
}

async function settle(t: Tracked, row: DownloadProgress, d: Download, consent: ConsentToken | null) {
  const placed = await placeArmedDownload(t.id, d.path).catch((error: unknown) => ({ ok: false as const, reason: String(error).slice(0, 80) }));
  if (!placed.ok) {
    row.state = "failed";
    row.reason = placed.reason;
    noteFileArm("arm_failures", 1, consent);
    return;
  }
  row.state = "finished";
  row.path = placed.path;
  row.bytes = placed.bytes;
  noteFileArm("downloads_placed", 1, consent);
  if (placed.path === d.path) return;
  const current = useBrowser.getState().downloads.find((x) => x.id === d.id);
  if (current) foreignWriteHooks.around(() => useBrowser.getState().upsertDownload({ ...current, path: placed.path, filename: placed.path.split("/").pop() || current.filename }));
}

function noteDownload(d: Download) {
  if (d.offTheRecord) return;
  let armId = byDownload.get(d.id);
  if (!armId) {
    if (d.state !== "downloading" && d.state !== "finished") return;
    const t = claimant(d);
    if (!t) return;
    armId = t.id;
    byDownload.set(d.id, armId);
    t.downloads.push({ downloadId: d.id, state: "downloading", path: null, bytes: 0 });
    claimDownload(d.id);
    if (t.once) end(t);
  }
  const t = tracked.get(armId);
  const row = t?.downloads.find((r) => r.downloadId === d.id);
  if (!t || !row || row.state !== "downloading") return;
  row.bytes = d.received || d.total || row.bytes;
  if (d.path) row.path = d.path;
  if (d.state === "downloading") return;
  if (d.state === "finished") {
    if (d.dangerous || settling.has(d.id)) return;
    settling.add(d.id);
    void settle(t, row, d, t.consent).finally(() => settling.delete(d.id));
    return;
  }
  row.state = d.state;
  noteFileArm("arm_failures", 1, t.consent);
}

function watchTabs() {
  if (tabsWatched) return;
  tabsWatched = useBrowser.subscribeTo(["tabs"], (s) => {
    const gone = [...tracked.values()].filter((t) => t.open && t.tab !== null && !s.tabs[t.tab]);
    if (!gone.length) return;
    for (const t of gone) end(t);
    void disarmFilePanels(gone.map((t) => t.id)).catch(() => 0);
  });
}

function account(rows: readonly FileArmRow[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const t of tracked.values()) {
    const row = byId.get(t.id);
    if (!row) continue;
    if (row.answered > t.answeredSeen) {
      if (t.kind === "upload") noteFileArm("uploads_answered", row.answered - t.answeredSeen, t.consent);
      t.answeredSeen = row.answered;
    }
    if (row.state === "failed" && !t.failureSeen) {
      t.failureSeen = true;
      noteFileArm("arm_failures", 1, t.consent);
    }
    if (row.state !== "armed" && (t.kind === "upload" || row.state !== "answered")) end(t);
  }
  sweepTracked();
}

function startPolling() {
  if (poll) return;
  poll = setInterval(() => {
    if (![...tracked.values()].some((t) => t.open)) {
      clearInterval(poll!);
      poll = null;
      return;
    }
    void filePanelArms()
      .then(account)
      .catch(() => undefined);
  }, POLL_MS);
}

export type ArmRequest = { kind: FileArmKind; tab: string | null; profileId: string | null; paths: string[]; once: boolean; seconds: number };

export async function armFiles(request: ArmRequest, call: SocketCall) {
  const consent = consentToken();
  if (!armsFilePanels()) throw new OpError("refused", UNSUPPORTED);
  for (const path of request.paths) {
    const problem = localPathProblem(path);
    if (problem) throw new OpError("bad_request", `${problem}.`);
  }
  sweepTracked();
  const id = `f-${secureRandomHex(16)}`;
  const s = useBrowser.getState();
  const engine = request.profileId !== null ? engineProfile(s, request.profileId) : null;
  const before = new Set(s.downloads.map((d) => d.id));
  call.stillServing();
  const made = await armFilePanel({ id, kind: request.kind, tab: request.tab, paths: request.paths, once: request.once, seconds: request.seconds });
  if (!made.ok) throw armRefusal(made.reason, made.path);
  if (!call.serving()) {
    void disarmFilePanels([id]).catch(() => 0);
    call.stillServing();
  }
  tracked.set(id, {
    id,
    kind: request.kind,
    tab: request.tab,
    engineProfile: engine,
    before,
    once: made.arm.once,
    open: true,
    expiresAt: made.arm.expiresAt,
    endedAt: null,
    answeredSeen: 0,
    failureSeen: false,
    downloads: [],
    consent,
  });
  noteFileArm(request.kind === "upload" ? "upload_arms" : "download_arms", 1, consent);
  if (request.kind === "download") downloadsWatched ??= onDownload(noteDownload);
  watchTabs();
  startPolling();
  return armView(made.arm);
}

export function armView(row: FileArmRow) {
  const t = tracked.get(row.id);
  const downloads = t?.downloads.map((d) => ({ ...d })) ?? [];
  const last = downloads[downloads.length - 1];
  const state = row.kind === "download" && last ? last.state : row.kind === "download" && row.state === "answered" ? "downloading" : row.state;
  return {
    arm: row.id,
    kind: row.kind,
    tab: row.tab,
    ...(row.kind === "upload" ? { paths: row.paths, chosen: row.landed } : { path: row.paths[0] ?? null, folder: row.folder }),
    once: row.once,
    state,
    ...(row.reason ? { reason: row.reason } : {}),
    armedAt: row.armedAt,
    expiresAt: row.expiresAt,
    answered: row.answered,
    ...(row.kind === "download" ? { downloads } : {}),
  };
}

export async function listArms(only: readonly string[] | null) {
  if (!armsFilePanels()) return { items: [] };
  const rows = await filePanelArms();
  account(rows);
  return { items: rows.filter((r) => only === null || only.includes(r.id)).map(armView) };
}

export async function disarm(only: readonly string[] | null) {
  if (!armsFilePanels()) return { cleared: 0 };
  for (const t of tracked.values()) if (only === null || only.includes(t.id)) end(t);
  return { cleared: await disarmFilePanels(only === null ? null : [...only]) };
}

export function clearFileArms() {
  const had = tracked.size > 0;
  tracked.clear();
  byDownload.clear();
  if (poll) clearInterval(poll);
  poll = null;
  if (had && armsFilePanels()) void disarmFilePanels(null).catch(() => 0);
}

export function resetFileArmsForTests() {
  clearFileArms();
  downloadsWatched?.remove();
  downloadsWatched = null;
  settling.clear();
  tabsWatched?.();
  tabsWatched = null;
}
