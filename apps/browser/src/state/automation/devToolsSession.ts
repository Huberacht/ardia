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
  "IO.read",
  "IO.close",
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

let opener: TransportOpener | null = null;
let openSessions = 0;

export const setInspectionTransport = (next: TransportOpener | null) => void (opener = next);
export const liveInspectionSessions = () => openSessions;

export class InspectionSession {
  readonly tabId: string;
  private transport: DevToolsTransport;
  private enabled: string[] = [];
  private breakpoints = new Set<string>();
  private tracing = false;
  private listeners = new Set<CdpEventListener>();
  private unsubscribe: () => void;
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(tabId: string, transport: DevToolsTransport) {
    this.tabId = tabId;
    this.transport = transport;
    openSessions++;
    this.unsubscribe = transport.onEvent((method, params) => {
      for (const listener of [...this.listeners]) listener(method, params);
    });
  }

  get isClosed() {
    return this.closed;
  }

  async send(method: string, params: CdpParams = {}): Promise<CdpParams> {
    if (this.closed) throw new OpError("failed", "The inspection session already ended.");
    if (!INSPECTION_METHODS.has(method)) throw new OpError("refused", `An inspection session never sends ${method}.`);
    const reply = await this.transport.send(method, params);
    if (method === "Tracing.start") this.tracing = true;
    if (Object.hasOwn(DISABLE_OF, method) && !this.enabled.includes(method)) this.enabled.push(method);
    if (method === "Tracing.end") this.tracing = false;
    if (method === "Debugger.setBreakpointByUrl" && typeof reply.breakpointId === "string") this.breakpoints.add(reply.breakpointId);
    if (method === "Debugger.removeBreakpoint" && typeof params.breakpointId === "string") this.breakpoints.delete(params.breakpointId);
    return reply;
  }

  on(listener: CdpEventListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  waitFor(method: string, timeoutMs: number, matches: (params: CdpParams) => boolean = () => true): Promise<CdpParams | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        stop();
        resolve(null);
      }, timeoutMs);
      const stop = this.on((name, params) => {
        if (name !== method || !matches(params)) return;
        clearTimeout(timer);
        stop();
        resolve(params);
      });
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.shutDown();
    return this.closing;
  }

  private async shutDown() {
    const quietly = (method: string, params: CdpParams = {}) => this.transport.send(method, params).catch(() => ({}));
    if (this.tracing) await quietly("Tracing.end");
    for (const breakpointId of this.breakpoints) await quietly("Debugger.removeBreakpoint", { breakpointId });
    for (const enable of [...this.enabled].reverse()) await quietly(DISABLE_OF[enable]!);
    this.closed = true;
    this.tracing = false;
    this.breakpoints.clear();
    this.enabled = [];
    this.listeners.clear();
    this.unsubscribe();
    openSessions--;
    await this.transport.close().catch(() => {});
  }
}

export async function openInspection(tabId: string): Promise<InspectionSession> {
  if (!opener) throw new OpError("failed", UNAVAILABLE);
  return new InspectionSession(tabId, await opener(tabId));
}

export async function withInspection<T>(tabId: string, work: (session: InspectionSession) => Promise<T>): Promise<T> {
  const session = await openInspection(tabId);
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}
