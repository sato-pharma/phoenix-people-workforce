import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import type { DeductionsCandidateDraft } from "../src/lib/deductions/types.ts";
import { aggregateClippedLines, clipDraftToRange } from "../src/lib/daily-deductions/compute.ts";
import { assertNoDuplicateDailyLines, normalizeDailyLine } from "../src/lib/daily-deductions/lines.ts";
import { notifyDailyDeductionsReleased, releasedLineNoticeKey, type ReleasedLineForNotice } from "../src/lib/daily-deductions/notify-release.ts";
import {
  heldReasonOf,
  indexReleasedLines,
  linesToRelease,
  releaseStateOf,
  splitIntoSingles,
  type ComparableLine,
} from "../src/lib/daily-deductions/release-state.ts";

/**
 * EVERY DEDUCTION IS SINGLE (owner, 2026-11-13): "never group a group of deductions ... Ahmad Sharaf Din
 * have a 3 days unpaid vacation, 9, 10, 11 ... I can select day 9 alone and release, or day 10 alone and
 * release ... Never group them. I want each deduction to be single."
 *
 * This pins what makes that safe: each day is priced on its own by the connector's own rule, and only
 * where the split is exact; the tally is split into one deduction per employee × type × day; releasing
 * one day sends that day alone (its own stored row — the database keys rows by day since
 * 20261113181600), so it can never replace or drop a day released before; a day is never charged twice
 * against an older whole-range row; and each day is its own notice.
 */

