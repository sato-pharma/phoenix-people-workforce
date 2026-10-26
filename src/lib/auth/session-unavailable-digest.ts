/**
 * The one fixed `digest` a "could not confirm your sign-in" render failure carries to the browser.
 *
 * Why it exists. When the database is restarting, `resolveSessionState` cannot read the session
 * bundle, has no recent copy to stand in (or may not use one), and throws
 * `SessionVerificationUnavailableError` from the page render. A production build strips a server
 * error's message before it reaches the browser, so the route's error boundary saw only React's
 * redacted "Minified React error #441" and drew the portal's crash card ("Employee portal
 * unavailable") — and reported it again on every retry. Measured 25 Oct 2026, 16:14–16:15 Cairo:
 * three Medical Representatives on Employee 360 and Field CRM hit it for one database restart, and
 * one of them filed 8 crash rows that all said only "#441".
 *
 * Next.js KEEPS a digest the thrown error already has (`createReactServerErrorHandler`: "If the
 * error already has a digest, respect the original digest") and React's client hands it to the
 * boundary as `error.digest`, so this string is the only part of the cause that survives the trip.
 * It names a condition, never a person or a secret. The server still records the real error through
 * `onRequestError`.
 *
 * ZERO IMPORTS, DELIBERATELY — read by the server error class and by client error boundaries alike.
 */
export const SESSION_VERIFICATION_UNAVAILABLE_DIGEST = "PHX_SESSION_VERIFICATION_UNAVAILABLE";

export function isSessionVerificationUnavailableDigest(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { digest?: unknown }).digest === SESSION_VERIFICATION_UNAVAILABLE_DIGEST;
}

/**
 * How long the route error card waits before each automatic retry of a page that threw this error.
 * A database restart here has lasted about a minute (25 Oct 2026). The last delay repeats until ten
 * minutes have passed; after that only the card's own button retries, so a long outage does not
 * keep re-rendering a page nobody is looking at. A run that has been quiet for two minutes starts
 * over.
 */
export const SESSION_CHECK_RETRY_DELAYS_MS = [3_000, 5_000, 10_000, 20_000, 30_000] as const;
export const SESSION_CHECK_RETRY_WINDOW_MS = 10 * 60_000;
const SESSION_CHECK_RUN_QUIET_RESET_MS = 2 * 60_000;

export type SessionCheckRetryRun = { attempts: number; lastAt: number; startedAt: number };

export function nextSessionCheckRetryDelay(
  run: SessionCheckRetryRun | null,
  now: number,
): { delayMs: number | null; run: SessionCheckRetryRun } {
  const current =
    run && now - run.lastAt < SESSION_CHECK_RUN_QUIET_RESET_MS ? run : { attempts: 0, lastAt: now, startedAt: now };
  if (now - current.startedAt >= SESSION_CHECK_RETRY_WINDOW_MS) return { delayMs: null, run: current };
  const delayMs = SESSION_CHECK_RETRY_DELAYS_MS[Math.min(current.attempts, SESSION_CHECK_RETRY_DELAYS_MS.length - 1)];
  return { delayMs, run: { ...current, attempts: current.attempts + 1, lastAt: now } };
}
