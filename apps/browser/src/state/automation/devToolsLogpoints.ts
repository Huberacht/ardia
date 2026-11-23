import { openInspection, type InspectionSession } from "./devToolsSession";
import { generatedPositionFor, SourceMapResolver } from "./devToolsSourceMaps";
import { STOPPED } from "./socketCatalog";
import { OpError } from "./workspaceTargets";

export const MAX_EXPRESSION = 2000;
export const MAX_LOGPOINTS_PER_CONNECTION = 50;
export const SCRIPTS_SETTLE_MS = 250;

type Fields = Record<string, unknown>;
type Script = { url: string; sourceMapURL: string | null };
type Logpoint = { id: string; tabId: string; breakpointId: string; url: string; line: number; column: number | null; original: { source: string; line: number; column: number | null } | null };
type Held = { session: InspectionSession; scripts: Map<string, Script>; logpoints: Map<string, Logpoint>; stop: () => void };

const held = new Map<number, Map<string, Held>>();
const opening = new Map<string, Promise<Held>>();
let nextId = 0;

const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 2048): string | null => (typeof value === "string" ? value.slice(0, max) : null);

export function checkedExpression(value: string, what: string): string {
  if (!value.trim()) throw new OpError("bad_request", `${what} can't be empty.`);
  if (value.length > MAX_EXPRESSION) throw new OpError("bad_request", `${what} is longer than ${MAX_EXPRESSION} characters.`);
  if (value.includes("\u0000")) throw new OpError("bad_request", `${what} can't contain a NUL character.`);
  return value;
}

export function logpointCondition(id: string, expression: string, condition: string | null): string {
  const label = JSON.stringify(`[ardia logpoint ${id}]`);
  const guard = condition === null ? "true" : `eval(${JSON.stringify(condition)})`;
  return `(() => { try { if (${guard}) console.log(${label}, eval(${JSON.stringify(expression)})); } catch (e) { try { console.log(${label}, "logpoint error: " + String(e)); } catch (_) {} } return false; })()`;
}

function heldFor(connection: number, tabId: string): Promise<Held> {
  const key = `${connection}:${tabId}`;
  const pending = opening.get(key);
  if (pending) return pending;
  const started = openHeld(connection, tabId).finally(() => opening.delete(key));
  opening.set(key, started);
  return started;
}

async function openHeld(connection: number, tabId: string): Promise<Held> {
  const known = held.get(connection)?.get(tabId);
  if (known && !known.session.isClosed) return known;
  const session = await openInspection(tabId);
  const own = held.get(connection) ?? new Map<string, Held>();
  held.set(connection, own);
  const scripts = new Map<string, Script>();
  const stop = session.on((method, params) => {
    if (method !== "Debugger.scriptParsed" || scripts.size >= 20_000) return;
    const scriptId = text(params.scriptId, 256);
    const url = text(params.url);
    if (!scriptId || !url) return;
    scripts.set(scriptId, { url, sourceMapURL: text(params.sourceMapURL, 16 * 1024 * 1024) || null });
  });
  const entry: Held = { session, scripts, logpoints: new Map(), stop };
  own.set(tabId, entry);
  try {
    await session.send("Debugger.enable", { maxScriptsCacheSize: 0 });
    await new Promise<void>((resolve) => setTimeout(resolve, SCRIPTS_SETTLE_MS));
  } catch (error) {
    await release(connection, tabId);
    throw error;
  }
  return entry;
}

async function release(connection: number, tabId: string) {
  const own = held.get(connection);
  const entry = own?.get(tabId);
  if (!own || !entry) return;
  own.delete(tabId);
  if (!own.size) held.delete(connection);
  entry.stop();
  await entry.session.close();
}

