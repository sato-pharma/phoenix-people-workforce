import { strict as assert } from "node:assert";

import type { DeductionsCandidateDraft } from "../src/lib/deductions/types.ts";
import { aggregateClippedLines, clipDraftToRange } from "../src/lib/daily-deductions/compute.ts";
import { releasedLineNoticeKey } from "../src/lib/daily-deductions/notify-release.ts";
import {
  figuresForDates,
  indexReleasedLines,
  linesToRelease,
  planDayRelease,
  releasedDaysOf,
  releaseStateOf,
  summarizeDays,
  type ComparableLine,
} from "../src/lib/daily-deductions/release-state.ts";

/**
 * RELEASE BY DAY (owner, 2026-11-13): "if you have 9 and 10 and 11 days, November, all deduction, all
 * value, 1,500 ... I want to select day 9 and day 11 in November and release only their deductions".
 *
 * The page used to release a whole employee × type line, every day of the range at once. This pins the
 * four things that make releasing single days safe: every day is priced on its own by the connector's
 * own rule (a CRM Thursday is half), a ticked-days release sends exactly those days (plus any already
 * out — the snapshot keeps one row per employee × type), a later day re-tells the employee, and a row
 * with days released outside the counted window is never re-sent short.
 */

function draft(partial: Partial<DeductionsCandidateDraft> & Pick<DeductionsCandidateDraft, "dates" | "rawValue">): DeductionsCandidateDraft {
  return {
    category: "fingerprint",
    sourceSystem: "fingerprint",
    sourceRecordId: "r1",
    employeeHrId: "M-101",
    employeeName: "Test Person",
    monthKey: "2026-11",
    month: 11,
    year: 2026,
    unit: "days",
    estimatedAmount: null,
    reason: null,
    ...partial,
  } as DeductionsCandidateDraft;
}

const NINE = "2026-11-09";
const TEN = "2026-11-10";
const ELEVEN = "2026-11-11";
const THURSDAY = "2026-11-12";

function tallyLine(partial: Partial<ComparableLine & { employeeName: string }> = {}): ComparableLine & { employeeName: string } {
  return {
    amount: 1500,
    category: "fingerprint",
    dates: [NINE, TEN, ELEVEN],
    days: [
      { amount: 500, date: NINE, daysCount: 1 },
      { amount: 500, date: TEN, daysCount: 1 },
      { amount: 500, date: ELEVEN, daysCount: 1 },
    ],
    daysCount: 3,
    employeeHrIdCompact: "M101",
    employeeName: "Test Person",
    ...partial,
  };
}

const WINDOW = { from: "2026-11-01", to: "2026-11-12" };

