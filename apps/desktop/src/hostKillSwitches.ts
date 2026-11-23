import { hostSupports, invokeHost, type ArdiaHost } from "./host.ts";

const KILL_SWITCHES_METHOD = "ArdiaShell.fetchKillSwitches";
const KILL_SWITCHES_URL = "https://ardia.dev/switches.json";

type Fetched = { status: number; body: string };

export const killSwitchesAvailable = (host: ArdiaHost) => hostSupports(KILL_SWITCHES_METHOD, host);

export function hostSwitchesFetch(host: ArdiaHost, original: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== KILL_SWITCHES_URL) return original(input, init);
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const fetched = await invokeHost<Fetched>(KILL_SWITCHES_METHOD, { args: [] }, host);
    if (!fetched || !fetched.status || typeof fetched.body !== "string") throw new TypeError("Failed to fetch");
    return new Response(fetched.body, { status: fetched.status });
  };
}
