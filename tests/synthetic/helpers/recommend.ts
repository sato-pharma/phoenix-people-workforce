/**
 * The "what to do next" sentence a failed journey carries onto the Synthetic Journeys page.
 *
 * WHY THIS HAS ITS OWN FILE. Until 14 November 2026 the sentence was chosen inside run-journey.ts by
 * one test: does the error contain the word "timeout"? Every Playwright assertion prints the line
 * "Timeout: 10000ms" — it is how long the assertion waited, not what went wrong — so EVERY failed
 * assertion was reported as "The page did not respond in time". The Reps Weekly Plans check then
 * failed at 31 runs in a row over five days on a page that had answered in full and shown double the
 * expected count, and each time the page told the reader to go and see whether the server was running.
 *
 * It is a pure function with no imports so `tests/synthetic-journey-advice.test.ts` can hold it to
 * the real messages production has recorded, without a browser.
 *
 * THE ORDER IS THE RULE. The first reading that fits wins, most specific cause first:
 *   1. the page never opened            — nothing after it can be trusted
 *   2. the app itself refused a request — that is usually why the screen is wrong
 *   3. the screen is not what the check expects — and HOW it differs
 *   4. whatever the browser logged
 */

export const ADVICE_PAGE_DID_NOT_OPEN =
  "The page did not open in time. Either the site was slow or down when this ran, or this page takes too long to load. Check that SYNTHETIC_BASE_URL is reachable and the target server is running.";

export const ADVICE_CHECK_RAN_OUT_OF_TIME =
  "This check ran out of time before it finished, and the error does not say at which step. The page was slow somewhere along the way. Open the failure screenshot and the trace to see where it stopped.";

export const ADVICE_UNAUTHORIZED =
  "A request was rejected as unauthorized/forbidden. Check SYNTHETIC_ADMIN_HR_ID/SYNTHETIC_ADMIN_PASSWORD and that the account has Super Admin access.";

export const ADVICE_NOT_FOUND_404 =
  "A request returned 404. The route or an API it depends on may have moved or been removed.";

export const ADVICE_API_CALLS_FAILED =
  "One or more API calls failed. Review the network errors listed for this journey and the server logs.";

export const ADVICE_MORE_THAN_ONE =
  "The page opened, but this check found more than one of something it expects exactly one of. The screen most likely gained a second copy, for example one layout for phones and one for desktops, so the check is out of date.";

export const ADVICE_NEVER_APPEARED =
  "The page opened, but something this check looks for never appeared on it. Either that part of the screen is broken or missing, or it was renamed or moved and the check is out of date.";

export const ADVICE_SHOWED_SOMETHING_ELSE =
  "The page opened, but it did not show what this check expects. Compare Expected and Received in the error. Either the screen is wrong, or it was changed on purpose and the check is out of date.";

export const ADVICE_CONTROL_NEVER_READY =
  "The page opened, but a control this check uses never became ready to press or fill. Either it is missing, disabled or covered, or it was renamed and the check is out of date.";

export const ADVICE_CONSOLE_ERROR =
  "The page logged a JavaScript error to the console. Inspect the console errors listed for this journey.";

export const ADVICE_DEFAULT = "Review the error message and the failure screenshot above.";

export interface AdviceInput {
  /** The thrown error's message, exactly as Playwright wrote it — colour codes and all. */
  message: string;
  consoleErrors: string[];
  /** As run-journey.ts records them: "403 GET <url>" for an answer, "GET <url> — <reason>" for a request that failed. */
  networkErrors: string[];
  /** SYNTHETIC_BASE_URL. When it is given, a request to any other host is not the app's failure. */
  baseUrl?: string;
}

/** Playwright colours its assertion errors for a terminal; the codes are noise to every test below. */
function withoutColourCodes(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The network errors that say something about the app.
 *
 * Two kinds are dropped, and the first was on every one of those mistaken reports:
 *  - `net::ERR_ABORTED` — the browser cancelling its own request because the journey moved to the
 *    next page. Next.js prefetches a dozen sidebar links on every admin page, so each navigation
 *    aborts a dozen requests. Nothing failed.
 *  - a request to another host — the error tracker answering 429 is that vendor's rate limit, not
 *    a broken screen.
 */
function ownFailures(networkErrors: string[], baseUrl: string | undefined): string[] {
  const ownHost = hostOf(baseUrl);
  return networkErrors.filter((entry) => {
    if (/net::ERR_ABORTED/i.test(entry)) return false;
    if (!ownHost) return true;
    const url = /https?:\/\/\S+/i.exec(entry)?.[0];
    const host = hostOf(url);
    return host === null || host === ownHost;
  });
}

/** The status an answered request came back with — the entry's leading three digits — or null. */
function statusOf(entry: string): number | null {
  const match = /^(\d{3})\s/.exec(entry);
  return match ? Number(match[1]) : null;
}

export function recommendNextStep({ message, consoleErrors, networkErrors, baseUrl }: AdviceInput): string {
  const text = withoutColourCodes(message);

  // 1. The page never opened. A navigation that timed out, or a connection the browser could not make.
  if (/\bpage\.(goto|reload|goBack|goForward|waitForURL|waitForLoadState):/i.test(text) || /net::ERR_(?!ABORTED)/i.test(text)) {
    return ADVICE_PAGE_DID_NOT_OPEN;
  }

  // 2. The app refused or failed a request of its own.
  const failures = ownFailures(networkErrors, baseUrl);
  const statuses = failures.map(statusOf);
  if (statuses.some((status) => status === 401 || status === 403)) return ADVICE_UNAUTHORIZED;
  if (statuses.some((status) => status === 404)) return ADVICE_NOT_FOUND_404;
  if (failures.length > 0) return ADVICE_API_CALLS_FAILED;

  // 3. The page opened and the check disagreed with it. "Timeout: 10000ms" appears on every one of
  //    these and means only how long the assertion kept looking.
  if (/strict mode violation/i.test(text)) return ADVICE_MORE_THAN_ONE;
  const isAssertion = /\bexpect\(/.test(text) || /^\s*Expected:/m.test(text);
  const neverAppeared = /element\(s\) not found/i.test(text) || /waiting for .+ to be (visible|attached)/i.test(text);
  if (neverAppeared) return ADVICE_NEVER_APPEARED;
  if (isAssertion) return ADVICE_SHOWED_SOMETHING_ELSE;
  if (/\b(locator|page|frame)\.\w+: Timeout \d+ms exceeded/i.test(text)) return ADVICE_CONTROL_NEVER_READY;
  if (/Test timeout of \d+ms exceeded/i.test(text)) return ADVICE_CHECK_RAN_OUT_OF_TIME;

  // 4. Whatever the browser logged.
  if (consoleErrors.length > 0) return ADVICE_CONSOLE_ERROR;
  return ADVICE_DEFAULT;
}
