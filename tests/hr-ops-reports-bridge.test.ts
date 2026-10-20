import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import {
  buildReviewedDayDraft,
  chargingCategories,
  reviewWeekForDay,
  runHrOpsBridge,
  type BridgeDayOutcome,
  type BridgeDayRequest,
  type DayClaim,
  type HrOpsBridgeDeps,
  type HrOpsBridgeLine,
  type SavedBridgeOutcome,
} from "../src/lib/hr-ops-reports/bridge.ts";
import { NOT_CARRIED_MESSAGE } from "../src/lib/hr-ops-reports/rules.ts";
import { deductionCategoryForDigestLine, deductionSourceForDigestLine, HR_OPS_REPORT_SOURCE_SYSTEM } from "../src/lib/attendance/digest-rules.ts";
import { payrollStepsForCategory } from "../src/lib/automated-payroll/deduction-resync.ts";
import {
  DEDUCTIONS_CATEGORY_CONFIG,
  deductionsCategoryRequiresApproval,
  isEligibleForPublish,
  salaryRecordsColumnForCategory,
} from "../src/lib/deductions/calculations.ts";
import { findDayCollisions } from "../src/lib/deductions/conflict.ts";
import { excludeFieldReviewClaimedDays } from "../src/lib/deductions/connectors/crm.ts";
import {
  deductionsCategories,
  deductionsCategoryNames,
  visibleDeductionsCategories,
  type DeductionsCandidateDraft,
} from "../src/lib/deductions/types.ts";
import { DEDUCTION_CATEGORY_LABELS } from "../src/lib/hr/command-center.ts";

/**
 * THE HR OPERATIONS REPORT'S DECISIONS REACH THE WEEKLY ATTENDANCE REVIEW, AND PAYROLL, ONCE.
 *
 * Owner, 2026-10-20: the HR Operations Specialist reviews each day "in days only" and the Super Admin
 * decides. src/lib/hr-ops-reports/bridge.ts carries each decided day onto the road a fingerprint day
 * already travels — the weekly attendance review, the employee's salary-or-balance answer, the
 * month-end deduction through recordDecision. What is pinned here:
 *
 *   · an OFFICE day is only ever SET on the review's own day (the existing tick path), and nothing else
 *     is written — the month-end Fingerprint connector stays the ONE writer of an office day's
 *     deduction. A day the review does not hold yet writes nothing and waits for the daily job to add
 *     it; once its week is closed or released without it, it is `week_released`;
 *   · a FIELD day is added as a `field_review` day with one `field_review` deduction, paid through the
 *     CRM column;
 *   · a released week is never written into; one failing day never stops the others; a second run
 *     adds nothing; the daily job never refreshes or removes a day the bridge wrote or set;
 *   · the new category is in every exhaustive table, and a reviewed day claimed by a second category
 *     is refused before publish;
 *   · an approved OFFICE row the review can never hold (no punch, or a day the policy charges 0) is
 *     "Not carried": final at once, no call to the review, nothing written (owner, 2026-10-20);
 *   · a FIELD day is never written over a day a live crm / crm_half_day / fingerprint deduction already
 *     charges, nor into a payroll month already final — and a read that fails, fails the day;
 *   · a decision that changes while it is carried is never written (`superseded`), its outcome is saved
 *     only on the line as it was read, and a save that matches nothing is logged, never silent.
 *
 * No database: every read and write the bridge makes goes through `HrOpsBridgeDeps`, faked here.
 */

const TODAY = "2026-10-20";
const NOW = "2026-10-20T08:00:00.000Z";

function line(overrides: Partial<HrOpsBridgeLine> = {}): HrOpsBridgeLine {
  return {
    id: "line-1",
    section: "office",
    workDate: "2026-10-12",
    hrId: "PD-0101",
    hrKey: "pd-0101",
    employeeName: "Test Employee",
    flags: ["late"],
    // The policy charged the day, so the weekly review holds it (rules.ts reachesWeeklyReview).
    suggestedDays: 0.25,
    reviewReason: "Arrived after the grace period twice this week.",
    decision: "approved",
    decidedDays: 1,
    decidedByHrId: "b-10",
    decidedAt: "2026-10-19T19:30:00.000Z",
    ...overrides,
  };
}

type ReviewDay = { lineId: number; status: string; days: number; stampedBy: string | null; action: string };

/**
 * An in-memory weekly review behaving as phx_hr_ops_bridge_digest_day does: a day is found by its
 * report line first, then by person-day; a stamped day answers `bridged` again without change; a
 * released or answered day answers `week_released`. With no day: an office day — or a field day it may
 * not add — answers `week_released` when the person's week has already gone out, and `waiting`
 * otherwise; only a field day it may add is added. Asked to add an office day, it throws.
 */
function fakeReview(
  seed: Array<{ employeeHrId: string; workDate: string; status: string; days: number; action?: string }> = [],
  options: { releasedWeeks?: readonly string[] } = {},
) {
  const byPersonDay = new Map<string, ReviewDay>();
  const byReportLine = new Map<string, ReviewDay>();
  const releasedWeeks = new Set(options.releasedWeeks ?? []);
  let next = 1;
  const seedDay = (day: { employeeHrId: string; workDate: string; status: string; days: number; action?: string }) => {
    byPersonDay.set(`${day.employeeHrId}:${day.workDate}`, {
      lineId: next++,
      status: day.status,
      days: day.days,
      stampedBy: null,
      action: day.action ?? "pending",
    });
  };
  for (const day of seed) seedDay(day);
  const requests: BridgeDayRequest[] = [];
  const bridgeDay = async (request: BridgeDayRequest): Promise<BridgeDayOutcome> => {
    requests.push(request);
    const own = byReportLine.get(request.hrOpsLineId);
    if (own) {
      return { outcome: "bridged", lineId: own.lineId, digestEmployeeHrId: request.employeeHrId, lineStatus: own.status, created: false, alreadyBridged: true };
    }
    const key = `${request.employeeHrId}:${request.workDate}`;
    const existing = byPersonDay.get(key);
    if (existing) {
      if (existing.action !== "pending") return { outcome: "week_released", lineId: existing.lineId, lineAction: existing.action };
      existing.days = request.days;
      existing.stampedBy = request.decidedByHrId;
      byReportLine.set(request.hrOpsLineId, existing);
      return { outcome: "bridged", lineId: existing.lineId, digestEmployeeHrId: request.employeeHrId, lineStatus: existing.status, created: false, alreadyBridged: false };
    }
    if (request.section !== "field" || !request.allowInsert) {
      if (request.section !== "field" && request.allowInsert) throw new Error("the bridge asked to add an office day");
      const weekKey = `${request.employeeHrId}:${request.cycleKey}:${request.weekIndex}`;
      return releasedWeeks.has(weekKey) ? { outcome: "week_released", lineId: null, lineAction: null } : { outcome: "waiting" };
    }
    const added: ReviewDay = { lineId: next++, status: "field_review", days: request.days, stampedBy: request.decidedByHrId, action: "pending" };
    byPersonDay.set(key, added);
    byReportLine.set(request.hrOpsLineId, added);
    return { outcome: "bridged", lineId: added.lineId, digestEmployeeHrId: request.employeeHrId, lineStatus: added.status, created: true, alreadyBridged: false };
  };
  return { byPersonDay, byReportLine, requests, bridgeDay, seedDay };
}

