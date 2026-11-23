export const MAX_MAP_BYTES = 10 * 1024 * 1024;
export const MAX_SCRIPT_BYTES = 16 * 1024 * 1024;
export const MAX_MAPS_PER_CALL = 16;
export const SOURCE_FETCH_TIMEOUT_MS = 5_000;
const MAX_SEGMENTS = 4_000_000;
const MAX_SECTIONS = 64;

type Segment = [number, number, number, number, number];

export type ParsedMap = { sources: string[]; names: string[]; lines: Segment[][]; sections: { line: number; column: number; map: ParsedMap }[] | null };
export type Original = { source: string; line: number; column: number; name: string | null };

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGIT = new Map([...B64].map((c, i) => [c, i]));

const isFields = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v.slice(0, 4096) : "")) : []);

function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let line: Segment[] = [];
  let source = 0, srcLine = 0, srcCol = 0, name = 0, count = 0;
  let i = 0;
  while (i < mappings.length) {
    const c = mappings[i]!;
    if (c === ";") {
      lines.push(line);
      line = [];
      i++;
      continue;
    }
    if (c === ",") {
      i++;
      continue;
    }
    const fields: number[] = [];
    while (i < mappings.length && mappings[i] !== "," && mappings[i] !== ";") {
      let value = 0, shift = 0, more = true;
      while (more) {
        const digit = DIGIT.get(mappings[i++] ?? "");
        if (digit === undefined || shift > 30) throw new Error("bad mappings");
        more = (digit & 32) !== 0;
        value += (digit & 31) * 2 ** shift;
        shift += 5;
      }
      fields.push(value % 2 === 1 ? -Math.floor(value / 2) : Math.floor(value / 2));
    }
    if (++count > MAX_SEGMENTS) throw new Error("too many mappings");
    const prev = line[line.length - 1];
    const column = (prev ? prev[0] : 0) + fields[0]!;
    if (fields.length >= 4) {
      source += fields[1]!;
      srcLine += fields[2]!;
      srcCol += fields[3]!;
      if (fields.length >= 5) name += fields[4]!;
      line.push([column, source, srcLine, srcCol, fields.length >= 5 ? name : -1]);
    } else {
      line.push([column, -1, -1, -1, -1]);
    }
  }
  lines.push(line);
  for (const l of lines) l.sort((a, b) => a[0] - b[0]);
  return lines;
}

export function parseSourceMap(raw: unknown, depth = 0): ParsedMap | null {
  const value = typeof raw === "string" ? safeJson(raw) : raw;
  if (!isFields(value) || value.version !== 3) return null;
  if (Array.isArray(value.sections)) {
    if (depth > 0) return null;
    const sections: NonNullable<ParsedMap["sections"]> = [];
    for (const section of value.sections.slice(0, MAX_SECTIONS)) {
      const offset = isFields(section) && isFields(section.offset) ? section.offset : null;
      const map = isFields(section) ? parseSourceMap(section.map, depth + 1) : null;
      const line = typeof offset?.line === "number" && Number.isSafeInteger(offset.line) ? offset.line : null;
      const column = typeof offset?.column === "number" && Number.isSafeInteger(offset.column) ? offset.column : null;
      if (map && line !== null && column !== null) sections.push({ line, column, map });
    }
    return { sources: [], names: [], lines: [], sections };
  }
  if (typeof value.mappings !== "string") return null;
  const root = typeof value.sourceRoot === "string" && value.sourceRoot ? value.sourceRoot.replace(/\/?$/, "/") : "";
  try {
    return { sources: strings(value.sources).map((s) => (root && !/^[a-z]+:/i.test(s) ? root + s : s)), names: strings(value.names), lines: decodeMappings(value.mappings), sections: null };
  } catch {
    return null;
  }
}

function safeJson(raw: string): unknown {
  if (raw.length > MAX_MAP_BYTES) return null;
  try {
    return JSON.parse(raw.replace(/^\)\]\}'[^\n]*\n/, ""));
  } catch {
    return null;
  }
}

export function originalPositionFor(map: ParsedMap, line0: number, column0: number): Original | null {
  if (map.sections) {
    let chosen: (typeof map.sections)[number] | null = null;
    for (const section of map.sections) if (section.line < line0 || (section.line === line0 && section.column <= column0)) chosen = section;
    if (!chosen) return null;
    return originalPositionFor(chosen.map, line0 - chosen.line, line0 === chosen.line ? column0 - chosen.column : column0);
  }
  const segments = map.lines[line0];
  if (!segments?.length) return null;
  let lo = 0, hi = segments.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid]![0] <= column0) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const segment = found >= 0 ? segments[found]! : null;
  if (!segment || segment[1] < 0) return null;
  const source = map.sources[segment[1]];
  if (source === undefined) return null;
  return { source, line: segment[2] + 1, column: segment[3] + 1, name: segment[4] >= 0 ? (map.names[segment[4]] ?? null) : null };
}

const sourceMatches = (source: string, wanted: string) => source === wanted || source.endsWith(`/${wanted.replace(/^\.?\//, "")}`);

