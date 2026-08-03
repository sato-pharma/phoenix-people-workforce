import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { collectOneConnectorForMonth, isCollectableMonth } from "../src/lib/deductions/collect.ts";

/**
 * Collecting a month that has not finished charged real people three times in a
 * single day (2026-08-03): 72 candidates for 1-3 August at 39,225.73 EGP, 69 of
 * them CRM — which publishes with no approval step — plus 28 more from two
 * earlier accidental runs. Every one was withdrawn, but only because somebody
 * noticed. This is the guard that makes it impossible.
 */
export async function runDeductionsCurrentMonthGuardTests(): Promise<void> {
  const now = new Date();
  // The guard reads Cairo, so derive the expectation the same way rather than
  // from the machine's local clock.
  const cairo = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit" })
    .format(now)
    .split("-")
    .map(Number);
  const [thisYear, thisMonth] = cairo as [number, number];

  // ── The current month is never collectable ───────────────────────────────
  {
    assert.equal(
      isCollectableMonth({ month: thisMonth, year: thisYear }),
      false,
      "the CURRENT Cairo month must never be collectable — its days have not finished",
    );
  }

  // ── Neither is any future month ──────────────────────────────────────────
  {
    const next = thisMonth === 12 ? { month: 1, year: thisYear + 1 } : { month: thisMonth + 1, year: thisYear };
    assert.equal(isCollectableMonth(next), false, "a future month has nothing to detect and must be refused");
    assert.equal(
      isCollectableMonth({ month: thisMonth, year: thisYear + 1 }),
      false,
      "a future YEAR must be refused even when the month number is smaller",
    );
  }

  // ── A completed month still collects ─────────────────────────────────────
  // The guard must not break the normal case; every real collection targets a
  // month that has ended.
  {
    const prior = thisMonth === 1 ? { month: 12, year: thisYear - 1 } : { month: thisMonth - 1, year: thisYear };
    assert.equal(isCollectableMonth(prior), true, "last month must remain collectable");
    assert.equal(
      isCollectableMonth({ month: 12, year: thisYear - 1 }),
      true,
      "a month in a prior year must remain collectable",
    );
  }

  // ── The entry point REFUSES, loudly, before touching source data ─────────
  // Every connector goes through collectOneConnectorForMonth, including the
  // admin UI's per-connector stepping, so one check covers all of them.
  {
    await assert.rejects(
      () => collectOneConnectorForMonth({ connector: "crm", month: thisMonth, year: thisYear, createdBy: "test" }),
      /has not finished/,
      "collecting the current month must THROW — returning created:0 reads as 'nobody qualified' and hides the refusal",
    );
  }

  // ── Wired at the entry point, and Cairo-based ────────────────────────────
  {
    const source = readFileSync("src/lib/deductions/collect.ts", "utf8");
    assert.match(
      source,
      /currentCairoDateParts/,
      "the boundary must be CAIRO — in the first hours of a Cairo month a UTC clock still reads the previous month, waving through the exact window this guards",
    );
    assert.match(
      source,
      /if \(!isCollectableMonth\(input\)\)/,
      "the check must sit in collectOneConnectorForMonth, the single door every connector passes through",
    );
  }
}
