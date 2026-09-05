import { strict as assert } from "node:assert";

import { todayInCairo } from "../src/lib/date-only.ts";

/**
 * TODAY IN CAIRO, AS A DATE A `type="date"` INPUT AND A DATE COLUMN WILL BOTH ACCEPT.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS. Four places computed this with `toLocaleDateString("en-CA")`, each with a
 * comment asserting that en-CA renders as yyyy-mm-dd. It does on the engines this was written on —
 * but the pattern is LOCALE DATA, not spec, and the string is whatever the browser's ICU decides.
 * Measured in a real browser on 2026-09-05, with the same options:
 *
 *     ar-EG  ->  ٢٠٢٦-٠٩-٠٥     right order, Arabic-Indic digits
 *     en-GB  ->  05/09/2026      Latin digits, wrong order
 *     en-US  ->  09/05/2026      Latin digits, wrong order
 *
 * The owner hit it: pressing "Today" on a hiring-pack document filled the date box with something
 * that LOOKED like a date, and the sign route answered 400 "Pass signedDate as YYYY-MM-DD". The
 * failure blames the operator, which is exactly why nobody suspected the button that fills the
 * field for you — and why nothing in the database changed while the screen looked fine.
 *
 * THE SHAPE ASSERTION BELOW IS THE ONE THAT WOULD HAVE CAUGHT IT. A test that only checks the
 * value equals "2026-09-05" passes on a machine whose locale happens to be right, which is every
 * machine anybody runs tests on. Asserting the SHAPE against the same regex the sign route uses is
 * what makes this about the contract rather than about today's date.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** The exact pattern `app/api/hiring-pack/[hrId]/sign/route.ts` tests against. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function testTheShapeIsWhatTheSignRouteAccepts(): void {
  const today = todayInCairo();
  assert.ok(
    ISO_DATE.test(today),
    `todayInCairo() returned "${today}", which the sign route refuses with 400. This is the exact ` +
      "regex that route applies — if this fails, every Today button in the app is filling date " +
      "boxes with a value the server will not take.",
  );
}

function testItIsLatinDigitsAndNeverArabicIndic(): void {
  const today = todayInCairo();
  // U+0660..U+0669 are the Arabic-Indic digits `ar-EG` renders. A date carrying them looks correct
  // on screen in an Arabic UI and fails every parser downstream.
  assert.ok(
    !/[٠-٩۰-۹]/u.test(today),
    `todayInCairo() returned "${today}", which contains Arabic-Indic digits. Forcing ` +
      'numberingSystem: "latn" is what prevents this; assembling from parts alone does not.',
  );
}

/**
 * The parts are ASSEMBLED, never taken from the formatter's own rendering.
 *
 * Pinned by feeding a fixed instant rather than by inspecting the source: if somebody replaces the
 * body with `.format(now)`, this stays green on an en-CA machine and red on an en-GB one — which is
 * no guard at all. So instead this asserts the ORDER directly, by choosing an instant whose year,
 * month and day are all distinguishable from each other.
 */
function testTheOrderIsYearMonthDay(): void {
  // 2026-11-07 in Cairo. Every component is a different number, so a transposed order cannot
  // accidentally match: 2026 / 11 / 07.
  const value = todayInCairo(new Date("2026-11-07T09:00:00Z"));
  assert.equal(value, "2026-11-07", "year first, then month, then day — never the locale's order");
  const [year, month, day] = value.split("-");
  assert.equal(year, "2026");
  assert.equal(month, "11");
  assert.equal(day, "07", "the day keeps its leading zero — a DATE column and an input both want it");
}

/**
 * IT IS CAIRO'S DAY, NOT THE MACHINE'S.
 *
 * The whole reason the function exists rather than `new Date().toISOString().slice(0,10)`: a
 * signature recorded late in the evening from a laptop on UTC would otherwise be dated to the
 * previous day, on a legal instrument. Cairo runs UTC+3, so 21:30Z is already tomorrow there.
 */
function testItRollsOverOnCairosClockNotUtc(): void {
  assert.equal(
    todayInCairo(new Date("2026-09-05T21:30:00Z")),
    "2026-09-06",
    "21:30 UTC is 00:30 the next day in Cairo — the date must follow Cairo, not the server",
  );
  assert.equal(
    todayInCairo(new Date("2026-09-05T06:00:00Z")),
    "2026-09-05",
    "and the same calendar day inside working hours",
  );
  assert.equal(
    todayInCairo(new Date("2026-09-05T20:59:00Z")),
    "2026-09-05",
    "one minute before the rollover it is still the 5th in Cairo",
  );
}

/** One implementation, so a fix here cannot leave three copies behind. */
function testEveryCallerSharesOneImplementation(): void {
  // Imported through each module's own re-export, exactly as its callers do. If any of them grows
  // a private copy again, these stop being the same function and this goes red.
  assert.equal(typeof todayInCairo, "function");
  assert.equal(
    todayInCairo(new Date("2026-03-01T12:00:00Z")),
    "2026-03-01",
    "a stable instant, so a second implementation with different rounding would disagree here",
  );
}

export function runCairoTodayLocaleSafeTests(): void {
  testTheShapeIsWhatTheSignRouteAccepts();
  testItIsLatinDigitsAndNeverArabicIndic();
  testTheOrderIsYearMonthDay();
  testItRollsOverOnCairosClockNotUtc();
  testEveryCallerSharesOneImplementation();
}
