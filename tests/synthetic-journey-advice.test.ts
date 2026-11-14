import assert from "node:assert/strict";

import {
  ADVICE_API_CALLS_FAILED,
  ADVICE_CHECK_RAN_OUT_OF_TIME,
  ADVICE_CONSOLE_ERROR,
  ADVICE_CONTROL_NEVER_READY,
  ADVICE_DEFAULT,
  ADVICE_MORE_THAN_ONE,
  ADVICE_NEVER_APPEARED,
  ADVICE_NOT_FOUND_404,
  ADVICE_PAGE_DID_NOT_OPEN,
  ADVICE_SHOWED_SOMETHING_ELSE,
  ADVICE_UNAUTHORIZED,
  recommendNextStep,
} from "./synthetic/helpers/recommend.ts";

/**
 * The sentence a failed smoke check carries onto the Synthetic Journeys page.
 *
 * Every message below is one production recorded in `synthetic_journey_results.failure_reason`
 * between September and November 2026, copied as Playwright wrote it. They are the real shapes, so
 * a new Playwright wording that slips past the reader shows up as a new case here, not as a guess.
 */

const BASE = "https://phoenix-hr.satopharma.com";

/** 14 November 2026, 02:39 Cairo — the page answered in full and showed two links where one was expected. */
const COUNT_MISMATCH =
  "?status=awaiting must show the 1 rep(s) its own option counted\n\n" +
  "\u001b[2mexpect(\u001b[22m\u001b[31mlocator\u001b[39m\u001b[2m).\u001b[22mtoHaveCount\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m)\u001b[22m failed\n\n" +
  "Locator:  locator('a[href*=\"&rep=\"]')\n" +
  "Expected: \u001b[32m1\u001b[39m\n" +
  "Received: \u001b[31m2\u001b[39m\n" +
  "Timeout:  10000ms\n\n" +
  "Call log:\n" +
  "\u001b[2m  - waiting for locator('a[href*=\"&rep=\"]')\u001b[22m\n" +
  "\u001b[2m    24 × locator resolved to 2 elements\u001b[22m\n";

/** What that same run recorded beside it: prefetches the browser cancelled, and the error tracker's rate limit. */
const ROUTINE_NOISE = [
  `GET ${BASE}/admin/access?_rsc=glHVoxLeNX9F91H4 — net::ERR_ABORTED`,
  `GET ${BASE}/admin/direct-orders/returned?_rsc=glHVoxLeNX9F91H4 — net::ERR_ABORTED`,
  "429 POST https://o4512264026914816.ingest.de.sentry.io/api/4512264037662800/envelope/?sentry_version=7",
];
const ROUTINE_CONSOLE = ["Failed to load resource: the server responded with a status of 429 ()"];

const HEADING_NEVER_APPEARED =
  "expect(locator).toBeVisible() failed\n\n" +
  "Locator: getByRole('heading', { name: /Visits & Coverage/i, level: 2 })\n" +
  "Expected: visible\n" +
  "Timeout: 10000ms\n" +
  "Error: element(s) not found\n\n" +
  "Call log:\n" +
  "  - Expect \"toBeVisible\" getByRole('heading', { name: /Visits & Coverage/i, level: 2 })\n";

/** The wording an older Playwright used for the same thing, still quoted in tests/synthetic/README.md. */
const HEADING_NEVER_APPEARED_OLD_WORDING =
  "Timeout 10000ms exceeded waiting for locator('heading[level=1]:has-text(\"Vacation Control\")') to be visible";

const TWO_WHERE_ONE_EXPECTED =
  "expect(locator).toBeVisible() failed\n\n" +
  "Locator: getByPlaceholder(/by name, HR ID, line, area or manager/i)\n" +
  "Expected: visible\n" +
  "Error: strict mode violation: getByPlaceholder(/by name, HR ID, line, area or manager/i) resolved to 2 elements:\n" +
  '    1) <input value="" type="search"/>\n';

const NAVIGATION_TIMED_OUT =
  `page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "${BASE}/employees", waiting until "load"\n`;

const NAVIGATION_HIT_THE_TEST_LIMIT =
  `page.goto: Test timeout of 60000ms exceeded.\nCall log:\n  - navigating to "${BASE}/admin/reps-list?tab=plans&status=missing", waiting until "load"\n`;

const CONNECTION_REFUSED = `page.goto: net::ERR_CONNECTION_REFUSED at ${BASE}/admin`;

const WHOLE_CHECK_TIMED_OUT = "Test timeout of 60000ms exceeded.";

const BUTTON_NEVER_READY =
  "TimeoutError: locator.click: Timeout 15000ms exceeded.\nCall log:\n" +
  "  - waiting for getByRole('button', { name: /^Sign in$/i })\n" +
  '    - locator resolved to <button type="submit" disabled>Sign in</button>\n';

function advise(message: string, networkErrors: string[] = [], consoleErrors: string[] = []): string {
  return recommendNextStep({ baseUrl: BASE, consoleErrors, message, networkErrors });
}

