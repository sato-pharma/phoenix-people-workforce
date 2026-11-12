import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  describeAcceptedReviewDay,
  selectAcceptedReviewDays,
} from "../src/lib/private-calendar/accepted-review-days.ts";
import { selectPhoenixWorkedDays } from "../src/lib/deductions/phoenix-worked-days.ts";
import { provenWorkedDayReason, selectProvenWorkedDays } from "../src/lib/deductions/proven-worked-days.ts";
import { excludeProvenWorkedDays } from "../src/lib/deductions/connectors/crm.ts";
import { selectNoRecordsDrafts, type NoRecordsDay } from "../src/lib/daily-deductions/no-records-select.ts";
import type { DeductionsCandidateDraft } from "../src/lib/deductions/types.ts";

/**
 * A DAY THE SUPER ADMIN ACCEPTED A REVIEW REQUEST FOR IS NOT DEDUCTED (owner, 2026-11-13: an
 * employee with an empty day on his Private Calendar requests a review, the owner accepts it, and
 * "what I accept is appeared in the [calendar] and the day is not considered deducted").
 *
 * The defect, measured on production the same day: the calendar drew the accepted day, but no
 * deduction reader read `private_calendar_data_disputes`. 38 accepted whole-day requests from 16
 * people; 7 of those October days (5 people) still reached the Deductions module as CRM lines, each
 * cleared a second time by hand as "Do Not Take Action" on 9 November.
 *
 * Pinned, in the order the money flows:
 *   1. which requests count — accepted, whole-day, inside the window;
 *   2. the fold onto the shared proven-worked map, and the reason line a reviewer reads;
 *   3. the two connector exits — the CRM candidate and the daily no-records candidate;
 *   4. the loader is wired in, reads the one table, and fails closed.
 */

const MONTH = 10;
const YEAR = 2026;
const WINDOW = { end: "2026-10-31", start: "2026-10-01" };

function row(overrides: Record<string, unknown> = {}) {
  return {
    claim_text: "Training at the head office all day",
    dispute_date: "2026-10-13",
    employee_hr_id: "pd-0026",
    id: "r1",
    item_source: null,
    status: "accepted",
    ...overrides,
  } as Parameters<typeof selectAcceptedReviewDays>[0][number];
}

function crmDraft(): DeductionsCandidateDraft {
  return {
    category: "crm",
    sourceSystem: "crm_visits_mirror",
    sourceRecordId: "r1",
    employeeHrId: "PD-0026",
    employeeName: "Field Person",
    monthKey: `${YEAR}-${String(MONTH).padStart(2, "0")}`,
    month: MONTH,
    year: YEAR,
    unit: "days",
    rawValue: 2,
    estimatedAmount: 1_000,
    calculationStatus: "calculated",
    dates: ["2026-10-13", "2026-10-14"],
    evidence: {},
  } as DeductionsCandidateDraft;
}

// ── 1. Which requests count ─────────────────────────────────────────────────────────────────────

function onlyAnAcceptedWholeDayRequestInsideTheWindowCounts(): void {
  const days = selectAcceptedReviewDays(
    [
      row(),
      row({ id: "r2", status: "pending_review", dispute_date: "2026-10-14" }),
      row({ id: "r3", status: "rejected", dispute_date: "2026-10-15" }),
      row({ id: "r4", item_source: "attendance", dispute_date: "2026-10-16" }),
      row({ id: "r5", dispute_date: "2026-11-02" }),
      row({ id: "r6", dispute_date: "not a date" }),
    ],
    WINDOW,
  );
  assert.deepEqual(
    days.map((day) => `${day.hrId}:${day.date}`),
    ["pd-0026:2026-10-13"],
    "pending, rejected, item-scoped, out-of-window and undated requests spare nothing",
  );
}

// ── 2. The fold and the reason line ─────────────────────────────────────────────────────────────

function theAcceptedDayJoinsTheProvenMapCaseBlind(): void {
  const worked = selectProvenWorkedDays({
    acceptedReviews: selectAcceptedReviewDays([row()], WINDOW),
    phoenix: selectPhoenixWorkedDays([]),
    trips: [],
  });
  // The request is written with the login's spelling (pd-0026), the deduction with the master's
  // (PD-0026); both compact to one key.
  assert.ok(worked.keys.has("pd0026:2026-10-13"), "the accepted day is a proven-worked day");
  assert.equal(
    provenWorkedDayReason(worked, "pd0026:2026-10-13"),
    "Review request accepted on the Private Calendar: Training at the head office all day",
  );
}