export function runDailyDeductionsReleaseByDayTests() {
  // ── every day is priced on its own, by the connector's own rule ────────────
  {
    const clipped = clipDraftToRange(
      draft({ category: "crm", sourceSystem: "crm", dates: [NINE, TEN, THURSDAY], rawValue: 3, estimatedAmount: 1250 }),
      "2026-11-01",
      "2026-11-12",
    );
    assert.ok(clipped, "the finding is in range");
    assert.deepEqual(
      clipped!.days,
      [
        { amount: 500, date: NINE, daysCount: 1 },
        { amount: 500, date: TEN, daysCount: 1 },
        { amount: 250, date: THURSDAY, daysCount: 0.5 },
      ],
      "a CRM Thursday is priced at half a day, as the whole line prices it",
    );
    assert.equal(clipped!.amount, 1250, "the whole line is unchanged by the per-day prices");

    const unpriced = clipDraftToRange(draft({ dates: [NINE, TEN], rawValue: 2, estimatedAmount: null }), "2026-11-01", "2026-11-12");
    assert.deepEqual(unpriced!.days, [], "a line with no salary on file carries no day prices");

    const aggregated = aggregateClippedLines([
      clipDraftToRange(draft({ dates: [NINE, TEN], rawValue: 2, estimatedAmount: 1000 }), "2026-11-01", "2026-11-12")!,
      clipDraftToRange(draft({ dates: [ELEVEN], rawValue: 1, estimatedAmount: 500, sourceRecordId: "r2" }), "2026-11-01", "2026-11-12")!,
    ]);
    assert.equal(aggregated.lines.length, 1, "two findings for one person and type are one tally line");
    assert.deepEqual(
      aggregated.lines[0].days?.map((day) => [day.date, day.amount]),
      [[NINE, 500], [TEN, 500], [ELEVEN, 500]],
      "the tally line carries one price per day, across its findings",
    );

    const mixed = aggregateClippedLines([
      clipDraftToRange(draft({ dates: [NINE], rawValue: 1, estimatedAmount: 500 }), "2026-11-01", "2026-11-12")!,
      clipDraftToRange(draft({ dates: [TEN], rawValue: 1, estimatedAmount: null, sourceRecordId: "r2" }), "2026-11-01", "2026-11-12")!,
    ]);
    assert.equal(mixed.lines[0].days, undefined, "a line with any unpriced day carries no split — it can only go whole");
  }

  // ── what some of a line's days are worth ─────────────────────────────────
  {
    const line = tallyLine({ amount: 1500.01 });
    assert.deepEqual(
      figuresForDates(line, [ELEVEN, NINE]),
      { amount: 1000, category: "fingerprint", dates: [NINE, ELEVEN], daysCount: 2, employeeHrIdCompact: "M101" },
      "9 and 11 November are the sum of those two days",
    );
    assert.equal(
      figuresForDates(line, [NINE, TEN, ELEVEN])!.amount,
      1500.01,
      "every day is the line's own figure to the piaster, never a re-summed one",
    );
    assert.equal(figuresForDates(tallyLine({ days: undefined }), [NINE]), null, "no day prices, no split");
  }

  // ── releasing 9 and 11, and leaving the 10th ─────────────────────────────
  {
    const line = tallyLine();
    const first = planDayRelease([line], new Set([NINE, ELEVEN]), indexReleasedLines([]), WINDOW);
    assert.equal(first.lines.length, 1);
    assert.deepEqual(first.lines[0].dates, [NINE, ELEVEN], "only the ticked days are sent");
    assert.equal(first.lines[0].amount, 1000, "at what those days are worth");
    assert.equal(first.lines[0].daysCount, 2);
    assert.equal(first.addedAmount, 1000);
    assert.equal(first.lines[0].days, undefined, "the per-day prices are not sent to the snapshot");

    const released = indexReleasedLines([{ ...line, amount: 1000, dates: [NINE, ELEVEN], days: undefined, daysCount: 2 }]);
    assert.equal(releaseStateOf(line, released), "partly_released", "two of three days out reads Some days released");
    assert.deepEqual([...releasedDaysOf(line, released)].sort(), [NINE, ELEVEN], "the 9th and 11th are drawn as released");
    assert.equal(linesToRelease([line], released).length, 1, "the whole-line Release still offers the rest");

    const again = planDayRelease([line], new Set([NINE]), released, WINDOW);
    assert.equal(again.lines.length, 0, "a day already out is never sent twice");

    const rest = planDayRelease([line], new Set([TEN]), released, WINDOW);
    assert.deepEqual(rest.lines[0].dates, [NINE, TEN, ELEVEN], "the 10th joins the row with the days already out");
    assert.equal(rest.lines[0].amount, 1500, "and the row is then the whole line");
    assert.equal(rest.addedAmount, 500, "the confirmation says what the 10th adds");

    const days = summarizeDays([line, tallyLine({ employeeHrIdCompact: "M102", employeeName: "Other" })], released);
    assert.deepEqual(
      days.map((day) => [day.date, day.state, day.amount, day.releasedAmount]),
      [
        [NINE, "partly_released", 1000, 500],
        [TEN, "not_released", 1000, 0],
        [ELEVEN, "partly_released", 1000, 500],
      ],
      "each day reads its own total and what of it is out",
    );
  }

  // ── a row with days out beyond the counted window is never re-sent short ──
  {
    const line = tallyLine();
    const released = indexReleasedLines([{ ...line, amount: 500, dates: ["2026-10-30"], days: undefined, daysCount: 1 }]);
    const plan = planDayRelease([line], new Set([NINE]), released, WINDOW);
    assert.equal(plan.lines.length, 0, "re-sending only the in-range days would take 30 October back out");
    assert.deepEqual(plan.skipped.map((skip) => skip.reason), ["released_outside_range"], "and it is named, not silent");

    const held = planDayRelease([tallyLine({ amountUnknown: true })], new Set([NINE]), indexReleasedLines([]), WINDOW);
    assert.deepEqual(held.skipped.map((skip) => skip.reason), ["no_salary"], "a line with no salary on file is never sent by day either");
  }

  // ── a later day tells the employee again; the same days never twice ───────
  {
    const nine = releasedLineNoticeKey({ dates: [NINE], id: "line-1" });
    const nineEleven = releasedLineNoticeKey({ dates: [ELEVEN, NINE], id: "line-1" });
    assert.notEqual(nine, nineEleven, "releasing the 11th after the 9th is a new notice");
    assert.equal(nineEleven, releasedLineNoticeKey({ dates: [NINE, ELEVEN], id: "line-1" }), "the same days in any order are one notice");
    assert.equal(releasedLineNoticeKey({ dates: [], id: "line-2" }), "line-2", "a line with no days keeps the plain id");
  }
}