/** A deductions ledger keyed the way insertCandidateDrafts is idempotent: one live row per key. */
function fakeLedger() {
  const rows = new Map<string, DeductionsCandidateDraft>();
  let writes = 0;
  const ensureCandidate = async (draft: DeductionsCandidateDraft) => {
    writes += 1;
    const key = `${draft.category}|${draft.sourceSystem}|${draft.sourceRecordId}|${draft.monthKey}`;
    if (!rows.has(key)) rows.set(key, draft);
    return { candidateId: key, warnings: [] as string[] };
  };
  return { rows, ensureCandidate, writes: () => writes };
}

function deps(overrides: Partial<HrOpsBridgeDeps> & { saved?: Map<string, SavedBridgeOutcome> } = {}): HrOpsBridgeDeps {
  const saved = overrides.saved ?? new Map<string, SavedBridgeOutcome>();
  return {
    todayIso: () => TODAY,
    nowIso: () => NOW,
    reviewLive: async () => ({ live: true, why: null }),
    // 3,100 a month: October has 31 days, so one day is exactly 100.00.
    baseSalaries: async () => new Map([["pd0101", 3100], ["pd0202", 3100]]),
    bridgeDay: async () => {
      throw new Error("bridgeDay was not expected in this case");
    },
    ensureCandidate: async () => {
      throw new Error("ensureCandidate was not expected in this case");
    },
    // No other deduction charges the day, and no month is final, unless a case says so.
    dayClaims: async () => [],
    payrollMonthFinal: async () => false,
    saveOutcome: async (lineId, outcome) => {
      saved.set(lineId, outcome);
    },
    ...overrides,
  };
}

async function anOfficeApprovalSetsTheReviewsOwnDay() {
  // The fingerprint report flags 12 October, so the review already holds the day (late, 0.25).
  const review = fakeReview([{ employeeHrId: "PD-0101", workDate: "2026-10-12", status: "late", days: 0.25 }]);
  const saved = new Map<string, SavedBridgeOutcome>();
  const counts = await runHrOpsBridge([line()], deps({ saved, bridgeDay: review.bridgeDay }));

  assert.deepEqual(counts, { bridged: 1, waiting: 0, weekReleased: 0, failed: 0 });
  assert.equal(review.requests.length, 1);
  const request = review.requests[0]!;
  assert.equal(request.days, 1, "the decided days are carried, not the days the report detected");
  assert.equal(request.allowInsert, false, "an office day is the daily job's to add — the bridge only ever sets it");
  assert.equal(request.value, null, "an office day is never priced by the bridge: it never writes its deduction");
  assert.equal(request.employeeHrId, "PD-0101", "the employee is sent in the form an HR id is stored in");
  assert.equal(request.decidedByHrId, "B-10", "who decided is written in the stored form, never the lowercase comparison key");
  assert.equal(request.decidedAt, "2026-10-19T19:30:00.000Z");
  assert.deepEqual(
    { cycleKey: request.cycleKey, weekIndex: request.weekIndex, weekStart: request.weekStart, weekEnd: request.weekEnd },
    { cycleKey: "2026-10", weekIndex: 2, weekStart: "2026-10-08", weekEnd: "2026-10-14" },
  );
  assert.equal(review.byPersonDay.get("PD-0101:2026-10-12")?.days, 1, "the review's own day now carries the decided days");
  assert.equal(saved.get("line-1")?.status, "bridged");
  assert.equal(saved.get("line-1")?.ref, "1", "bridge_ref names the weekly-review day");
  assert.equal(saved.get("line-1")?.at, NOW, "bridged_at is set when the day reaches the review");
  // ensureCandidate is the throwing default: an office day writes no deduction of its own.
}

