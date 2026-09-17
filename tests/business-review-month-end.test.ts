import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { periodMonthEnd } from "../src/lib/business-review/period-format.ts";

/**
 * Business Review — a window's upper bound is the month's REAL last day.
 *
 * WHAT WENT WRONG (production, September 2026). The coaching read asked `coaching_reports` for
 * `coaching_date <= "2026-09-31"`. Postgres answers that with 22008 ("date/time field value out of
 * range"), `loadCoachingFacts` swallows the failure as "no data", and every window ending in
 * September showed ZERO coaching reports while production held five. The same happens for any
 * window ending in a 30-day month or in February. The Postgres log carried 24 of those failures. A
 * zero on this page reads as "this coach did nothing", which is the accusation the review's
 * coverage rules exist to prevent.
 *
 * The marketing and visits sources already computed the real last day, each with its own private
 * copy of the helper. All three now share `periodMonthEnd`, and this file pins both the helper and
 * the absence of a hardcoded day in any source's date bound.
 */

const SOURCES_DIR = fileURLToPath(new URL("../src/lib/business-review/sources/", import.meta.url));
const source = (name: string) => readFileSync(`${SOURCES_DIR}${name}`, "utf8");
/** Collapse runs of whitespace so a reformat or a line-wrap does not false-fail a source check. */
const flat = (s: string) => s.replace(/\s+/g, " ");

export function runBusinessReviewMonthEndTests() {
  // The helper answers the calendar's last day, including both kinds of February.
  assert.equal(periodMonthEnd("2026-09"), "2026-09-30", "September has 30 days");
  assert.equal(periodMonthEnd("2026-11"), "2026-11-30", "November has 30 days");
  assert.equal(periodMonthEnd("2026-02"), "2026-02-28", "February 2026 is not a leap month");
  assert.equal(periodMonthEnd("2028-02"), "2028-02-29", "February 2028 is a leap month");
  assert.equal(periodMonthEnd("2026-07"), "2026-07-31", "July has 31 days");
  assert.equal(periodMonthEnd("2026-12"), "2026-12-31", "December rolls into the next year correctly");

  // The coaching read is the one that failed: its upper bound must come from the helper.
  assert.ok(
    flat(source("roles.ts")).includes('.lte("coaching_date", periodMonthEnd(window.to))'),
    "loadCoachingFacts must bound coaching_date with periodMonthEnd(window.to), never a hardcoded day",
  );

  // No source may build a date bound with a hardcoded day 28-31 (`${window.to}-31` was the bug).
  const offenders = readdirSync(SOURCES_DIR)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => /\}-(2[89]|3[01])`/.test(source(name)));
  assert.deepEqual(
    offenders,
    [],
    `Business Review source(s) build a date bound with a hardcoded day: ${offenders.join(", ")} — use periodMonthEnd`,
  );
}