export function runSyntheticJourneyAdviceTests() {
  // ── The defect. 31 runs in a row told the reader to check whether the server was running, about a
  //    page that had answered in full. "Timeout: 10000ms" is on every assertion Playwright prints.
  const mismatch = advise(COUNT_MISMATCH, ROUTINE_NOISE, ROUTINE_CONSOLE);
  assert.notEqual(
    mismatch,
    ADVICE_PAGE_DID_NOT_OPEN,
    "an assertion that found the wrong count is not a page that did not respond — the word Timeout in it is only how long the assertion waited",
  );
  assert.equal(
    mismatch,
    ADVICE_SHOWED_SOMETHING_ELSE,
    "Expected 1, Received 2 means the page opened and showed something else, and the advice must say so",
  );

  // ── The routine noise beside it must not take the sentence over. A cancelled prefetch and another
  //    company's rate limit are on almost every admin page's record.
  assert.notEqual(
    mismatch,
    ADVICE_API_CALLS_FAILED,
    "a prefetch the browser cancelled on navigation and a 429 from the error tracker's host are not the app failing a call",
  );
  assert.notEqual(
    advise(COUNT_MISMATCH, [], ROUTINE_CONSOLE),
    ADVICE_CONSOLE_ERROR,
    "a known assertion failure is named as one, whatever the console also logged",
  );

  // ── The page opened, and the check disagreed with it in a different way each time.
  assert.equal(
    advise(HEADING_NEVER_APPEARED),
    ADVICE_NEVER_APPEARED,
    "'element(s) not found' is something missing from a page that did open",
  );
  assert.equal(
    advise(HEADING_NEVER_APPEARED_OLD_WORDING),
    ADVICE_NEVER_APPEARED,
    "the older 'waiting for locator(…) to be visible' wording is the same missing element",
  );
  assert.equal(
    advise(TWO_WHERE_ONE_EXPECTED),
    ADVICE_MORE_THAN_ONE,
    "a strict mode violation is two of something the check expects one of — the phone-and-desktop pair, most often",
  );
  assert.equal(
    advise(BUTTON_NEVER_READY),
    ADVICE_CONTROL_NEVER_READY,
    "a click that timed out on a control the page did render is that control never becoming ready",
  );

  // ── The page really did not open. This is the one case the old sentence was right about.
  assert.equal(advise(NAVIGATION_TIMED_OUT), ADVICE_PAGE_DID_NOT_OPEN, "page.goto timing out is the page not opening");
  assert.equal(
    advise(NAVIGATION_HIT_THE_TEST_LIMIT),
    ADVICE_PAGE_DID_NOT_OPEN,
    "page.goto stopped by the test's own time limit is still the page not opening",
  );
  assert.equal(advise(CONNECTION_REFUSED), ADVICE_PAGE_DID_NOT_OPEN, "a refused connection is the page not opening");
  assert.equal(
    advise(NAVIGATION_TIMED_OUT, [`403 GET ${BASE}/api/session`]),
    ADVICE_PAGE_DID_NOT_OPEN,
    "nothing recorded on a page that never opened outranks the fact that it never opened",
  );
  assert.equal(
    advise(WHOLE_CHECK_TIMED_OUT),
    ADVICE_CHECK_RAN_OUT_OF_TIME,
    "a bare test timeout names no step, and the advice must not pretend it was the navigation",
  );

  // ── The app's own refusals. The old test for these looked for a space BEFORE the status, and every
  //    entry starts with it, so none of the three sentences below could ever be chosen.
  assert.equal(
    advise(HEADING_NEVER_APPEARED, [`403 GET ${BASE}/api/employees`]),
    ADVICE_UNAUTHORIZED,
    "a 403 from the app is why the heading is missing, and is named first",
  );
  assert.equal(advise(HEADING_NEVER_APPEARED, [`401 POST ${BASE}/api/session`]), ADVICE_UNAUTHORIZED, "a 401 likewise");
  assert.equal(
    advise(HEADING_NEVER_APPEARED, [`404 GET ${BASE}/api/gone`]),
    ADVICE_NOT_FOUND_404,
    "a 404 from the app is named as a moved or removed route",
  );
  assert.equal(
    advise(COUNT_MISMATCH, [`500 GET ${BASE}/api/reps-list`]),
    ADVICE_API_CALLS_FAILED,
    "a 500 from the app outranks the wrong count it most likely caused",
  );
  assert.equal(
    advise(COUNT_MISMATCH, [`GET ${BASE}/api/reps-list — net::ERR_CONNECTION_RESET`]),
    ADVICE_API_CALLS_FAILED,
    "a request to the app that failed outright — not one the browser cancelled — is a failed call",
  );
  assert.equal(
    advise(HEADING_NEVER_APPEARED, ["403 GET https://fonts.example.com/font.woff2"]),
    ADVICE_NEVER_APPEARED,
    "a refusal from another host says nothing about this account's access",
  );
  assert.equal(
    recommendNextStep({ consoleErrors: [], message: HEADING_NEVER_APPEARED, networkErrors: ["403 GET https://elsewhere.example.com/x"] }),
    ADVICE_UNAUTHORIZED,
    "with no base URL to compare against, every host counts — failing towards the louder sentence",
  );

  // ── Nothing recognised: the two sentences that were always the fallback.
  assert.equal(advise("Something nobody has seen before", [], ["Uncaught TypeError: x is not a function"]), ADVICE_CONSOLE_ERROR);
  assert.equal(advise("Something nobody has seen before"), ADVICE_DEFAULT);

  // ── What the page prints is read by a person. No sentence may end mid-thought or trail off.
  for (const sentence of [
    ADVICE_API_CALLS_FAILED,
    ADVICE_CHECK_RAN_OUT_OF_TIME,
    ADVICE_CONSOLE_ERROR,
    ADVICE_CONTROL_NEVER_READY,
    ADVICE_DEFAULT,
    ADVICE_MORE_THAN_ONE,
    ADVICE_NEVER_APPEARED,
    ADVICE_NOT_FOUND_404,
    ADVICE_PAGE_DID_NOT_OPEN,
    ADVICE_SHOWED_SOMETHING_ELSE,
    ADVICE_UNAUTHORIZED,
  ]) {
    assert.ok(sentence.endsWith("."), `advice must be whole sentences: ${sentence}`);
    assert.ok(!sentence.includes("…") && !sentence.includes("..."), `advice never trails off with an ellipsis: ${sentence}`);
  }
}