async function anOfficeDayTheReviewDoesNotHoldYetWritesNothingAndWaits() {
  const review = fakeReview();
  const saved = new Map<string, SavedBridgeOutcome>();
  let salaryReads = 0;
  // Left early and charged half a day: a day the review WILL hold, once the daily job adds it. (A
  // no-punch row never reaches the review at all — that is "Not carried", pinned below.)
  const officeDay = line({ id: "line-2", workDate: "2026-10-13", flags: ["early_leave"], suggestedDays: 0.5 });
  const officeDeps = () =>
    deps({
      saved,
      baseSalaries: async () => {
        salaryReads += 1;
        return new Map([["pd0101", 3100]]);
      },
      bridgeDay: review.bridgeDay,
      // ensureCandidate stays the throwing default: an office day never writes a deduction.
    });

  const first = await runHrOpsBridge([officeDay], officeDeps());
  assert.deepEqual(first, { bridged: 0, waiting: 1, weekReleased: 0, failed: 0 });
  assert.equal(review.requests[0]?.allowInsert, false, "the bridge never asks to add an office day");
  assert.equal(review.byPersonDay.size, 0, "no weekly-review day is written");
  assert.equal(salaryReads, 0, "nothing is priced: an office day's deduction is the Fingerprint connector's alone");
  assert.equal(saved.get("line-2")?.status, "waiting");
  assert.equal(saved.get("line-2")?.ref, null);
  assert.equal(saved.get("line-2")?.at, null);
  assert.match(String(saved.get("line-2")?.message), /does not hold 13 October 2026 yet/);

  // The daily job adds the day from the fingerprint report; the retry then sets it, and only it.
  review.seedDay({ employeeHrId: "PD-0101", workDate: "2026-10-13", status: "early_leave", days: 0.5 });
  const retried = await runHrOpsBridge([officeDay], officeDeps());
  assert.deepEqual(retried, { bridged: 1, waiting: 0, weekReleased: 0, failed: 0 });
  assert.equal(review.byPersonDay.size, 1, "still the one day the daily job added");
  assert.equal(review.byPersonDay.get("PD-0101:2026-10-13")?.status, "early_leave", "it stays a fingerprint day");
  assert.equal(review.byPersonDay.get("PD-0101:2026-10-13")?.stampedBy, "B-10");
  assert.equal(saved.get("line-2")?.status, "bridged");
  assert.equal(salaryReads, 0);

  // The person's week went out without the day: nothing is written, and it says so instead of waiting.
  const released = fakeReview([], { releasedWeeks: ["PD-0101:2026-10:1"] });
  const gone = new Map<string, SavedBridgeOutcome>();
  const goneCounts = await runHrOpsBridge([line({ id: "gone", workDate: "2026-10-05" })], deps({ saved: gone, bridgeDay: released.bridgeDay }));
  assert.deepEqual(goneCounts, { bridged: 0, waiting: 0, weekReleased: 1, failed: 0 });
  assert.equal(released.byPersonDay.size, 0);
  assert.equal(gone.get("gone")?.status, "week_released");
  assert.equal(gone.get("gone")?.ref, null);
  assert.match(String(gone.get("gone")?.message), /already released in the weekly attendance review without this day/);

  // A week the review has closed never gains the day either.
  const closedReview = fakeReview();
  const closed = new Map<string, SavedBridgeOutcome>();
  const closedCounts = await runHrOpsBridge(
    [line({ id: "closed-office", workDate: "2026-08-11" })],
    deps({ saved: closed, bridgeDay: closedReview.bridgeDay }),
  );
  assert.deepEqual(closedCounts, { bridged: 0, waiting: 0, weekReleased: 1, failed: 0 });
  assert.equal(closed.get("closed-office")?.status, "week_released");
  assert.match(String(closed.get("closed-office")?.message), /is closed in the weekly attendance review/);

  // And the code itself holds no second writer of an office day's deduction.
  const app = stripComments(readFileSync(path.join(process.cwd(), "src/lib/hr-ops-reports/bridge.ts"), "utf8"));
  assert.doesNotMatch(app, /category:\s*"fingerprint"/, "the bridge never writes a fingerprint deduction");
  assert.doesNotMatch(app, /getFingerprintAttendanceReport|office_review/, "nor reads the fingerprint report to decide to add one");
  assert.match(app, /const allowInsert = isField && open;/, "only a field day is ever the bridge's to add");
}

async function aFieldApprovalIsOneDayAndOneDeductionHoweverOftenItRuns() {
  const review = fakeReview();
  const ledger = fakeLedger();
  const field = line({ id: "line-3", section: "field", workDate: "2026-10-14", flags: ["no_field_activity"], decidedDays: 0.5 });

  const first = await runHrOpsBridge([field], deps({ bridgeDay: review.bridgeDay, ensureCandidate: ledger.ensureCandidate }));
  // The same line again — a retry after a lost save, or a second click.
  const second = await runHrOpsBridge([field], deps({ bridgeDay: review.bridgeDay, ensureCandidate: ledger.ensureCandidate }));

  assert.deepEqual(first, { bridged: 1, waiting: 0, weekReleased: 0, failed: 0 });
  assert.deepEqual(second, { bridged: 1, waiting: 0, weekReleased: 0, failed: 0 });
  assert.equal(review.byPersonDay.size, 1, "one weekly-review day, however often it runs");
  assert.equal(review.byPersonDay.get("PD-0101:2026-10-14")?.status, "field_review");
  assert.equal(review.byPersonDay.get("PD-0101:2026-10-14")?.days, 0.5);
  assert.equal(review.requests[0]?.allowInsert, true, "a field day in an open week is the bridge's to add");
  assert.equal(review.requests[0]?.value, 50, "the added day is priced as a deduction is: base salary ÷ the month's calendar days");
  assert.equal(ledger.writes(), 2, "the second run asks for the deduction again…");
  assert.equal(ledger.rows.size, 1, "…and the ledger still holds exactly one");
  const draft = [...ledger.rows.values()][0]!;
  assert.equal(draft.category, "field_review");
  assert.equal(draft.sourceSystem, HR_OPS_REPORT_SOURCE_SYSTEM);
  assert.equal(draft.sourceRecordId, "PD-0101:2026-10-14", "keyed exactly as every reader of a weekly-review day builds it");
  assert.equal(draft.unit, "days");
  assert.equal(draft.rawValue, 0.5);
  assert.equal(draft.estimatedAmount, 50);
  assert.deepEqual(draft.dates, ["2026-10-14"]);
  assert.equal(draft.monthKey, "2026-10");
  assert.doesNotMatch(JSON.stringify(draft.evidence), /b-10|B-10/, "the deduction's evidence names no HR code");

  // The draft is deterministic, so the ledger's candidate key is the same on every run.
  const again = buildReviewedDayDraft({ line: field, employeeHrId: "PD-0101", days: 0.5, amount: 50 });
  assert.deepEqual(again, draft);
}

async function aReleasedWeekIsNeverWritten() {
  const ledger = fakeLedger();
  const saved = new Map<string, SavedBridgeOutcome>();
  // 12 October is already released and answered (salary); 10 August is a week the review closed.
  const review = fakeReview([{ employeeHrId: "PD-0101", workDate: "2026-10-12", status: "late", days: 0.25, action: "salary" }]);
  const counts = await runHrOpsBridge(
    [
      line({ id: "released" }),
      line({ id: "closed", workDate: "2026-08-10", section: "field" }),
    ],
    deps({ saved, bridgeDay: review.bridgeDay, ensureCandidate: ledger.ensureCandidate }),
  );

  assert.deepEqual(counts, { bridged: 0, waiting: 0, weekReleased: 2, failed: 0 });
  assert.equal(review.byPersonDay.get("PD-0101:2026-10-12")?.days, 0.25, "a released day keeps what the employee answered");
  assert.equal(review.byPersonDay.size, 1, "nothing is added to a closed week");
  assert.equal(review.requests.find((request) => request.hrOpsLineId === "closed")?.allowInsert, false, "a closed week never takes a new day");
  assert.equal(ledger.writes(), 0, "a released week writes no deduction");
  assert.equal(saved.get("released")?.status, "week_released");
  assert.equal(saved.get("released")?.at, null, "bridged_at is only ever set on a day that reached the review");
  assert.equal(saved.get("closed")?.status, "week_released");
}

