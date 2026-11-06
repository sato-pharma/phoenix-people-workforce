import { strict as assert } from "node:assert";

import type { DeductionsCandidateDraft } from "../src/lib/deductions/types.ts";
import {
  addDaysIso,
  clipDatesToRange,
  monthsInRange,
  previousDayIso,
  resolveDailyRange,
  resolveDefaultRange,
} from "../src/lib/daily-deductions/range.ts";
import { aggregateClippedLines, clipDraftToRange } from "../src/lib/daily-deductions/compute.ts";

// A minimal-but-typed connector draft. clipDraftToRange only reads dates,
// rawValue, estimatedAmount, employeeHrId/Name, category, sourceSystem, reason;
// the rest are filled to satisfy the type without steering the result.
function draft(partial: Partial<DeductionsCandidateDraft> & Pick<DeductionsCandidateDraft, "dates" | "rawValue">): DeductionsCandidateDraft {
  return {
    category: "fingerprint",
    sourceSystem: "fingerprint",
    sourceRecordId: "r1",
    employeeHrId: "M-101",
    employeeName: "Test Person",
    monthKey: "2026-09",
    month: 9,
    year: 2026,
    unit: "days",
    estimatedAmount: null,
    reason: null,
    ...partial,
  } as DeductionsCandidateDraft;
}

/**
 * The Daily Deductions module is the SECOND deductions surface: it counts
 * deductions day-by-day over a picked range and publishes a running tally. Its
 * one dangerous freedom is that it counts an in-progress month — forbidden for
 * the month module (the 39,225.73 EGP incident). This suite pins the line that
 * makes that freedom safe: only fully-ELAPSED days are ever counted, and every
 * amount stays derived from the same scaleDeductionAmountToDays the month module
 * commits with, so "days shown" and "money counted" can never drift.
 */
