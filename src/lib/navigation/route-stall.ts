/**
 * A page navigation that never arrived, and the one thing a rep can do about it.
 *
 * 🔴 WHAT THIS IS FOR. Tapping a link in Phoenix CRM makes the router fetch the next page's
 * payload. When the rep's connection dies mid-fetch the browser rejects it with a bare TypeError —
 * `Load failed` on iOS, `network error` on Android — and the router does nothing at all: no error
 * boundary is entered, because nothing rendered; no screen state changed, because the page never
 * started. Measured on production 23 Oct 2026: of 1,161 such rows in 14 days, most carried no
 * caller context at all, i.e. they were these — a tap that visibly did nothing, 905 of them with
 * the tab in the foreground.
 *
 * The progress bar made it worse by being honest: `RouteTransitionProvider` showed it, waited out
 * its deadline, and then just took it away again. The rep was left looking at the page he had
 * already left, with nothing said and nothing to press.
 *
 * The retry is deliberately a FULL DOCUMENT LOAD, not another `router.push`. The router's own
 * fetch for that href is what failed, its cache may now hold that rejection, and the client build
 * may be older than the server's — a document load is the only retry that is not asking the broken
 * thing to fix itself. See `browser-navigation.ts` for why that primitive is named rather than
 * re-argued at each call site.
 */

/**
 * How long a navigation may take before it is called dead, in milliseconds.
 *
 * It is the SAME deadline the progress bar already used, exported so the bar and the notice cannot
 * drift apart: the moment the bar gives up is exactly the moment there is something to say. A
 * navigation slower than this is not harmed — the notice clears itself the instant the page
 * arrives, so a late arrival corrects it without the rep doing anything.
 */
export const ROUTE_STALL_DEADLINE_MS = 9_000;

export type RouteStallRetry = { href: string; kind: "navigate" } | { kind: "reload" };

/**
 * What Try again should do. A navigation Phoenix started knows where it was going, so it goes
 * there; a back/forward the browser started does not, and reloading what is on screen is the
 * honest recovery rather than guessing at history.
 */
export function routeStallRetry(wantedHref: string | null): RouteStallRetry {
  const href = wantedHref?.trim();
  if (!href) return { kind: "reload" };
  return { href, kind: "navigate" };
}

/**
 * The sentence the rep reads. It says what happened and whose fault it is not — never "an error
 * occurred", and never the browser's own `Load failed`, which names nothing he can act on.
 */
export const ROUTE_STALL_MESSAGE = "This page did not open — the connection dropped on the way.";
export const ROUTE_STALL_RETRY_LABEL = "Try again";
export const ROUTE_STALL_DISMISS_LABEL = "Dismiss";
