import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyCoachingImportRows, parseCoachingDate } from "../src/lib/coaching/import.ts";
import { assertCoachingDateNotFuture } from "../src/lib/coaching/service.ts";

/**
 * A coaching report records a visit that already happened, so it can never be dated ahead of
 * today. Nothing enforced that before this test's fix, at any layer: the form's date input had
 * no `max`, service.ts only checked the string parsed, and there is no CHECK constraint.
 *
 * Two rows reached production through the worst path — the importer PUT them there. In the
 * 19 Jun 2026 historical import, parseCoachingDate's day/month "correction" fired on a stored
 * 2026-05-11 (both fields <= 12, so ambiguous) and swapped it to 2026-11-05, filing two real
 * 11 May coaching reports four months in the future (CR-2026-000196 Warda Farhat,
 * CR-2026-000197 Youssef Hesham). Because coaching_month / coaching_quarter / coaching_year are
 * GENERATED from coaching_date, both landed in Q4 2026 and polluted every period-scoped
 * analytic. The swap had no sanity check: nothing asked whether it had just invented a date
 * that has not happened yet.
 *
 * Every date here is passed an EXPLICIT `today` rather than reading the clock — a test that
 * compares against `new Date()` passes or fails depending on the day it runs.
 */
export async function runCoachingFutureDateGuardTests() {
  // ---- The exact production regression -------------------------------------------------
  // Stored 2026-05-11, imported on 2026-06-19. Swapping would yield 2026-11-05 — the future.
  // The swap must be refused and the stored date kept, unflagged.
  const productionCase = parseCoachingDate(new Date(Date.UTC(2026, 4, 11)), "2026-06-19");
  assert.equal(
    productionCase.date,
    "2026-05-11",
    "a day/month swap that lands in the future is refused — this is CR-2026-000196/000197",
  );
  assert.equal(productionCase.corrected, false, "a refused swap is not reported as a correction");

  // ---- The swap still works where it is legitimate --------------------------------------
  // Stored 2026-09-02 (Excel read "09/02" as Sep 2), coach meant 9 Feb. Swap lands in the
  // past, so it still applies — the fix narrows the rule, it does not disable it.
  const legitimate = parseCoachingDate(new Date(Date.UTC(2026, 8, 2)), "2026-09-30");
  assert.equal(legitimate.date, "2026-02-09", "a swap landing in the past is still applied");
  assert.equal(legitimate.corrected, true, "an applied swap is still flagged for the preview");

  // An unambiguous day (> 12) is never touched, future or not.
  const unambiguous = parseCoachingDate(new Date(Date.UTC(2026, 0, 14)), "2026-06-19");
  assert.equal(unambiguous.date, "2026-01-14", "day > 12 is unambiguous and kept as-is");
  assert.equal(unambiguous.corrected, false);

  // ---- Second line of defence: the preview flags ANY future date, whatever the parse path --
  // Day-first text (never touched by the swap) dated after the import must still be caught.
  const futureTextRow = {
    areaOfDevelopment: null,
    claimedHrId: "B-104",
    coachingDate: "2026-11-05",
    coachingDateRaw: "05/11/2026",
    dateCorrected: false,
    generalRemarks: null,
    overallScore: 80,
    repCode: null,
    repName: "Eman.Ahmed",
    rowNumber: 2,
    scoreIssues: [],
    scores: {},
    sourceName: "Eman.Ahmed",
    strengthPoints: null,
    territory: null,
  };
  const [flagged] = classifyCoachingImportRows(
    [futureTextRow as unknown as Parameters<typeof classifyCoachingImportRows>[0][number]],
    new Map(),
    "2026-06-19",
  );
  assert.ok(
    flagged.issues.some((issue) => /in the future/i.test(issue)),
    "a future coaching date is raised as an import issue, so the row is not silently committed",
  );

  // A past date raises no future-date issue.
  const [clean] = classifyCoachingImportRows(
    [
      {
        ...futureTextRow,
        coachingDate: "2026-05-11",
        coachingDateRaw: "11/05/2026",
      } as unknown as Parameters<typeof classifyCoachingImportRows>[0][number],
    ],
    new Map(),
    "2026-06-19",
  );
  assert.ok(
    !clean.issues.some((issue) => /in the future/i.test(issue)),
    "a past coaching date raises no future-date issue",
  );

  // ---- Server-side guard: the hand-entry path ------------------------------------------
  assert.throws(
    () => assertCoachingDateNotFuture("2026-11-05", "2026-09-01"),
    /in the future/i,
    "saving a future-dated coaching report is refused server-side",
  );
  // Today itself is allowed — the common case of coaching entered the same day.
  assert.doesNotThrow(
    () => assertCoachingDateNotFuture("2026-09-01", "2026-09-01"),
    "a report dated today is allowed",
  );
  assert.doesNotThrow(
    () => assertCoachingDateNotFuture("2026-08-31", "2026-09-01"),
    "a report dated yesterday is allowed",
  );

  // ---- The picker must not offer a future day in the first place -----------------------
  // Whole-file regex, never a fixed byte window (those false-fail when the file shifts).
  const form = readFileSync("src/components/coaching/coaching-report-form.tsx", "utf8");
  assert.match(
    form,
    /max=\{todayIsoDate\(\)\}/,
    "the coaching date input caps at today, so the calendar cannot offer a future day",
  );
  assert.match(
    form,
    /timeZone: "Africa\/Cairo"/,
    "the form's today is Cairo, not UTC — UTC runs a day behind late in the evening and would " +
      "reject a coach entering today's date",
  );
}