async function oneFailingDayLeavesEveryOtherDayCarried() {
  // The daily job already holds both office days, so each is the bridge's to set.
  const review = fakeReview([
    { employeeHrId: "PD-0101", workDate: "2026-10-13", status: "late", days: 0.25 },
    { employeeHrId: "PD-0101", workDate: "2026-10-14", status: "late", days: 0.25 },
  ]);
  const ledger = fakeLedger();
  const saved = new Map<string, SavedBridgeOutcome>();
  const counts = await runHrOpsBridge(
    [
      line({ id: "a", workDate: "2026-10-13" }),
      line({ id: "b", workDate: "2026-10-14" }),
      line({ id: "c", section: "field", workDate: "2026-10-15" }),
      // Recorded but never readable back: counted failed, and retried.
      line({ id: "d", hrId: "PD-0202", hrKey: "pd-0202", section: "field", workDate: "2026-10-16" }),
    ],
    deps({
      bridgeDay: async (request) => {
        if (request.hrOpsLineId === "b") throw new Error("could not serialize access due to concurrent update");
        return review.bridgeDay(request);
      },
      ensureCandidate: ledger.ensureCandidate,
      saveOutcome: async (lineId, outcome) => {
        if (lineId === "d") throw new Error("the line could not be saved");
        saved.set(lineId, outcome);
      },
    }),
  );

  assert.deepEqual(counts, { bridged: 2, waiting: 0, weekReleased: 0, failed: 2 });
  assert.equal(saved.get("a")?.status, "bridged");
  assert.equal(saved.get("c")?.status, "bridged");
  assert.equal(saved.get("b")?.status, "failed");
  assert.match(String(saved.get("b")?.message), /concurrent update/, "the failure is saved with its reason");
  assert.equal(saved.get("b")?.at, null);

  // A deduction that cannot be read back fails the day with its review day named, so a retry finds it.
  const unreadable = new Map<string, SavedBridgeOutcome>();
  const lost = await runHrOpsBridge(
    [line({ id: "e", section: "field", workDate: "2026-10-17" })],
    deps({
      saved: unreadable,
      bridgeDay: fakeReview().bridgeDay,
      ensureCandidate: async () => ({ candidateId: null, warnings: ["The deduction could not be read back."] }),
    }),
  );
  assert.deepEqual(lost, { bridged: 0, waiting: 0, weekReleased: 0, failed: 1 });
  assert.equal(unreadable.get("e")?.ref, "1");

  // A read the run shares fails only the days that need it: a salary list that cannot be read fails
  // the field day, which must be priced, and still carries the office day, which is never priced.
  const halfRead = new Map<string, SavedBridgeOutcome>();
  const partial = await runHrOpsBridge(
    [line({ id: "office" }), line({ id: "field", section: "field", workDate: "2026-10-13" })],
    deps({
      saved: halfRead,
      baseSalaries: async () => {
        throw new Error("the salary list was cut short");
      },
      bridgeDay: fakeReview([{ employeeHrId: "PD-0101", workDate: "2026-10-12", status: "late", days: 0.25 }]).bridgeDay,
      ensureCandidate: fakeLedger().ensureCandidate,
    }),
  );
  assert.deepEqual(partial, { bridged: 1, waiting: 0, weekReleased: 0, failed: 1 });
  assert.equal(halfRead.get("office")?.status, "bridged");
  assert.equal(halfRead.get("field")?.status, "failed");
  assert.match(String(halfRead.get("field")?.message), /^Nothing was written: the salary list could not be read \(the salary list was cut short\)/);

  // The review's settings cannot be read: every day fails with the reason, and is retried.
  const unsettled = new Map<string, SavedBridgeOutcome>();
  const noSettings = await runHrOpsBridge(
    [line({ id: "unsettled" })],
    deps({
      saved: unsettled,
      reviewLive: async () => {
        throw new Error("the settings table did not answer");
      },
    }),
  );
  assert.deepEqual(noSettings, { bridged: 0, waiting: 0, weekReleased: 0, failed: 1 });
  assert.match(String(unsettled.get("unsettled")?.message), /settings could not be read: the settings table did not answer/);

  // No base salary: nothing is written at all rather than a deduction with no amount.
  const unpriced = new Map<string, SavedBridgeOutcome>();
  const noSalary = await runHrOpsBridge(
    [line({ id: "unpriced", section: "field", hrId: "PD-0909", hrKey: "pd-0909" })],
    deps({ saved: unpriced }),
  );
  assert.deepEqual(noSalary, { bridged: 0, waiting: 0, weekReleased: 0, failed: 1 });
  assert.match(String(unpriced.get("unpriced")?.message), /^Nothing was written/);
}

async function whatWaitsAndWhatIsNotCarried() {
  const saved = new Map<string, SavedBridgeOutcome>();
  const review = fakeReview();
  const counts = await runHrOpsBridge(
    [
      // An office day the daily job has not added yet.
      line({ id: "not-yet" }),
      // Worked today: the review takes it tomorrow morning.
      line({ id: "today", section: "field", workDate: TODAY }),
      // A rejection, and an approval of zero days, deduct nothing.
      line({ id: "rejected", decision: "rejected", decidedDays: null }),
      line({ id: "zero", decidedDays: 0 }),
      // The owner took this person out of every automated deduction.
      line({ id: "exempt", hrId: "A-3", hrKey: "a-3" }),
    ],
    deps({ saved, bridgeDay: review.bridgeDay }),
  );
  assert.deepEqual(counts, { bridged: 0, waiting: 2, weekReleased: 0, failed: 0 });
  assert.equal(saved.get("not-yet")?.status, "waiting");
  assert.equal(saved.get("today")?.status, "waiting");
  assert.equal(saved.get("rejected")?.status, "not_needed");
  assert.equal(saved.get("zero")?.status, "not_needed");
  assert.equal(saved.get("exempt")?.status, "not_needed");
  assert.deepEqual(
    review.requests.map((request) => request.hrOpsLineId),
    ["not-yet"],
    "only the office day reached the review — and it was not allowed to add it",
  );
  assert.equal(review.requests[0]?.allowInsert, false);

  // A review that is switched off, or a trial, holds every day back.
  const off = new Map<string, SavedBridgeOutcome>();
  const offCounts = await runHrOpsBridge(
    [line({ id: "off" })],
    deps({ saved: off, reviewLive: async () => ({ live: false, why: "The weekly attendance review is running as a trial." }) }),
  );
  assert.deepEqual(offCounts, { bridged: 0, waiting: 1, weekReleased: 0, failed: 0 });
  assert.equal(off.get("off")?.message, "The weekly attendance review is running as a trial.");

  assert.deepEqual(await runHrOpsBridge([], deps()), { bridged: 0, waiting: 0, weekReleased: 0, failed: 0 });

  const week = reviewWeekForDay("2026-10-22");
  assert.deepEqual(week, { index: 4, startIso: "2026-10-22", endIso: "2026-10-31", monthKey: "2026-10" });
  assert.equal(reviewWeekForDay("2026-07-15"), null, "the weekly review starts in August 2026");
}