function draft(partial: Partial<DeductionsCandidateDraft> & Pick<DeductionsCandidateDraft, "dates" | "rawValue">): DeductionsCandidateDraft {
  return {
    category: "unpaid_vacation",
    sourceSystem: "vacation",
    sourceRecordId: "r1",
    employeeHrId: "M-22",
    employeeName: "Ahmed Sharaf Eldeen",
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
const FROM = "2026-11-01";
const TO = "2026-11-12";
const WINDOW = { from: FROM, to: TO };

type Line = ComparableLine & { employeeName: string; employeeHrId: string };

function tallyOf(...drafts: DeductionsCandidateDraft[]): Line[] {
  return aggregateClippedLines(drafts.map((item) => clipDraftToRange(item, FROM, TO)!)).lines as Line[];
}

export async function runDailyDeductionsReleaseByDayTests() {
  // ── Ahmed's 9, 10 and 11 November: three single deductions ────────────────
  const ahmed = tallyOf(draft({ dates: [NINE, TEN, ELEVEN], rawValue: 3, estimatedAmount: 2100 }));
  const singles = splitIntoSingles(ahmed);
  {
    assert.deepEqual(
      singles.map((single) => [single.deductionDate, single.dates, single.amount, single.daysCount]),
      [
        [NINE, [NINE], 700, 1],
        [TEN, [TEN], 700, 1],
        [ELEVEN, [ELEVEN], 700, 1],
      ],
      "one deduction per day, each at its own price — never one row for the three",
    );
    assert.ok(singles.every((single) => !("days" in single)), "the per-day prices are not sent to the snapshot");
  }

  // ── release the 10th alone, then the 9th: each is its own row ─────────────
  {
    const tenth = singles.find((single) => single.deductionDate === TEN)!;
    assert.deepEqual(linesToRelease([tenth], indexReleasedLines([]), WINDOW), [tenth], "the 10th goes out alone");

    const released = indexReleasedLines([{ ...tenth }]);
    assert.deepEqual(
      singles.map((single) => releaseStateOf(single, released)),
      ["not_released", "released", "not_released"],
      "only the 10th reads released — the 9th and 11th are untouched",
    );
    const next = linesToRelease(singles, released, WINDOW);
    assert.deepEqual(next.map((single) => single.deductionDate), [NINE, ELEVEN], "the 9th and 11th are still there to release on their own");
    assert.ok(
      next.every((single) => single.dates.length === 1 && single.dates[0] === single.deductionDate),
      "REGRESSION: a later release sends ONLY its own day — it can never resend, replace or drop the 10th",
    );

    // The server refuses a one-day row that lists any other day, and the same day twice in one release.
    assert.throws(
      () => normalizeDailyLine({ ...tenth, dates: [NINE, TEN], employeeHrId: "M-22", rawDaysCount: 1, sourceSystem: "vacation" }, 0),
      /must list exactly its own day/,
    );
    const nine = normalizeDailyLine({ ...singles[0], employeeHrId: "M-22", rawDaysCount: 1, sourceSystem: "vacation" }, 0);
    const ten = normalizeDailyLine({ ...tenth, employeeHrId: "M-22", rawDaysCount: 1, sourceSystem: "vacation" }, 1);
    assert.equal(nine.deductionDate, NINE, "the day travels to the database");
    assert.doesNotThrow(() => assertNoDuplicateDailyLines([nine, ten]), "two days of one person and type are two deductions");
    assert.throws(() => assertNoDuplicateDailyLines([nine, { ...nine }]), /appears twice/);
  }

  // ── a day inside an older whole-range row is already out ──────────────────
  {
    const oldRow = { ...ahmed[0]!, days: undefined, deductionDate: null };
    const released = indexReleasedLines([oldRow]);
    assert.deepEqual(
      singles.map((single) => releaseStateOf(single, released)),
      ["released", "released", "released"],
      "a day an earlier whole-range release already charged is never charged again alone",
    );
    assert.deepEqual(linesToRelease(singles, released, WINDOW), []);
  }

  // ── each day is priced only where the split is exact ──────────────────────
  {
    const crm = splitIntoSingles(
      tallyOf(draft({ category: "crm", sourceSystem: "crm", dates: [NINE, TEN, THURSDAY], rawValue: 3, estimatedAmount: 1250 })),
    );
    assert.deepEqual(
      crm.map((single) => [single.deductionDate, single.amount, single.daysCount]),
      [
        [NINE, 500, 1],
        [TEN, 500, 1],
        [THURSDAY, 250, 0.5],
      ],
      "a CRM Thursday is half a day here too",
    );

    // A vacation request lists calendar days but charges a TOTAL of unpaid days spread across them
    // (money review, 2026-11-13): no day of it has a price of its own, so it stays ONE deduction.
    const spread = splitIntoSingles(tallyOf(draft({ dates: [NINE, TEN, ELEVEN], rawValue: 2, estimatedAmount: 1400 })));
    assert.equal(spread.length, 1, "never split on a guess");
    assert.equal(spread[0]!.deductionDate, null);
    assert.deepEqual(spread[0]!.dates, [NINE, TEN, ELEVEN]);
    assert.equal(spread[0]!.amount, 1400);

    const held = splitIntoSingles(tallyOf(draft({ dates: [NINE, TEN], rawValue: 2, estimatedAmount: null })));
    assert.deepEqual(held.map((single) => single.deductionDate), [NINE, TEN], "no salary on file: each day still shows on its own");
    assert.deepEqual(held.map((single) => heldReasonOf(single, indexReleasedLines([]), WINDOW)), ["no_salary", "no_salary"]);
    assert.deepEqual(linesToRelease(held, indexReleasedLines([]), WINDOW), [], "and is never released");
  }

  // ── a whole request is never released over days already out, or short ────
  {
    const whole = splitIntoSingles(tallyOf(draft({ dates: [NINE, TEN, ELEVEN], rawValue: 2, estimatedAmount: 1400 })))[0]!;
    const aloneTen = { ...whole, amount: 700, dates: [TEN], deductionDate: TEN, daysCount: 1 };
    assert.equal(heldReasonOf(whole, indexReleasedLines([aloneTen]), WINDOW), "days_released_alone");
    assert.deepEqual(linesToRelease([whole], indexReleasedLines([aloneTen]), WINDOW), [], "it would charge the 10th twice");

    const outside = { ...whole, dates: ["2026-10-30", NINE], deductionDate: null };
    assert.equal(
      heldReasonOf(whole, indexReleasedLines([outside]), WINDOW),
      "released_outside_range",
      "re-sending only the in-range days would take 30 October back out",
    );
    assert.equal(heldReasonOf(whole, indexReleasedLines([outside]), { from: "2026-10-30", to: TO }), null, "a range that covers it can");
  }

  // ── each day is its own notice, naming that day ───────────────────────────
  {
    const rows: ReleasedLineForNotice[] = [NINE, ELEVEN].map((date, index) => ({
      amount: 700,
      category: "unpaid_vacation",
      dates: [date],
      daysCount: 1,
      deductionDate: date,
      employeeHrId: "M-22",
      employeeHrIdCompact: "M22",
      employeeName: "Ahmed Sharaf Eldeen",
      id: `line-${index + 1}`,
      rangeEnd: date,
    }));
    // The 10th was released earlier: the per-employee read brings it back too, and it is not re-told.
    rows.push({ ...rows[0]!, dates: [TEN], deductionDate: TEN, id: "line-earlier" });
    const told: Array<{ id: string; dates: readonly string[] }> = [];
    const outcomes = await notifyDailyDeductionsReleased({
      actorHrId: "B-10",
      loadLines: async () => rows,
      notify: async ({ line }) => {
        told.push({ dates: line.dates ?? [], id: line.id });
        return { ccHrIds: [], employeeNotified: true, status: "sent" as const };
      },
      pairs: [NINE, ELEVEN].map((date) => ({ category: "unpaid_vacation", deductionDate: date, employeeHrId: "M-22", employeeHrIdCompact: "M22" })),
      publicationId: "pub-1",
    });
    assert.deepEqual(
      told,
      [
        { dates: [NINE], id: "line-1" },
        { dates: [ELEVEN], id: "line-2" },
      ],
      "the 9th and the 11th are two notices, each naming its own day — the 10th is not told again",
    );
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ["sent", "sent"]);
    assert.notEqual(releasedLineNoticeKey(rows[0]!), releasedLineNoticeKey(rows[1]!));
  }

  // ── the page never groups: no per-day or per-employee bulk button ─────────
  {
    const page = readFileSync(new URL("../src/components/admin/daily-deductions-workspace.tsx", import.meta.url), "utf8");
    assert.match(page, /splitIntoSingles\(/, "the page lists single deductions");
    assert.doesNotMatch(page, /Release this employee|Release all \(|Release day|Select all days/, "REGRESSION: no button releases a group");
  }
}
