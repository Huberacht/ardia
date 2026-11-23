import { STOPPED } from "./socketCatalog";
import { OpError } from "./workspaceTargets";

export type CdpParams = Record<string, unknown>;
export type CdpEventListener = (method: string, params: CdpParams) => void;

export type DevToolsTransport = {
  send(method: string, params: CdpParams): Promise<CdpParams>;
  onEvent(listener: CdpEventListener): () => void;
  close(): Promise<void>;
};

export type TransportOpener = (tabId: string) => Promise<DevToolsTransport>;

export const INSPECTION_METHODS: ReadonlySet<string> = new Set([
  "Tracing.start",
  "Tracing.end",
  "Audits.enable",
  "Audits.disable",
  "DOM.enable",
  "DOM.disable",
  "DOM.getDocument",
  "DOM.querySelector",
  "CSS.enable",
  "CSS.disable",
  "CSS.getMatchedStylesForNode",
  "CSS.getComputedStyleForNode",
  "Debugger.enable",
  "Debugger.disable",
  "Debugger.setBreakpointByUrl",
  "Debugger.removeBreakpoint",
  "Page.reload",
]);

const DISABLE_OF: Readonly<Record<string, string>> = {
  "Audits.enable": "Audits.disable",
  "DOM.enable": "DOM.disable",
  "CSS.enable": "CSS.disable",
  "Debugger.enable": "Debugger.disable",
};

export const UNAVAILABLE = "This Ardia can't open a DevTools inspection session on a tab yet.";
export const SESSION_ENDED = "The inspection session ended before it finished.";

let opener: TransportOpener | null = null;
const byConnection = new Map<number, Set<InspectionSession>>();
const connectionEpochs = new Map<number, number>();
let controlEpoch = 0;

export const setInspectionTransport = (next: TransportOpener | null) => void (opener = next);
export const liveInspectionSessions = () => [...byConnection.values()].reduce((sum, set) => sum + set.size, 0);

export class InspectionSession {
  readonly tabId: string;
  readonly connection: number;
  readonly ended: Promise<void>;
  private transport: DevToolsTransport;
  private enabled: string[] = [];
  private breakpoints = new Set<string>();
  private tracing = false;
  private listeners = new Set<CdpEventListener>();
  private inFlight = new Set<Promise<unknown>>();
  private unsubscribe: () => void;
  private closing: Promise<void> | null = null;
  private markEnded!: () => void;

  constructor(tabId: string, connection: number, transport: DevToolsTransport) {
    this.tabId = tabId;
    this.connection = connection;
    this.transport = transport;
    this.ended = new Promise((resolve) => (this.markEnded = resolve));
    const own = byConnection.get(connection) ?? new Set<InspectionSession>();
    own.add(this);
    byConnection.set(connection, own);
    this.unsubscribe = transport.onEvent((method, params) => {
      for (const listener of [...this.listeners]) listener(method, params);
    });
  }

  get isClosed() {
    return this.closing !== null;
  }

  send(method: string, params: CdpParams = {}): Promise<CdpParams> {
    if (this.closing) return Promise.reject(new OpError("failed", SESSION_ENDED));
    if (!INSPECTION_METHODS.has(method)) return Promise.reject(new OpError("refused", `An inspection session never sends ${method}.`));
    const work = this.transport.send(method, params).then((reply) => {
      if (method === "Tracing.start") this.tracing = true;
      if (method === "Tracing.end") this.tracing = false;
      if (Object.hasOwn(DISABLE_OF, method) && !this.enabled.includes(method)) this.enabled.push(method);
      if (method === "Debugger.setBreakpointByUrl" && typeof reply.breakpointId === "string") this.breakpoints.add(reply.breakpointId);
      if (method === "Debugger.removeBreakpoint" && typeof params.breakpointId === "string") this.breakpoints.delete(params.breakpointId);
      return reply;
    });
    this.inFlight.add(work);
    const settled = () => void this.inFlight.delete(work);
    work.then(settled, settled);
    return work;
  }

  on(listener: CdpEventListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  waitFor(method: string, timeoutMs: number, matches: (params: CdpParams) => boolean = () => true): Promise<CdpParams | null> {
    return new Promise((resolve) => {
      const finish = (value: CdpParams | null) => {
        clearTimeout(timer);
        stop();
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      const stop = this.on((name, params) => {
        if (name === method && matches(params)) finish(params);
      });
      void this.ended.then(() => finish(null));
    });
  }

  async pause(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slept = new Promise<"slept">((resolve) => (timer = setTimeout(() => resolve("slept"), ms)));
    const outcome = await Promise.race([slept, this.ended.then(() => "ended" as const)]);
    clearTimeout(timer);
    if (outcome === "ended") throw new OpError("failed", SESSION_ENDED);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.markEnded();
    this.closing = this.shutDown();
    return this.closing;
  }

  private async shutDown() {
    await Promise.allSettled([...this.inFlight]);
    const quietly = (method: string, params: CdpParams = {}) => this.transport.send(method, params).catch(() => ({}));
    if (this.tracing) await quietly("Tracing.end");
    for (const breakpointId of this.breakpoints) await quietly("Debugger.removeBreakpoint", { breakpointId });
    for (const enable of [...this.enabled].reverse()) await quietly(DISABLE_OF[enable]!);
    this.tracing = false;
    this.breakpoints.clear();
    this.enabled = [];
    this.listeners.clear();
    this.unsubscribe();
    const own = byConnection.get(this.connection);
    own?.delete(this);
    if (own && !own.size) byConnection.delete(this.connection);
    await this.transport.close().catch(() => {});
  }
}

const epochOf = (connection: number) => connectionEpochs.get(connection) ?? 0;

export async function openInspection(tabId: string, connection: number): Promise<InspectionSession> {
  if (!opener) throw new OpError("failed", UNAVAILABLE);
  const startedIn = epochOf(connection);
  const controlStartedIn = controlEpoch;
  const transport = await opener(tabId);
  if (epochOf(connection) !== startedIn || controlEpoch !== controlStartedIn) {
    await transport.close().catch(() => {});
    throw new OpError("failed", STOPPED);
  }
  return new InspectionSession(tabId, connection, transport);
}

export async function withInspection<T>(tabId: string, connection: number, work: (session: InspectionSession) => Promise<T>): Promise<T> {
  const session = await openInspection(tabId, connection);
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

export async function closeInspectionsFor(connection: number) {
  connectionEpochs.set(connection, epochOf(connection) + 1);
  await Promise.all([...(byConnection.get(connection) ?? [])].map((session) => session.close()));
}

export async function closeAllInspections() {
  controlEpoch++;
  await Promise.all([...byConnection.values()].flatMap((set) => [...set]).map((session) => session.close()));
}