async function anOfficeRowTheReviewNeverHoldsIsNotCarried() {
  // Owner decision, 2026-10-20 ("Mark them not carried"): decided for the record, final at once.
  const review = fakeReview([{ employeeHrId: "PD-0101", workDate: "2026-10-12", status: "late", days: 0.25 }]);
  const saved = new Map<string, SavedBridgeOutcome>();
  let salaryReads = 0;
  const counts = await runHrOpsBridge(
    [
      // No fingerprint row at all: the review never lists a no-punch day.
      line({ id: "no-punch", workDate: "2026-10-13", flags: ["no_punch"], suggestedDays: null, decidedDays: 1 }),
      // A single punch the flexible-hours policy charges nothing.
      line({ id: "single", workDate: "2026-10-14", flags: ["single_punch"], suggestedDays: 0, decidedDays: 0.5 }),
      // Late, but the policy charged 0 days for it.
      line({ id: "late-zero", workDate: "2026-10-15", flags: ["late"], suggestedDays: 0, decidedDays: 0.25 }),
      // Late with a policy figure: the review holds it, and the approval IS carried.
      line({ id: "late-charged", workDate: "2026-10-12", flags: ["late"], suggestedDays: 0.25, decidedDays: 1 }),
    ],
    deps({
      saved,
      bridgeDay: review.bridgeDay,
      baseSalaries: async () => {
        salaryReads += 1;
        return new Map([["pd0101", 3100]]);
      },
      // ensureCandidate stays the throwing default: nothing is written for any of them.
    }),
  );

  assert.deepEqual(counts, { bridged: 1, waiting: 0, weekReleased: 0, failed: 0 }, "a not-carried row is in no bucket — it never waits");
  for (const id of ["no-punch", "single", "late-zero"]) {
    assert.equal(saved.get(id)?.status, "not_needed", `${id} is final at once`);
    assert.equal(saved.get(id)?.message, NOT_CARRIED_MESSAGE, `${id} says it is not carried, in full`);
    assert.equal(saved.get(id)?.ref, null);
    assert.equal(saved.get(id)?.at, null);
  }
  assert.deepEqual(
    review.requests.map((request) => request.hrOpsLineId),
    ["late-charged"],
    "a not-carried row never calls the weekly review — no RPC, nothing written",
  );
  assert.equal(salaryReads, 0, "and nothing is priced");
  assert.equal(saved.get("late-charged")?.status, "bridged");
  assert.equal(review.byPersonDay.get("PD-0101:2026-10-12")?.days, 1, "the late day the policy charged carries the decided days");
}

