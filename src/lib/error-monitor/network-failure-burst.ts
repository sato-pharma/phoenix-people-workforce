import { isBrowserNetworkFailureMessage } from "@/lib/error-monitor/browser-noise";

/**
 * A burst of the browser's own "the connection dropped" rejections, recorded as ONE row with its count.
 *
 * 🔴 WHAT WAS MEASURED (production, 30 days to 24 Oct 2026). On the reps' Phoenix CRM pages the error table held
 * 459 `Load failed` rows on Visits and 289 on List, almost all iPhones, and the same on every portal page — 1,002
 * Safari rows across the portal, plus 245 `network error` and 88 `Error in input stream` from Android. They came in
 * BURSTS: up to 69 rows inside one second, a median 12-14 minutes after the page opened, never in its first
 * 10 seconds, the tab in the foreground. Each row carried no stack at all — no frame of Phoenix, nothing to read.
 *
 * That shape is the page framework's own streamed reads (the router's payloads for the links on screen) being cut
 * off when the phone's connection drops or the tab wakes from sleep: every piece still waiting on the stream rejects
 * at once with the engine's fixed wording, nobody awaits them, and each one reached `unhandledrejection` and became a
 * row of its own — with a screenshot ticket each. Phoenix's own reads already turn the same failure into a sentence
 * the rep can act on (`CrmRequestError("offline")` in components/phoenix-crm/api.ts, the route-stall notice in
 * src/lib/navigation/route-stall.ts), so these rows were the same dropped connection told twenty times.
 *
 * WHAT IS KEPT. A burst is still ONE row, carrying `networkBurst=<count>`: dropping it would hide a real change in how
 * often reps lose the connection, which is worth seeing. And only a BARE failure joins a burst — the exact engine
 * wording AND no stack frame. A rejection whose stack names a frame came from code that can be read, so it is reported
 * on its own exactly as before; so is every other message, "Connection closed." included (browser-noise.ts).
 */

/** A burst ends once nothing new has joined it for this long. */
export const NETWORK_BURST_QUIET_MS = 2_000;
/** And it is reported by this point regardless, so a page that keeps failing still says so. */
export const NETWORK_BURST_MAX_MS = 10_000;

/**
 * Does this stack name any frame? Chrome writes `    at fn (url:1:2)`, Safari and Firefox `fn@url:1:2`. The browsers'
 * network rejections carry none: WebKit's is empty, Chrome's is the single line `TypeError: network error`.
 */
export function stackHasFrame(stack: string | null | undefined): boolean {
  if (!stack) return false;
  return stack.split("\n").some((line) => /^\s*at\s/.test(line) || /@\S*:\d+/.test(line));
}

/** The browser saying a read was cut off, and nothing else: the exact engine wording, and no frame to read. */
export function isBareBrowserNetworkFailure(error: unknown): boolean {
  if (typeof error === "string") return isBrowserNetworkFailureMessage(error);
  if (!(error instanceof Error)) return false;
  return isBrowserNetworkFailureMessage(error.message) && !stackHasFrame(error.stack);
}

export function networkBurstContext(count: number): string {
  return `networkBurst=${count}`;
}

type Timers = {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type NetworkBurstCollector = {
  /** One more bare failure. The first opens a burst; the burst reports once, when it goes quiet. */
  add: (message: string) => void;
  /** Report an open burst now — the page is going away. */
  flush: () => void;
};

/**
 * Collects bare network failures into bursts and hands each burst to `report` exactly once, with the first message
 * and how many joined it. Timers are passed in so the test drives the clock.
 */
export function createNetworkBurstCollector(
  report: (burst: { message: string; count: number }) => void,
  timers: Timers,
): NetworkBurstCollector {
  let open: { message: string; count: number; startedAt: number; handle: unknown } | null = null;

  function flush() {
    if (!open) return;
    const burst = open;
    open = null;
    timers.clearTimeout(burst.handle);
    report({ count: burst.count, message: burst.message });
  }

  function schedule() {
    if (!open) return;
    timers.clearTimeout(open.handle);
    const left = NETWORK_BURST_MAX_MS - (timers.now() - open.startedAt);
    open.handle = timers.setTimeout(flush, Math.max(0, Math.min(NETWORK_BURST_QUIET_MS, left)));
  }

  function add(message: string) {
    if (open) open.count += 1;
    else open = { count: 1, handle: null, message: message.trim(), startedAt: timers.now() };
    schedule();
  }

  return { add, flush };
}