async function locate(entry: Held, url: string, line: number, column: number | null, fetchFn?: typeof fetch) {
  const scripts = [...entry.scripts.values()];
  if (scripts.some((s) => s.url === url)) return { url, line, column, original: null };
  const resolver = new SourceMapResolver({ allowFetch: true, fetchFn });
  for (const script of scripts) {
    if (!script.sourceMapURL) continue;
    const map = await resolver.mapFor(script.url, null, script.sourceMapURL);
    const position = map ? generatedPositionFor(map, url, line, column) : null;
    if (position) return { url: script.url, line: position.line + 1, column: position.column + 1, original: { source: url, line, column } };
  }
  return null;
}

export type SetLogpoint = { connection: number; serving: () => boolean; tabId: string; url: string; line: number; column: number | null; expression: string; condition: string | null; fetchFn?: typeof fetch };

export async function setLogpoint(request: SetLogpoint) {
  const expression = checkedExpression(request.expression, "expression");
  const condition = request.condition === null ? null : checkedExpression(request.condition, "condition");
  const count = [...(held.get(request.connection)?.values() ?? [])].reduce((sum, h) => sum + h.logpoints.size, 0);
  if (count >= MAX_LOGPOINTS_PER_CONNECTION) throw new OpError("refused", `A connection can hold at most ${MAX_LOGPOINTS_PER_CONNECTION} logpoints; clear some first.`);
  const entry = await heldFor(request.connection, request.tabId);
  const stillServing = async () => {
    if (request.serving()) return;
    await release(request.connection, request.tabId);
    throw new OpError("failed", STOPPED);
  };
  await stillServing();
  const where = await locate(entry, request.url, request.line, request.column, request.fetchFn);
  const id = `lp${++nextId}`;
  const target = where ?? { url: request.url, line: request.line, column: request.column, original: null };
  const reply = await entry.session.send("Debugger.setBreakpointByUrl", {
    url: target.url,
    lineNumber: target.line - 1,
    ...(target.column !== null ? { columnNumber: target.column - 1 } : {}),
    condition: logpointCondition(id, expression, condition),
  });
  const breakpointId = text(reply.breakpointId, 1024);
  if (!breakpointId) throw new OpError("failed", "The tab didn't accept the logpoint.");
  const logpoint: Logpoint = { id, tabId: request.tabId, breakpointId, url: target.url, line: target.line, column: target.column, original: target.original };
  entry.logpoints.set(id, logpoint);
  await stillServing();
  const locations = Array.isArray(reply.locations) ? reply.locations.filter(isFields).length : 0;
  return { ...publicView(logpoint), bound: locations > 0, pending: locations === 0, matchedScript: where !== null };
}

const publicView = (logpoint: Logpoint) => ({ id: logpoint.id, tab: logpoint.tabId, url: logpoint.url, line: logpoint.line, column: logpoint.column, original: logpoint.original, label: `[ardia logpoint ${logpoint.id}]` });

export function listLogpoints(connection: number) {
  return [...(held.get(connection)?.values() ?? [])].flatMap((entry) => [...entry.logpoints.values()].map(publicView));
}

export async function clearLogpoint(connection: number, id: string | null) {
  const own = held.get(connection) ?? new Map<string, Held>();
  let cleared = 0;
  for (const [tabId, entry] of [...own.entries()]) {
    for (const logpoint of [...entry.logpoints.values()]) {
      if (id !== null && logpoint.id !== id) continue;
      entry.logpoints.delete(logpoint.id);
      cleared++;
      await entry.session.send("Debugger.removeBreakpoint", { breakpointId: logpoint.breakpointId }).catch(() => ({}));
    }
    if (!entry.logpoints.size) await release(connection, tabId);
  }
  if (id !== null && !cleared) throw new OpError("bad_request", `There's no logpoint ${id} on this connection.`);
  return { cleared };
}

export async function dropLogpoints(connection: number) {
  for (const tabId of [...(held.get(connection)?.keys() ?? [])]) await release(connection, tabId);
}

export async function dropAllLogpoints() {
  for (const connection of [...held.keys()]) await dropLogpoints(connection);
}

export const heldLogpointSessions = () => [...held.values()].reduce((sum, own) => sum + own.size, 0);
