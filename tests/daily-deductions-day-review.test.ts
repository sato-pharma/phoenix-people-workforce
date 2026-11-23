import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  buildDayReviewDraft,
  chargesOnDay,
  DAY_REVIEW_CATEGORY,
  DAY_REVIEW_COMMENT_MAX,
  DAY_REVIEW_SOURCE_SYSTEM,
  dayReviewRefusal,
  isDayReviewFraction,
  priceDayReview,
  type DayReviewEmployee,
} from "../src/lib/daily-deductions/day-review.ts";
import { dayChargeTarget } from "../src/lib/deductions/cycle.ts";
import { buildDeductionEmailMetrics } from "../src/lib/deductions/notify-deduction.ts";

/**
 * DAILY DEDUCTIONS — DEDUCT A DAY BY HAND (owner, 2026-11-23: "I choose the person, I choose the date, and
 * then his activity record for this day appear to me. Then I can push deduction for this day to a person
 * with a comment shown to him, and this if approved to payroll, then it is deduction to be added to the
 * payroll").
 *
 * Pins: the refusals (a future day, a day before hire, a leaver's day after the last working day or with
 * none recorded); which existing rows count as "already charged on that day" (never a retired row, a
 * "Do Not Take Action" row, a day the reviewer unticked or a Loan / Other placeholder); the price
 * (Base ÷ that month's calendar days × 1 or ½); the candidate written (category Other, Pending, the
 * comment as its reason, one key per person per day whatever the comment); a one-part employee's 22nd
 * landing on the next payroll month; and the comment reaching the employee's email.
 */

const EMPLOYEE: DayReviewEmployee = {
  hrId: "MR-0101",
  fullName: "Test Person",
  baseSalary: 9300,
  hireDate: "2026-03-01",
  lastWorkingDate: null,
  hasLeft: false,
};

const TODAY = "2026-11-23";

function refusalTests(): void {
  assert.equal(dayReviewRefusal({ employee: EMPLOYEE, date: "2026-11-20", todayIso: TODAY }), null, "a past working day can be deducted");
  assert.equal(dayReviewRefusal({ employee: EMPLOYEE, date: TODAY, todayIso: TODAY }), null, "today can be deducted once it has started");
  assert.match(dayReviewRefusal({ employee: EMPLOYEE, date: "2026-11-24", todayIso: TODAY }) ?? "", /not come yet/, "a future day is refused");
  assert.match(dayReviewRefusal({ employee: EMPLOYEE, date: "2026-02-28", todayIso: TODAY }) ?? "", /before .* joined/, "a day before hire is refused");
  assert.match(dayReviewRefusal({ employee: EMPLOYEE, date: "nonsense", todayIso: TODAY }) ?? "", /Choose a day/, "a malformed day is refused");

  const leaver = { ...EMPLOYEE, hasLeft: true, lastWorkingDate: "2026-11-10" };
  assert.equal(dayReviewRefusal({ employee: leaver, date: "2026-11-10", todayIso: TODAY }), null, "a leaver's last working day can be deducted");
  assert.match(dayReviewRefusal({ employee: leaver, date: "2026-11-11", todayIso: TODAY }) ?? "", /after .* last working day/, "a leaver's day after leaving is refused");
  assert.match(
    dayReviewRefusal({ employee: { ...leaver, lastWorkingDate: null }, date: "2026-11-01", todayIso: TODAY }) ?? "",
    /no last working day is recorded/,
    "a leaver with no last working day is refused, never guessed",
  );
}