async function aFieldDayIsNeverChargedTwiceOrIntoAFinalMonth() {
  const field = (overrides: Partial<HrOpsBridgeLine> = {}) =>
    line({ section: "field", workDate: "2026-10-14", flags: ["no_field_activity"], suggestedDays: 1, decidedDays: 1, ...overrides });
  const crmOn = (dates: string[], decision: DayClaim["decision"] = null): DayClaim => ({ category: "crm", sourceSystem: "crm_visits_mirror", dates, decision });

  // The pure reading: a cleared deduction, an unticked day and another category charge nothing.
  assert.deepEqual(chargingCategories([crmOn(["2026-10-14"])], "2026-10-14"), ["crm"]);
  assert.deepEqual(chargingCategories([crmOn(["2026-10-14"], { decisionStatus: "Do Not Take Action" })], "2026-10-14"), []);
  assert.deepEqual(chargingCategories([crmOn(["2026-10-13", "2026-10-14"], { decisionStatus: "Pending", appliedDates: ["2026-10-13"] })], "2026-10-14"), []);
  assert.deepEqual(chargingCategories([crmOn(["2026-10-13"])], "2026-10-14"), []);
  assert.deepEqual(
    chargingCategories([{ category: "field_review", sourceSystem: "hr_ops_report", dates: ["2026-10-14"], decision: null }], "2026-10-14"),
    [],
    "the field day's own deduction is not a second claim on it",
  );
  assert.deepEqual(
    chargingCategories(
      [crmOn(["2026-10-14"]), { category: "fingerprint", sourceSystem: "fingerprint_report", dates: ["2026-10-14"], decision: null }],
      "2026-10-14",
    ),
    ["crm", "fingerprint"],
  );

  // A live CRM deduction already charges the day: nothing is written — no review day, no deduction.
  const claimed = new Map<string, SavedBridgeOutcome>();
  const claimedLedger = fakeLedger();
  const claimedReview = fakeReview();
  const claimedCounts = await runHrOpsBridge(
    [field({ id: "claimed" })],
    deps({
      saved: claimed,
      bridgeDay: claimedReview.bridgeDay,
      ensureCandidate: claimedLedger.ensureCandidate,
      dayClaims: async () => [crmOn(["2026-10-14"])],
    }),
  );
  assert.deepEqual(claimedCounts, { bridged: 0, waiting: 0, weekReleased: 0, failed: 1 });
  assert.equal(claimedReview.requests.length, 0, "the review is never called");
  assert.equal(claimedLedger.writes(), 0, "no deduction is written");
  assert.equal(claimed.get("claimed")?.ref, null);
  assert.match(String(claimed.get("claimed")?.message), /^Nothing was written: 14 October 2026 is already charged for this person by "/);
  assert.ok(String(claimed.get("claimed")?.message).includes(deductionsCategoryNames.crm), "the message names what charges the day");

  // The payroll month is already final: nothing is written either.
  const final = new Map<string, SavedBridgeOutcome>();
  const finalReview = fakeReview();
  let monthReads = 0;
  const finalCounts = await runHrOpsBridge(
    [field({ id: "final-a" }), field({ id: "final-b", workDate: "2026-10-15" })],
    deps({
      saved: final,
      bridgeDay: finalReview.bridgeDay,
      payrollMonthFinal: async (monthKey) => {
        monthReads += 1;
        assert.equal(monthKey, "2026-10");
        return true;
      },
    }),
  );
  assert.deepEqual(finalCounts, { bridged: 0, waiting: 0, weekReleased: 0, failed: 2 });
  assert.equal(finalReview.requests.length, 0);
  assert.equal(monthReads, 1, "a month is read once per run");
  assert.match(String(final.get("final-a")?.message), /^Nothing was written: October 2026 payroll is already final/);

  // A read that fails, fails the day — never a pass.
  for (const [id, override] of [
    ["claims-unread", { dayClaims: async () => { throw new Error("the deductions table did not answer"); } }],
    ["month-unread", { payrollMonthFinal: async () => { throw new Error("the payroll runs did not answer"); } }],
  ] as Array<[string, Partial<HrOpsBridgeDeps>]>) {
    const unread = new Map<string, SavedBridgeOutcome>();
    const unreadReview = fakeReview();
    const unreadCounts = await runHrOpsBridge([field({ id })], deps({ saved: unread, bridgeDay: unreadReview.bridgeDay, ...override }));
    assert.deepEqual(unreadCounts, { bridged: 0, waiting: 0, weekReleased: 0, failed: 1 }, id);
    assert.equal(unreadReview.requests.length, 0, `${id}: nothing is written on a check that did not run`);
    assert.match(String(unread.get(id)?.message), /^Nothing was written: .*could not be read \(the .* did not answer\)/, id);
  }

  // A cleared CRM deduction does not stop the day.
  const cleared = new Map<string, SavedBridgeOutcome>();
  const clearedLedger = fakeLedger();
  const clearedCounts = await runHrOpsBridge(
    [field({ id: "cleared" })],
    deps({
      saved: cleared,
      bridgeDay: fakeReview().bridgeDay,
      ensureCandidate: clearedLedger.ensureCandidate,
      dayClaims: async () => [crmOn(["2026-10-14"], { decisionStatus: "Do Not Take Action" })],
    }),
  );
  assert.deepEqual(clearedCounts, { bridged: 1, waiting: 0, weekReleased: 0, failed: 0 });
  assert.equal(clearedLedger.rows.size, 1);

  // The review already holds the day from an earlier run, in a week now closed: the same checks run
  // before its deduction is written.
  const late = new Map<string, SavedBridgeOutcome>();
  const lateLedger = fakeLedger();
  const lateReview = fakeReview([{ employeeHrId: "PD-0101", workDate: "2026-08-11", status: "field_review", days: 1 }]);
  const lateCounts = await runHrOpsBridge(
    [field({ id: "late-final", workDate: "2026-08-11" })],
    deps({
      saved: late,
      bridgeDay: lateReview.bridgeDay,
      ensureCandidate: lateLedger.ensureCandidate,
      payrollMonthFinal: async (monthKey) => monthKey === "2026-08",
    }),
  );
  assert.deepEqual(lateCounts, { bridged: 0, waiting: 0, weekReleased: 0, failed: 1 });
  assert.equal(lateReview.requests[0]?.allowInsert, false, "a closed week never takes a new day");
  assert.equal(lateLedger.writes(), 0, "no deduction is written into a final month");
  assert.equal(late.get("late-final")?.ref, "1", "the review day is named, so a retry finds it");
  assert.match(
    String(late.get("late-final")?.message),
    /^The day is in the weekly attendance review, but its deduction was not written: August 2026 payroll is already final/,
  );
}

async function aDecisionThatChangesWhileItIsCarriedIsNeverWritten() {
  // The database answered `superseded`: the report line's decision changed after the app read it.
  const expected: Array<string | null> = [];
  const logged: Array<{ message: string; labels: Record<string, string> }> = [];
  const counts = await runHrOpsBridge(
    [line({ id: "moved" })],
    deps({
      bridgeDay: async () => ({ outcome: "superseded" }),
      // The line now holds a newer decided_at, so a save on the one that was read matches no row.
      saveOutcome: async (_lineId, _outcome, read) => {
        expected.push(read.decidedAt);
        throw new Error("The report line changed while its day was being carried");
      },
      log: (message, _error, labels) => logged.push({ message, labels }),
    }),
  );
  assert.deepEqual(counts, { bridged: 0, waiting: 0, weekReleased: 0, failed: 1 });
  assert.deepEqual(expected, ["2026-10-19T19:30:00.000Z"], "the outcome is saved only on the decision that was carried");
  assert.equal(logged.length, 1, "a save that matches nothing is logged, never silent");
  assert.equal(logged[0]?.labels.event, "hr_ops_bridge_save_failed");
  assert.equal(logged[0]?.labels.outcome, "failed");

  // Saved where it does match, the outcome says what happened.
  const saved = new Map<string, SavedBridgeOutcome>();
  await runHrOpsBridge([line({ id: "moved" })], deps({ saved, bridgeDay: async () => ({ outcome: "superseded" }) }));
  assert.equal(saved.get("moved")?.status, "failed");
  assert.equal(saved.get("moved")?.ref, null);
  assert.match(String(saved.get("moved")?.message), /decision changed while it was being carried, so nothing was written/);
}

function theAnswerReachesTheRightDeduction() {
  assert.deepEqual(deductionSourceForDigestLine("field_review"), { category: "field_review", sourceSystem: "hr_ops_report" });
  for (const status of ["late", "short_hours", "early_leave", "missing_punch", null]) {
    assert.deepEqual(
      deductionSourceForDigestLine(status),
      { category: "fingerprint", sourceSystem: null },
      `a ${String(status)} day is looked up exactly as before — the Fingerprint connector's own deduction`,
    );
  }
  assert.equal(deductionCategoryForDigestLine("field_review"), "field_review");
  assert.equal(deductionCategoryForDigestLine("late"), "fingerprint");

  const read = (relative: string) => stripComments(readFileSync(path.join(process.cwd(), relative), "utf8"));
  const monthEnd = read("src/lib/attendance/digest-bridge.ts");
  assert.match(monthEnd, /\.eq\("category", target\.category\)/, "the month-end bridge applies an answer to that day's own category");
  assert.match(monthEnd, /if \(target\.sourceSystem\) candidateQuery = candidateQuery\.eq\("source_system", target\.sourceSystem\)/);
  const revision = read("src/lib/dispute-center/digest.ts");
  assert.match(revision, /deduction: deductionSourceForDigestLine\(/, "a revised dispute moves the same deduction the first answer did");
}

function theCategoryIsInEveryExhaustiveTable() {
  assert.ok(deductionsCategories.includes("field_review"));
  assert.ok(
    (visibleDeductionsCategories as readonly string[]).includes("field_review"),
    "a reviewed field day has its own tab — a hidden category goes unreviewed",
  );
  assert.equal(deductionsCategoryNames.field_review, "Field day — reviewed by HR");
  assert.equal(DEDUCTION_CATEGORY_LABELS.field_review, "Field day (reviewed)");
  const config = DEDUCTIONS_CATEGORY_CONFIG.field_review;
  assert.equal(config.category, "field_review");
  assert.equal(config.salaryRecordsColumn, "crm");
  assert.equal(config.requiresApproval, true);
  assert.equal(deductionsCategoryRequiresApproval("field_review"), true);
  assert.equal(salaryRecordsColumnForCategory("field_review"), "crm");
  for (const settled of [true, false]) {
    assert.deepEqual(payrollStepsForCategory("field_review", settled), payrollStepsForCategory("crm", settled), "it clears what a CRM day clears");
  }
  for (const status of ["Pending", "Disputed", "Needs Follow-up", "Do Not Take Action"]) {
    assert.equal(
      isEligibleForPublish({ category: "field_review", sourceSystem: "hr_ops_report", decision: { decisionStatus: status } }),
      false,
      `a reviewed field day at "${status}" never publishes — only the employee's answer, applied as "Approved for Payroll", does`,
    );
  }
  assert.equal(isEligibleForPublish({ category: "field_review", sourceSystem: "hr_ops_report", decision: { decisionStatus: "Approved for Payroll" } }), true);

  const read = (relative: string) => stripComments(readFileSync(path.join(process.cwd(), relative), "utf8"));
  const tables: Array<[string, RegExp]> = [
    ["src/lib/automated-payroll/deductions-source.ts", /case "field_review":\s*return "crm";/],
    ["src/lib/deductions/uncollected-leaver-deductions.ts", /field_review: "crm"/],
    ["src/lib/dispute-center/deduction.ts", /field_review: "/],
    ["src/components/attendance/weekly-attendance-review.tsx", /field_review: "/],
    ["src/components/employee-portal/weekly-digest-portal.tsx", /field_review: "/],
  ];
  for (const [file, pattern] of tables) assert.match(read(file), pattern, `${file} must name field_review`);
  const service = read("src/lib/deductions/service.ts");
  assert.match(
    service,
    /candidateRow\.category === "fingerprint" \|\| candidateRow\.category === "field_review"/,
    "approving a reviewed field day passes the same balance and cleared-day checks a fingerprint day does",
  );
}

function aSecondClaimOnAReviewedDayIsRefusedBeforePublish() {
  const claim = (category: "fingerprint" | "crm" | "field_review", sourceSystem: string) => ({
    employeeHrId: "PD-0101",
    employeeHrIdCompact: "pd0101",
    category,
    sourceSystem,
    dates: ["2026-10-14"],
  });
  const fieldVsCrm = findDayCollisions([claim("field_review", "hr_ops_report"), claim("crm", "crm_visits_mirror")]);
  assert.equal(fieldVsCrm.length, 1, "a reviewed field day and a CRM no-activity day on the same date is a collision");
  assert.deepEqual(fieldVsCrm[0]?.categories, ["crm", "field_review"]);
  const fieldVsFingerprint = findDayCollisions([claim("field_review", "hr_ops_report"), claim("fingerprint", "fingerprint_report")]);
  assert.equal(fieldVsFingerprint.length, 1, "a reviewed field day and the Fingerprint connector's day on one date are two claims");
  assert.deepEqual(fieldVsFingerprint[0]?.categories, ["field_review", "fingerprint"]);
  assert.deepEqual(fieldVsFingerprint[0]?.sourceSystems, ["fingerprint_report", "hr_ops_report"]);

  // …and the CRM connector never raises it in the first place.
  const crmDraft: DeductionsCandidateDraft = {
    category: "crm",
    sourceSystem: "crm_visits_mirror",
    sourceRecordId: "live_2026-10_pd0101",
    employeeHrId: "PD-0101",
    monthKey: "2026-10",
    month: 10,
    year: 2026,
    unit: "days",
    rawValue: 3,
    estimatedAmount: 300,
    calculationStatus: "calculated",
    evidence: {},
    dates: ["2026-10-13", "2026-10-14", "2026-10-15"],
  };
  const salaries = new Map([["pd0101", 3100]]);
  const trimmed = excludeFieldReviewClaimedDays(crmDraft, new Set(["pd0101:2026-10-14"]), salaries, "Medical Representative");
  assert.deepEqual(trimmed?.dates, ["2026-10-13", "2026-10-15"]);
  assert.equal(trimmed?.rawValue, 2);
  assert.deepEqual(trimmed?.evidence?.excludedFieldReviewDays, ["2026-10-14"]);
  assert.equal(
    excludeFieldReviewClaimedDays({ ...crmDraft, dates: ["2026-10-14"], rawValue: 1 }, new Set(["pd0101:2026-10-14"]), salaries, null),
    null,
    "a CRM draft whose every day is claimed is not raised",
  );
  assert.equal(excludeFieldReviewClaimedDays(crmDraft, new Set(["pd0202:2026-10-14"]), salaries, null), crmDraft, "another person's claim changes nothing");

  const connector = stripComments(readFileSync(path.join(process.cwd(), "src/lib/deductions/connectors/crm.ts"), "utf8"));
  assert.match(connector, /loadFieldReviewClaimedDays\(\{ month: input\.month, year: input\.year \}\)/, "the collector reads the claims");
  assert.match(connector, /excludeFieldReviewClaimedDays\(result, fieldReviewClaimed,/, "and applies them to every draft");
}

function theDailyJobNeverUndoesADecision() {
  const migration = stripSqlComments(
    readFileSync(path.join(process.cwd(), "supabase/migrations/20261020072217_hr_ops_bridge_field_review.sql"), "utf8"),
  );
  const fn = (name: string) => {
    const start = migration.indexOf(`create or replace function public.${name}(`);
    assert.ok(start >= 0, `the migration must define ${name}`);
    const end = migration.indexOf("\n$$;", start);
    assert.ok(end > start, `${name} must end`);
    return migration.slice(start, end);
  };

  assert.doesNotMatch(migration, /office_review/, "there is no office day kind of the bridge's own: an office day is the daily job's");
  assert.match(
    migration,
    /status = any \(array\['late', 'short_hours', 'early_leave', 'missing_punch', 'field_review'\]::text\[\]\)/,
    "the one new weekly-review day kind is field_review",
  );

  const sync = fn("phx_attendance_sync_digest_days");
  assert.match(
    sync,
    /if v_line\.hr_ops_line_id is not null or v_line\.status = 'field_review' then\s+continue;/,
    "the daily job never refreshes or overwrites a day the bridge wrote or set",
  );
  const clear = /delete from public\.attendance_digest_lines l[\s\S]*?returning 1/.exec(sync)?.[0] ?? "";
  assert.match(
    clear,
    /and l\.hr_ops_line_id is null and l\.status <> 'field_review'/,
    "a day the report later clears is removed only when the bridge did not write or set it",
  );

  const settle = fn("phx_attendance_settle_digest_line");
  assert.match(settle, /c\.category = case when v_line\.status = 'field_review' then 'field_review' else 'fingerprint' end/);

  // A production apply that meets a running cron fails fast and rolls back instead of queueing readers.
  assert.match(migration, /begin;\s+set local lock_timeout = '10s';/, "the lock timeout is set first thing in the transaction");

  const bridge = fn("phx_hr_ops_bridge_digest_day");
  assert.match(bridge, /security definer/);
  // The report line is locked FIRST, and the decision re-checked under that lock.
  const lineLock = bridge.indexOf("select * into v_report_line from public.hr_ops_report_lines where id = p_hr_ops_line_id for update;");
  assert.ok(lineLock > 0, "the report line is locked FOR UPDATE");
  assert.ok(lineLock < bridge.indexOf("pg_advisory_xact_lock"), "before the employee-week lock, so the lock order never cycles");
  assert.match(bridge, /v_report_line\.decision is distinct from 'approved'/);
  assert.match(bridge, /round\(v_report_line\.decided_days, 3\) is distinct from v_days/, "the days carried are the days decided");
  assert.match(bridge, /v_report_line\.decided_at is distinct from p_decided_at/, "and only the decision that was sent");
  assert.match(bridge, /return jsonb_build_object\('outcome', 'superseded'\);/, "a changed decision writes nothing");
  assert.equal(
    bridge.match(/update public\.hr_ops_report_lines set bridge_ref = v_line\.id::text, updated_at = now\(\)/g)?.length,
    3,
    "every bridged path writes the report line's bridge_ref in the same transaction",
  );
  assert.match(bridge, /perform public\.phx_attendance_mark_digest_line\(v_line\.id, true, v_days, v_actor\);/, "an existing day is set through the tick path");
  assert.match(bridge, /'outcome', 'week_released'/);
  assert.match(
    bridge,
    /if p_section <> 'field' or not p_allow_insert then[\s\S]*?return jsonb_build_object\('outcome', 'waiting'\);\s*end if;/,
    "with no day yet, an office day returns before anything is written — the database never adds one",
  );
  assert.match(
    migration,
    /revoke execute on function public\.phx_hr_ops_bridge_digest_day\([^)]*\) from public, anon, authenticated;/,
  );
  assert.match(migration, /grant execute on function public\.phx_hr_ops_bridge_digest_day\([^)]*\) to service_role;/);
  assert.match(migration, /attendance_digest_lines_hr_ops_line_idx\s+on public\.attendance_digest_lines \(hr_ops_line_id\)/, "one review day per decision");
  assert.match(migration, /values \('field_review', 'Field Day \(Reviewed\)', 'hr_ops_report', true, 'crm', 10\)/);

  // The app sends exactly the parameters the function declares, by name.
  const declared = [...(/phx_hr_ops_bridge_digest_day\(([\s\S]*?)\) returns jsonb/.exec(migration)?.[1] ?? "").matchAll(/(p_[a-z_]+)\s+[a-z]/g)]
    .map((match) => match[1])
    .sort();
  const app = stripComments(readFileSync(path.join(process.cwd(), "src/lib/hr-ops-reports/bridge.ts"), "utf8"));
  const call = /rpc\("phx_hr_ops_bridge_digest_day", \{([\s\S]*?)\}\);/.exec(app)?.[1] ?? "";
  const sent = [...call.matchAll(/(p_[a-z_]+):/g)].map((match) => match[1]).sort();
  assert.equal(declared.length, 15, "the parser, not the function, is wrong if this is not fifteen");
  assert.deepEqual(sent, declared);

  // A report line is written back only while it is still on its way, only on the decision that was
  // carried, a save that matches nothing throws (and is logged), and a null ref never erases one.
  assert.match(app, /\.in\("bridge_status", \["waiting", "failed"\]\)/);
  assert.match(app, /query\.is\("decided_at", null\) : query\.eq\("decided_at", expected\.decidedAt\)/);
  assert.match(app, /if \(!data \|\| data\.length === 0\) \{\s*throw new Error\(/);
  assert.match(app, /if \(outcome\.ref !== null\) patch\.bridge_ref = outcome\.ref;/);
  assert.match(app, /deps\.saveOutcome\(line\.id, saved, \{ decidedAt: line\.decidedAt \}\)/);
  assert.match(app, /case "superseded":\s*return \{ outcome: "superseded" \};/, "the app knows the database's superseded answer");
  assert.match(app, /readLines\(\{ reportId, statuses: \["waiting"\] \}\)/, "a decided report carries its waiting days");
  assert.match(app, /readLines\(\{ statuses: \["waiting", "failed"\] \}\)/, "the retry carries every waiting and failed day");
}

export async function runHrOpsReportsBridgeTests(): Promise<void> {
  await anOfficeApprovalSetsTheReviewsOwnDay();
  await anOfficeDayTheReviewDoesNotHoldYetWritesNothingAndWaits();
  await aFieldApprovalIsOneDayAndOneDeductionHoweverOftenItRuns();
  await aReleasedWeekIsNeverWritten();
  await oneFailingDayLeavesEveryOtherDayCarried();
  await whatWaitsAndWhatIsNotCarried();
  await anOfficeRowTheReviewNeverHoldsIsNotCarried();
  await aFieldDayIsNeverChargedTwiceOrIntoAFinalMonth();
  await aDecisionThatChangesWhileItIsCarriedIsNeverWritten();
  theAnswerReachesTheRightDeduction();
  theCategoryIsInEveryExhaustiveTable();
  aSecondClaimOnAReviewedDayIsRefusedBeforePublish();
  theDailyJobNeverUndoesADecision();
}