function aRecordThatAlreadyProvesTheDayKeepsItsOwnReason(): void {
  const worked = selectProvenWorkedDays({
    acceptedReviews: selectAcceptedReviewDays([row()], WINDOW),
    phoenix: selectPhoenixWorkedDays([{ date: "2026-10-13", dayActivities: [], dayStarts: 0, hrId: "PD-0026", visits: 4 }]),
    trips: [],
  });
  assert.equal(provenWorkedDayReason(worked, "pd0026:2026-10-13"), "Phoenix CRM: 4 visits");
  assert.equal(describeAcceptedReviewDay({ claim: "  ", date: "2026-10-13", hrId: "x" }), "Review request accepted on the Private Calendar");
}

// ── 3. The two connector exits ──────────────────────────────────────────────────────────────────

function theCrmCandidateLosesTheAcceptedDay(): void {
  const worked = selectProvenWorkedDays({
    acceptedReviews: selectAcceptedReviewDays([row()], WINDOW),
    phoenix: selectPhoenixWorkedDays([]),
    trips: [],
  });
  const result = excludeProvenWorkedDays(crmDraft(), worked, new Map([["pd0026", 15_500]]), "Medical Representative");
  assert.ok(result, "the other day is still chargeable");
  // THE HEADLINE ASSERTION. Drop the accepted-review fold and this is the line that fires.
  assert.deepEqual(result.dates, ["2026-10-14"], "the day he accepted is not charged");
  assert.equal(result.rawValue, 1);
}

function theDailyNoRecordsCandidateIsNeverRaised(): void {
  const days: NoRecordsDay[] = [
    { date: "2026-10-13", description: "No Activity Recorded", employeeHrId: "HO-0042", employeeName: "Office Person" },
    { date: "2026-10-14", description: "No Activity Recorded", employeeHrId: "HO-0042", employeeName: "Office Person" },
  ];
  const worked = selectProvenWorkedDays({
    acceptedReviews: selectAcceptedReviewDays([row({ employee_hr_id: "ho-0042" })], WINDOW),
    phoenix: selectPhoenixWorkedDays([]),
    trips: [],
  });
  const drafts = selectNoRecordsDrafts({
    days,
    jobTitleByCanonicalKey: new Map([["HO-0042", "Product Manager"]]),
    outageDates: new Set<string>(),
    baseSalaryByCompact: new Map([["ho0042", 9_000]]),
    provenWorkedDayKeys: worked.keys,
    month: MONTH,
    year: YEAR,
  });
  assert.deepEqual(drafts.map((draft) => draft.dates[0]), ["2026-10-14"], "the accepted day raises no candidate");
}

// ── 4. The wiring ───────────────────────────────────────────────────────────────────────────────

function theLoaderIsWiredInAndFailsClosed(): void {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const code = (source: string) => source.replace(/^\s*(\*|\/\/|\/\*).*$/gm, "");

  const proven = code(read("src/lib/deductions/proven-worked-days.ts"));
  const body = proven.slice(proven.indexOf("export async function loadProvenWorkedDays"));
  assert.ok(/loadAcceptedReviewDays\(input\)/.test(body), "loadProvenWorkedDays reads the accepted review requests");
  assert.ok(/acceptedReviews[,\s]/.test(body.slice(body.indexOf("return selectProvenWorkedDays"))), "and hands them to the fold");

  const loader = code(read("src/lib/private-calendar/accepted-review-days.ts"));
  assert.ok(loader.includes(`.from("private_calendar_data_disputes")`), "it reads the review-request table");
  assert.ok(loader.includes(`.eq("status", "accepted")`) && loader.includes(`.is("item_source", null)`), "accepted whole-day rows only");
  assert.ok(/throw new Error\(/.test(loader), "a failed read throws rather than answering \"nothing accepted\"");
}

export function runDeductionsAcceptedReviewDaysTests(): void {
  onlyAnAcceptedWholeDayRequestInsideTheWindowCounts();
  theAcceptedDayJoinsTheProvenMapCaseBlind();
  aRecordThatAlreadyProvesTheDayKeepsItsOwnReason();
  theCrmCandidateLosesTheAcceptedDay();
  theDailyNoRecordsCandidateIsNeverRaised();
  theLoaderIsWiredInAndFailsClosed();
}