function chargesOnDayTests(): void {
  const day = "2026-11-18";
  const base = { category: "fingerprint" as const, sourceSystem: "attendance", monthKey: "2026-11", estimatedAmount: 300 };
  const rows = [
    { ...base, id: "live", dates: [day] },
    { ...base, id: "other-day", dates: ["2026-11-17"] },
    { ...base, id: "retired", dates: [day], supersededAt: "2026-11-19T10:00:00Z" },
    { ...base, id: "dnta", dates: [day], decision: { decisionStatus: "Do Not Take Action" } },
    { ...base, id: "unticked", dates: ["2026-11-17", day], decision: { decisionStatus: "Approved for Payroll", appliedDates: ["2026-11-17"] } },
    { ...base, id: "manual", category: "other" as const, sourceSystem: "manual_hr", dates: [day] },
    { ...base, id: "pushed", category: "other" as const, sourceSystem: DAY_REVIEW_SOURCE_SYSTEM, dates: [day], decision: { decisionStatus: "Approved for Payroll", appliedAmount: 150 } },
  ];
  const found = chargesOnDay(rows, day);
  assert.deepEqual(
    found.map((charge) => charge.candidateId).sort(),
    ["live", "pushed"],
    "only a live row that still charges that day counts — never retired, Do Not Take Action, unticked or a Loan / Other placeholder",
  );
  const live = found.find((charge) => charge.candidateId === "live");
  assert.equal(live?.decisionStatus, "Pending", "an undecided row reads as Pending");
  assert.equal(live?.isDayReview, false);
  const pushed = found.find((charge) => charge.candidateId === "pushed");
  assert.equal(pushed?.isDayReview, true, "a day pushed from this screen is recognised as one");
  assert.equal(pushed?.amount, 150, "the decided amount wins over the estimate");
}

function priceTests(): void {
  // November has 30 days: 9,300 ÷ 30 = 310 a day.
  assert.equal(priceDayReview({ baseSalary: 9300, date: "2026-11-18", fraction: 1 }), 310);
  assert.equal(priceDayReview({ baseSalary: 9300, date: "2026-11-18", fraction: 0.5 }), 155);
  // December has 31 days: the day's OWN month prices it.
  assert.equal(priceDayReview({ baseSalary: 9300, date: "2026-12-01", fraction: 1 }), 300);
  assert.equal(priceDayReview({ baseSalary: null, date: "2026-11-18", fraction: 1 }), null, "no base salary is no price, never 0.00");
  assert.equal(isDayReviewFraction(1), true);
  assert.equal(isDayReviewFraction(0.5), true);
  assert.equal(isDayReviewFraction(2), false, "a day is deducted as one day or half a day, never more");
  assert.equal(isDayReviewFraction("1"), false);
}

function draftTests(): void {
  const target = dayChargeTarget("2026-11-18", false);
  const draft = buildDayReviewDraft({
    employee: EMPLOYEE,
    date: "2026-11-18",
    fraction: 0.5,
    comment: "  Left the area at noon without telling his manager.  ",
    enteredBy: "B-10",
    charge: target,
  });
  assert.equal(draft.category, DAY_REVIEW_CATEGORY);
  assert.equal(draft.category, "other", "charged as an Other deduction, which needs an approval before payroll");
  assert.equal(draft.sourceSystem, "daily_day_review");
  assert.equal(draft.sourceRecordId, "day-review:MR-0101:2026-11-18");
  assert.equal(draft.reason, "Left the area at noon without telling his manager.", "the comment, trimmed, IS the reason the employee reads");
  assert.equal(draft.rawValue, 0.5);
  assert.equal(draft.unit, "days");
  assert.equal(draft.estimatedAmount, 155);
  assert.equal(draft.calculationStatus, "calculated");
  assert.deepEqual(draft.dates, ["2026-11-18"], "it claims the real day, so the publish-time day guard sees it");
  assert.equal(draft.monthKey, "2026-11");
  assert.equal((draft.evidence as Record<string, unknown>).enteredBy, "B-10");

  const again = buildDayReviewDraft({ employee: EMPLOYEE, date: "2026-11-18", fraction: 1, comment: "A different comment", enteredBy: "B-10", charge: target });
  assert.equal(again.sourceRecordId, draft.sourceRecordId, "the comment and the size never change the key: one push per person per day");

  assert.throws(
    () => buildDayReviewDraft({ employee: EMPLOYEE, date: "2026-11-18", fraction: 1, comment: "   ", enteredBy: "B-10", charge: target }),
    /comment the employee will read/,
    "a push without a comment is refused",
  );
  assert.throws(
    () => buildDayReviewDraft({ employee: EMPLOYEE, date: "2026-11-18", fraction: 1, comment: "x".repeat(DAY_REVIEW_COMMENT_MAX + 1), enteredBy: "B-10", charge: target }),
    /keep it to/,
  );

  const noSalary = buildDayReviewDraft({ employee: { ...EMPLOYEE, baseSalary: null }, date: "2026-11-18", fraction: 1, comment: "c", enteredBy: "B-10", charge: target });
  assert.equal(noSalary.estimatedAmount, null);
  assert.equal(noSalary.calculationStatus, "requires_review", "an unpriced day is flagged for review, never written as a zero");

  // A one-part employee's 22nd November belongs to the December payroll month, carrying its cycle.
  const onePart = dayChargeTarget("2026-11-22", true);
  const cycleDraft = buildDayReviewDraft({ employee: EMPLOYEE, date: "2026-11-22", fraction: 1, comment: "c", enteredBy: "B-10", charge: onePart });
  assert.equal(cycleDraft.monthKey, "2026-12", "a one-part 22nd is charged in the next payroll month, where the collection run keys it");
  assert.ok((cycleDraft.evidence as Record<string, unknown>).deductionCycle, "the cycle marker travels with it");
  assert.deepEqual(cycleDraft.dates, ["2026-11-22"]);
  assert.equal(cycleDraft.estimatedAmount, 310, "still priced on the day's own calendar month");
}

