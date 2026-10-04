import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripComments } from "./support/comment-strip.ts";

import { periodMonthEnd } from "../src/lib/business-review/period-format.ts";

/**
 * Business Review — a window's upper bound is the month's REAL last day.
 *
 * WHAT WENT WRONG (production, September 2026). The coaching read asked `coaching_reports` for
 * `coaching_date <= "2026-09-31"`. Postgres answers that with 22008 ("date/time field value out of
 * range"), the loader swallowed the failure as "no data", and every window ending in September
 * showed ZERO coaching reports while production held five. The same happens for any window ending
 * in a 30-day month or in February. The Postgres log carried 24 of those failures. A zero on this
 * page reads as "this coach did nothing", which is the accusation the review's coverage rules
 * exist to prevent.
 *
 * COACHING ITSELF LEFT THIS MODULE on 2026-09-26 (owner: "remove the coaching from this module"),
 * so the assertion naming that one read is gone with it. The DEFECT CLASS is not gone: marketing,
 * outstation and the visits read all bound a date the same way, all three share `periodMonthEnd`,
 * and the directory-wide sweep below is what keeps a hardcoded day from coming back in any of them.
 */

const SOURCES_DIR = fileURLToPath(new URL("../src/lib/business-review/sources/", import.meta.url));
const source = (name: string) => readFileSync(`${SOURCES_DIR}${name}`, "utf8");
export function runBusinessReviewMonthEndTests() {
  // The helper answers the calendar's last day, including both kinds of February.
  assert.equal(periodMonthEnd("2026-09"), "2026-09-30", "September has 30 days");
  assert.equal(periodMonthEnd("2026-11"), "2026-11-30", "November has 30 days");
  assert.equal(periodMonthEnd("2026-02"), "2026-02-28", "February 2026 is not a leap month");
  assert.equal(periodMonthEnd("2028-02"), "2028-02-29", "February 2028 is a leap month");
  assert.equal(periodMonthEnd("2026-07"), "2026-07-31", "July has 31 days");
  assert.equal(periodMonthEnd("2026-12"), "2026-12-31", "December rolls into the next year correctly");

  // Coaching is no longer read by this module at all — owner ruling, 2026-09-26. Pinned so it
  // cannot drift back in through a source file rather than through a decision.
  // Comments STRIPPED before measuring, or this file's own prose about the removal fails it — the
  // exact mistake the no-ellipsis ratchet lost a CI round to (#2571).
  for (const name of readdirSync(SOURCES_DIR).filter((f) => f.endsWith(".ts"))) {
    assert.doesNotMatch(
      stripComments(source(name)),
      /coaching_reports/,
      `${name} reads coaching_reports — the owner removed coaching from the Business Review on 2026-09-26`,
    );
  }

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