export async function runDailyDeductionsRangeAndClipTests(): Promise<void> {
  // ── THE ELAPSED-DAY RULE — today and later are never counted ──────────────
  {
    const resolved = resolveDailyRange({ from: "2026-09-01", to: "2026-09-22" }, "2026-09-22");
    assert.equal(resolved.effectiveTo, "2026-09-21", "effectiveTo must clamp to yesterday (Cairo), never today");
    assert.equal(resolved.truncated, true, "a `to` that reached today must report truncated");
    assert.equal(resolved.empty, false, "a range with elapsed days is not empty");

    // Break-the-fix: the date IS otherwise a valid, in-window day — the ONLY
    // thing excluding today is the elapsed clamp. With effectiveTo pushed to
    // today it survives; at the real effectiveTo (yesterday) it is gone.
    assert.deepEqual(
      clipDatesToRange(["2026-09-22"], "2026-09-01", "2026-09-22"),
      ["2026-09-22"],
      "sanity: today is a structurally valid date inside the picked window",
    );
    assert.deepEqual(
      clipDatesToRange(["2026-09-22"], resolved.from, resolved.effectiveTo),
      [],
      "REGRESSION: today must be dropped by the elapsed clamp — counting an unfinished day is the incident this guards",
    );
    // And a whole draft whose only day is today contributes nothing.
    assert.equal(
      clipDraftToRange(draft({ dates: ["2026-09-22"], rawValue: 1, estimatedAmount: 100 }), resolved.from, resolved.effectiveTo),
      null,
      "a finding whose only day is today must clip to null",
    );
  }

  // ── An entirely-unelapsed range is empty ─────────────────────────────────
  {
    const resolved = resolveDailyRange({ from: "2026-09-22", to: "2026-09-25" }, "2026-09-22");
    assert.equal(resolved.empty, true, "a range whose start has not elapsed yet is empty — nothing is countable");
  }

  // ── A fully past range is untouched (effectiveTo === requested to) ────────
  {
    const resolved = resolveDailyRange({ from: "2026-08-21", to: "2026-08-31" }, "2026-09-22");
    assert.equal(resolved.effectiveTo, "2026-08-31", "a range that ended in the past is counted in full");
    assert.equal(resolved.truncated, false, "a past range is not truncated");
  }

  // ── from > to is refused ─────────────────────────────────────────────────
  {
    assert.throws(
      () => resolveDailyRange({ from: "2026-09-10", to: "2026-09-01" }, "2026-09-22"),
      /range start .* is after the range end/,
      "an inverted range must throw, not silently swap",
    );
  }

  // ── The default range: the OPEN Head Office cycle, 22nd → today ──────────
  {
    assert.deepEqual(
      resolveDefaultRange("2026-11-07"),
      { from: "2026-10-22", to: "2026-11-07" },
      "REGRESSION: the default opens on the 22nd — the 21st belongs to the cycle that already closed",
    );
    assert.deepEqual(
      resolveDefaultRange("2026-11-21"),
      { from: "2026-10-22", to: "2026-11-21" },
      "the 21st is still inside the cycle that opened on the 22nd of last month",
    );
    assert.deepEqual(
      resolveDefaultRange("2026-09-22"),
      { from: "2026-09-22", to: "2026-09-22" },
      "from the 22nd a new cycle is open, so the window starts this month, never a month back",
    );
    assert.deepEqual(
      resolveDefaultRange("2026-01-05"),
      { from: "2025-12-22", to: "2026-01-05" },
      "the default window rolls the year back across January",
    );
  }

  // ── Date arithmetic across month/year boundaries ─────────────────────────
  {
    assert.equal(previousDayIso("2026-09-01"), "2026-08-31", "previous day crosses a month boundary");
    assert.equal(previousDayIso("2026-01-01"), "2025-12-31", "previous day crosses a year boundary");
    assert.equal(addDaysIso("2026-08-30", 3), "2026-09-02", "addDaysIso crosses a month boundary");
  }

  // ── monthsInRange spans exactly the months a window touches ──────────────
  {
    assert.deepEqual(monthsInRange("2026-09-01", "2026-09-21"), [{ month: 9, year: 2026 }], "a single-month window");
    assert.deepEqual(
      monthsInRange("2026-08-21", "2026-09-21"),
      [{ month: 8, year: 2026 }, { month: 9, year: 2026 }],
      "a window straddling two months yields both, in order",
    );
    assert.deepEqual(
      monthsInRange("2025-12-21", "2026-01-05"),
      [{ month: 12, year: 2025 }, { month: 1, year: 2026 }],
      "a window across the year boundary yields both months",
    );
  }

  // ── clipDatesToRange de-duplicates and sorts ─────────────────────────────
  {
    assert.deepEqual(
      clipDatesToRange(["2026-09-05", "2026-09-01", "2026-09-05", "2026-08-30", "2026-09-30"], "2026-09-01", "2026-09-21"),
      ["2026-09-01", "2026-09-05"],
      "only in-range days survive, de-duplicated and sorted",
    );
  }

  // ── clipDraftToRange: a fully-contained finding is an EXACT passthrough ───
  {
    const line = clipDraftToRange(
      draft({ dates: ["2026-09-02", "2026-09-03", "2026-09-04"], rawValue: 3, estimatedAmount: 300 }),
      "2026-09-01",
      "2026-09-21",
    );
    assert.ok(line, "a fully in-range finding produces a line");
    assert.equal(line!.daysCount, 3, "every day survives, so daysCount equals rawValue");
    assert.equal(line!.amount, 300, "a fully-contained amount passes through byte-identical — no rounding drift");
    assert.equal(line!.amountUnknown, false, "the amount is known");
    assert.equal(line!.rawDaysCount, 3, "rawDaysCount keeps the connector's own detected count");
  }

  // ── clipDraftToRange: a boundary-straddling finding is prorated ──────────
  {
    const line = clipDraftToRange(
      draft({ dates: ["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"], rawValue: 4, estimatedAmount: 400 }),
      "2026-09-01",
      "2026-09-21",
    );
    assert.ok(line, "a straddling finding still produces a line for its in-range half");
    assert.equal(line!.daysCount, 2, "two of four days survive → daysCount 2");
    assert.equal(line!.amount, 200, "the amount scales with the surviving days (400/4*2)");
    assert.deepEqual(line!.dates, ["2026-09-01", "2026-09-02"], "only the in-range days are kept");
  }

  // ── clipDraftToRange: a missing amount stays UNKNOWN, never a false zero ──
  {
    const line = clipDraftToRange(
      draft({ dates: ["2026-09-02"], rawValue: 1, estimatedAmount: null }),
      "2026-09-01",
      "2026-09-21",
    );
    assert.ok(line, "a finding with no computable amount is still counted in days");
    assert.equal(line!.amountUnknown, true, "the amount is flagged unknown, not silently zeroed as a real figure");
    assert.equal(line!.amount, 0, "the stored amount is 0 but paired with amountUnknown");
  }

  // ── clipDraftToRange: entirely out of range → null ───────────────────────
  {
    assert.equal(
      clipDraftToRange(draft({ dates: ["2026-07-05"], rawValue: 1, estimatedAmount: 100 }), "2026-09-01", "2026-09-21"),
      null,
      "a finding wholly outside the range contributes nothing",
    );
  }

  // ── aggregateClippedLines: per employee×category, unions days, sums money ─
  {
    const augPart = clipDraftToRange(
      draft({ employeeHrId: "M-101", employeeName: "Sara", dates: ["2026-08-30", "2026-08-31"], rawValue: 2, estimatedAmount: 200 }),
      "2026-08-21",
      "2026-09-21",
    )!;
    const sepPart = clipDraftToRange(
      draft({ employeeHrId: "M-101", employeeName: "Sara", dates: ["2026-09-01"], rawValue: 1, estimatedAmount: 100 }),
      "2026-08-21",
      "2026-09-21",
    )!;
    const other = clipDraftToRange(
      draft({ employeeHrId: "A-9", employeeName: "Ahmed", category: "crm", sourceSystem: "crm", dates: ["2026-09-03"], rawValue: 1, estimatedAmount: 50 }),
      "2026-08-21",
      "2026-09-21",
    )!;
    // A spelling variant of Sara's id must fold into her row, not split it.
    const saraVariant = clipDraftToRange(
      draft({ employeeHrId: "m101", employeeName: "Sara", dates: ["2026-09-05"], rawValue: 1, estimatedAmount: 100 }),
      "2026-08-21",
      "2026-09-21",
    )!;

    const agg = aggregateClippedLines([sepPart, other, augPart, saraVariant]);
    assert.equal(agg.lines.length, 2, "two people → two rows (the two Sara drafts and her id-variant collapse to one)");
    assert.equal(agg.lines[0].employeeName, "Ahmed", "rows are ordered by name, never by code");
    assert.equal(agg.lines[1].employeeName, "Sara", "Sara sorts after Ahmed");

    const sara = agg.lines[1];
    assert.equal(sara.daysCount, 4, "Sara's Aug (2) + Sep (1) + variant (1) days sum");
    assert.equal(sara.amount, 400, "Sara's amounts sum across drafts (200+100+100)");
    assert.deepEqual(
      sara.dates,
      ["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-05"],
      "Sara's days are unioned across drafts, de-duplicated and sorted",
    );
    assert.equal(agg.droppedUnidentified, 0, "no unidentified rows here");
    assert.equal(agg.amountUnknownEmployees.length, 0, "every amount was known");
  }

  // ── aggregateClippedLines: an unresolvable HR id is dropped and reported ──
  {
    const good = clipDraftToRange(
      draft({ employeeHrId: "M-101", employeeName: "Sara", dates: ["2026-09-02"], rawValue: 1, estimatedAmount: 100 }),
      "2026-09-01",
      "2026-09-21",
    )!;
    const noId = clipDraftToRange(
      draft({ employeeHrId: "", employeeName: "No Code", dates: ["2026-09-03"], rawValue: 1, estimatedAmount: 100 }),
      "2026-09-01",
      "2026-09-21",
    )!;
    const unknownAmount = clipDraftToRange(
      draft({ employeeHrId: "B-7", employeeName: "Mona", dates: ["2026-09-04"], rawValue: 1, estimatedAmount: null }),
      "2026-09-01",
      "2026-09-21",
    )!;

    const agg = aggregateClippedLines([good, noId, unknownAmount]);
    assert.equal(agg.droppedUnidentified, 1, "the finding with no resolvable HR id is dropped, not folded into an empty key");
    assert.ok(
      agg.lines.every((line) => line.employeeHrIdCompact !== ""),
      "no tally row carries an empty compact HR id",
    );
    assert.deepEqual(agg.amountUnknownEmployees, ["Mona"], "the amount-unknown employee is named for the operator");
    const mona = agg.lines.find((line) => line.employeeName === "Mona");
    assert.equal(mona?.amountUnknown, true, "the unpriced row is marked, so it can be held back from release");
    assert.equal(
      agg.lines.find((line) => line.employeeName === "Sara")?.amountUnknown,
      false,
      "a priced row is not marked",
    );
  }

  // ── A CRM row cut by the range is priced on WEIGHTED days (audit, 2026-11-07) ──
  // Base 15,000 in a 31-day October is 483.87 a day. Mon 19 + Thu 22 Oct is 1.5 days = 725.81. The
  // default range opens inside it, so keeping one date and sharing the money by COUNT charged the
  // Thursday 362.91 (a full half of the money) where it is worth 241.94, and the Monday 362.91 where
  // it is worth 483.87 — and told the employee "1 day" for a half day.
  {
    const crm = draft({
      category: "crm",
      sourceSystem: "crm_visits_mirror",
      monthKey: "2026-10",
      month: 10,
      dates: ["2026-10-19", "2026-10-22"],
      rawValue: 2,
      estimatedAmount: 725.81,
    });
    const thursday = clipDraftToRange(crm, "2026-10-21", "2026-10-31")!;
    assert.deepEqual(thursday.dates, ["2026-10-22"]);
    assert.equal(thursday.amount, 241.94, "REGRESSION: a kept Thursday is charged as the half day it weighs");
    assert.equal(thursday.daysCount, 0.5, "and counted as half a day, the figure the employee is emailed");

    const monday = clipDraftToRange(crm, "2026-10-01", "2026-10-20")!;
    assert.equal(monday.amount, 483.87, "a kept full day is charged as a full day");
    assert.equal(monday.daysCount, 1);

    const whole = clipDraftToRange(crm, "2026-10-01", "2026-10-31")!;
    assert.equal(whole.amount, 725.81, "an uncut CRM row is the connector's own figure to the piaster");

    const fingerprint = clipDraftToRange({ ...crm, category: "fingerprint", sourceSystem: "fingerprint" }, "2026-10-21", "2026-10-31")!;
    assert.equal(fingerprint.daysCount, 1, "every other category keeps the plain kept fraction");
  }
}