function emailTests(): void {
  const line = {
    id: "line-1",
    employeeHrId: "MR-0101",
    employeeName: "Test Person",
    monthKey: "2026-11",
    category: "other" as const,
    amount: 155,
    daysCount: 0.5,
    dates: ["2026-11-18"],
  };
  const withNote = buildDeductionEmailMetrics({ ...line, note: "Left the area at noon." }, "November 2026");
  assert.deepEqual(
    withNote.find((metric) => metric.label === "Comment from HR"),
    { label: "Comment from HR", value: "Left the area at noon." },
    "the employee's email carries HR's comment",
  );
  const withoutNote = buildDeductionEmailMetrics(line, "November 2026");
  assert.equal(withoutNote.some((metric) => metric.label === "Comment from HR"), false, "no comment, no line");

  const push = readFileSync(new URL("../src/lib/deductions/push.ts", import.meta.url), "utf8");
  assert.match(
    push,
    new RegExp(`note: candidate\\.sourceSystem === "${DAY_REVIEW_SOURCE_SYSTEM}" \\? candidate\\.reason`),
    "the push hands a hand-pushed day's comment to the email, keyed on the same source system",
  );
}

function wiringTests(): void {
  const service = readFileSync(new URL("../src/lib/daily-deductions/day-review-service.ts", import.meta.url), "utf8");
  assert.match(service, /assertDailyDeductionsPublishActor\(input\.access\);[\s\S]*assertDailyDeductionsPublishActor\(input\.access\);/, "both the read and the push are Super Admin only");
  assert.doesNotMatch(service, /autoDecideStatus/, "a pushed day is born Pending — never auto-approved");
  assert.match(service, /existing\.length > 0[\s\S]*throw new Error/, "a day already charged is refused before anything is written");
  assert.match(service, /ledgerClaimMonthKeys\(/, "existing charges are read across the month AND the next payroll month");

  const page = readFileSync(new URL("../app/(admin)/admin/daily-deductions/page.tsx", import.meta.url), "utf8");
  assert.match(page, /access\.role === "Super Admin" \? <DailyDeductionsDayReview/, "the panel is mounted for the Super Admin alone");
}

export function runDailyDeductionsDayReviewTests(): void {
  refusalTests();
  chargesOnDayTests();
  priceTests();
  draftTests();
  emailTests();
  wiringTests();
}
