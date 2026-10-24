import { CROSS_ORIGIN_MASKED_DISPLAY } from "@/lib/error-monitor/cross-origin-masked";

/**
 * Browser reports that say nothing about Phoenix, for the Sentry stream only.
 *
 * Every browser throws a fixed, engine-specific message when a page's own `fetch` is cut off: the person walked
 * into a lift, the phone changed network, the tab was put to sleep. Safari says "Load failed", Chrome "Failed to
 * fetch" and, for a streamed page, "Error in input stream", Firefox "NetworkError when attempting to fetch
 * resource.". They carry no stack of ours and no cause, and on 2026-10-17 they were five of the fourteen open
 * Sentry issues (0 users each). The other is the browser's own placeholder for a script it injected
 * (cross-origin-masked.ts) — never app code.
 *
 * The match is EXACT. "Connection closed." is deliberately NOT here: the repo has seen it as a real Supabase
 * failure, and a filter that hides a genuine fault is worse than the noise it removes (benign-disconnect.ts).
 * Only the SENTRY copy is skipped. The system error table still records them, but a BURST of bare ones (no stack
 * frame at all) is one row with its count since 24 Oct 2026 — network-failure-burst.ts.
 */
const BROWSER_NETWORK_FAILURE_MESSAGES = new Set([
  "Load failed",
  "Failed to fetch",
  "Error in input stream",
  "network error",
  "NetworkError when attempting to fetch resource.",
]);

/** One of the engines' own words for a cut-off `fetch` — the network half of the noise, without the cross-origin placeholder. */
export function isBrowserNetworkFailureMessage(message: string | null | undefined): boolean {
  return BROWSER_NETWORK_FAILURE_MESSAGES.has(String(message ?? "").trim());
}

export function isBrowserNoiseMessage(message: string | null | undefined): boolean {
  const text = String(message ?? "").trim();
  return text === CROSS_ORIGIN_MASKED_DISPLAY || isBrowserNetworkFailureMessage(text);
}