export function generatedPositionFor(map: ParsedMap, wanted: string, line1: number, column1: number | null): { line: number; column: number } | null {
  if (map.sections) {
    for (const section of map.sections) {
      const inner = generatedPositionFor(section.map, wanted, line1, column1);
      if (inner) return { line: inner.line + section.line, column: inner.line === 0 ? inner.column + section.column : inner.column };
    }
    return null;
  }
  const indexes = new Set(map.sources.flatMap((s, i) => (sourceMatches(s, wanted) ? [i] : [])));
  if (!indexes.size) return null;
  let best: { line: number; column: number; srcCol: number } | null = null;
  for (const [genLine, segments] of map.lines.entries()) {
    for (const segment of segments) {
      if (!indexes.has(segment[1]) || segment[2] !== line1 - 1) continue;
      if (column1 !== null && segment[3] < column1 - 1) continue;
      if (!best || segment[3] < best.srcCol || (segment[3] === best.srcCol && (genLine < best.line || (genLine === best.line && segment[0] < best.column)))) best = { line: genLine, column: segment[0], srcCol: segment[3] };
    }
  }
  return best ? { line: best.line, column: best.column } : null;
}

export function sourceMapRefOf(script: string): string | null {
  let at = script.length;
  while (at > 0) {
    const found = script.lastIndexOf("sourceMappingURL=", at - 1);
    if (found < 2) return null;
    const marker = script.slice(found - 2, found);
    const match = /^([^\s'"]+)\s*(?:\*\/)?\s*$/.exec(script.slice(found + "sourceMappingURL=".length).split("\n")[0]!);
    if ((marker === "# " || marker === "@ ") && match) return match[1]!;
    at = found;
  }
  return null;
}

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export type MapLocation = { kind: "inline"; text: string } | { kind: "remote"; url: string };

export function mapLocation(scriptUrl: string, ref: string): MapLocation | null {
  const inline = /^data:application\/json(?:;charset=[\w-]+)?;base64,([A-Za-z0-9+/=]+)$/i.exec(ref);
  if (inline) {
    if (inline[1]!.length > (MAX_MAP_BYTES * 4) / 3) return null;
    try {
      return { kind: "inline", text: decodeBase64Utf8(inline[1]!) };
    } catch {
      return null;
    }
  }
  const script = httpUrl(scriptUrl);
  if (!script) return null;
  let target: URL;
  try {
    target = new URL(ref, script);
  } catch {
    return null;
  }
  if (!httpUrl(target.href) || target.origin !== script.origin) return null;
  return { kind: "remote", url: target.href };
}

function decodeBase64Utf8(data: string): string {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export type MapFailure = { url: string; reason: "not-web" | "too-big" | "fetch-failed" | "no-map" | "cross-origin" | "bad-map" | "limit" };

export class SourceMapResolver {
  private maps = new Map<string, ParsedMap | null>();
  private loads = 0;
  readonly failures: MapFailure[] = [];
  private fetchFn: typeof fetch;
  private allowFetch: boolean;

  constructor(options: { provided?: Readonly<Record<string, unknown>>; fetchFn?: typeof fetch; allowFetch: boolean }) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.allowFetch = options.allowFetch;
    for (const [url, raw] of Object.entries(options.provided ?? {}).slice(0, MAX_MAPS_PER_CALL)) this.maps.set(url, parseSourceMap(raw));
  }

  get resolvedCount() {
    return [...this.maps.values()].filter((m) => m !== null).length;
  }

  private fail(url: string, reason: MapFailure["reason"]) {
    if (!this.failures.some((f) => f.url === url)) this.failures.push({ url: url.slice(0, 2048), reason });
    this.maps.set(url, null);
    return null;
  }

  private async fetchText(url: string, limit: number): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SOURCE_FETCH_TIMEOUT_MS);
    try {
      const reply = await this.fetchFn(url, { credentials: "omit", redirect: "error", signal: controller.signal });
      if (!reply.ok) return null;
      const declared = Number(reply.headers?.get?.("content-length") ?? NaN);
      if (Number.isFinite(declared) && declared > limit) return null;
      const reader = reply.body?.getReader?.();
      if (!reader) {
        const body = await reply.text();
        return body.length > limit ? null : body;
      }
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > limit) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async mapFor(scriptUrl: string, scriptSource?: string | null, mapRef?: string | null): Promise<ParsedMap | null> {
    if (this.maps.has(scriptUrl)) return this.maps.get(scriptUrl)!;
    if (!httpUrl(scriptUrl) && !mapRef?.startsWith("data:")) return this.fail(scriptUrl, "not-web");
    if (!this.allowFetch && !mapRef?.startsWith("data:")) return this.fail(scriptUrl, "no-map");
    if (++this.loads > MAX_MAPS_PER_CALL) return this.fail(scriptUrl, "limit");
    let ref = mapRef ?? null;
    if (!ref) {
      const script = scriptSource ?? (await this.fetchText(scriptUrl, MAX_SCRIPT_BYTES));
      if (script === null) return this.fail(scriptUrl, "fetch-failed");
      ref = sourceMapRefOf(script);
    }
    if (!ref) return this.fail(scriptUrl, "no-map");
    const location = mapLocation(scriptUrl, ref);
    if (!location) return this.fail(scriptUrl, ref.startsWith("data:") ? "bad-map" : "cross-origin");
    const text = location.kind === "inline" ? location.text : this.allowFetch ? await this.fetchText(location.url, MAX_MAP_BYTES) : null;
    if (text === null) return this.fail(scriptUrl, "fetch-failed");
    if (text.length > MAX_MAP_BYTES) return this.fail(scriptUrl, "too-big");
    const parsed = parseSourceMap(text);
    if (!parsed) return this.fail(scriptUrl, "bad-map");
    this.maps.set(scriptUrl, parsed);
    return parsed;
  }
}
