import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDisputeBasis,
  buildDisputeFacts,
  disputeDateLabel,
  type DisputeCandidateRow,
  type DisputeDecisionRow,
} from "../src/lib/deductions/dispute-basis.ts";
import { resolveConversationAudience } from "../src/lib/conversations/notify.ts";
import type { DeductionsPortalLine } from "../src/lib/deductions/types.ts";

/**
 * The Disputes inbox's case file and the reply's audience (owner, 2026-10-08).
 *
 * The owner asked that the person answering a dispute see WHY the deduction was made without leaving
 * the tab, in detail, and that a reply reach the employee and be copied to their managers by email,
 * Telegram and in-app. The samples below are the real September 2026 rows from production for the
 * two open disputes (a district manager's no-record days and a rep's mixed vacation/work day), so the
 * test pins what the owner will actually read.
 */

function line(overrides: Partial<DeductionsPortalLine> = {}): DeductionsPortalLine {
  return {
    id: "line-1",
    summaryId: "pub-1",
    candidateId: "cand-1",
    decisionId: "dec-1",
    employeeCode: "B-76",
    employeeHrIdCompact: "b76",
    employeeName: "Salim Salim Abdo Ibrahim Gomaa",
    monthKey: "2026-09",
    sourceModule: "DEDUCTIONS_MODULE",
    deductionType: "crm",
    payrollColumn: "crm",
    deductionUnit: "days",
    originalDeductionValue: 3,
    appliedDeductionValue: 3,
    appliedAmount: 2800,
    dates: ["2026-09-07", "2026-09-13", "2026-09-23"],
    reason: null,
    hrNote: null,
    createdAt: "2026-10-06T01:04:13.000Z",
    ...overrides,
  };
}

const dsmCandidate: DisputeCandidateRow = {
  id: "cand-1",
  category: "crm",
  source_system: "dsm_no_record",
  unit: "days",
  raw_value: "3.00",
  estimated_amount: "2800.00",
  calculation_status: "calculated",
  severity: "High",
  reason: "No CRM record on 3 working day(s) — a district manager's double visits are logged when the rep submits",
  evidence: {
    rule: "District sales managers are recorded on CRM through the rep's double visit; a working day with neither a DV tag nor an own-agent visit is a no-record day.",
    missingDays: ["2026-09-07", "2026-09-13", "2026-09-23"],
    holidaysExcluded: [],
    suspectDatesExcluded: [],
    deductionDaysWeighted: 3,
    workingDaysConsidered: 26,
  },
  dates: ["2026-09-07", "2026-09-13", "2026-09-23"],
};

const approved: DisputeDecisionRow = {
  candidate_id: "cand-1",
  decision_status: "Approved for Payroll",
  decision_reason: "Approved for payroll after review (2026-09)",
  hr_note: "",
  applied_value: null,
  applied_amount: null,
  applied_dates: null,
  decided_by: "b-10",
  decided_at: "2026-10-06T01:00:00.000Z",
};

const names = new Map([["b-10", "Omar Gawish"]]);
const nameFor = (hrId: string | null | undefined) => names.get(String(hrId ?? "").toLowerCase()) ?? null;

export function runDeductionsDisputeBasisTests() {
  // 1. A district manager's no-record days: the reason, the rule the CHECK wrote, the days, the
  //    rate worked out from amount ÷ days, and the decision with the NAME of who made it.
  {
    const basis = buildDisputeBasis({
      candidate: dsmCandidate,
      decision: approved,
      line: line(),
      lineExtra: { candidate_id: "cand-1", pushed_at: "2026-10-06T01:04:13.000Z", pushed_by: "b-10" },
      nameFor,
    });
    assert.equal(basis.detectedBy, "District manager CRM record");
    assert.match(basis.explanation, /recorded on CRM through the rep's double visit/, "the check's own rule sentence wins over the generic one");
    assert.match(basis.reason ?? "", /^No CRM record on 3 working day/);
    assert.equal(basis.severity, "High");
    assert.equal(basis.needsReview, false);
    assert.deepEqual(basis.detectedDates, ["2026-09-07", "2026-09-13", "2026-09-23"]);
    assert.equal(basis.detectedValue, 3);
    assert.equal(basis.estimatedAmount, 2800);
    assert.equal(basis.ratePerUnit, 933.33, "rate per day = 2,800.00 ÷ 3 days");
    assert.equal(basis.rateBasis, "Base salary ÷ the actual calendar days of the month");
    assert.equal(basis.chargedAmount, 2800);
    assert.deepEqual(
      basis.facts.map((fact) => `${fact.label}: ${fact.value}`),
      ["Working days checked in the month: 26", "Days charged: 3"],
      "empty lists (no holidays, no suspect days) add no row",
    );
    assert.equal(basis.decision?.status, "Approved for Payroll");
    assert.equal(basis.decision?.decidedByName, "Omar Gawish", "the decider is a NAME, never an HR id");
    assert.equal(basis.pushedByName, "Omar Gawish");
    assert.equal(basis.decision?.appliedDates, null, "null = HR never narrowed the days");
  }

  // 2. A rep's mixed vacation/work day: the unpaid reason is explained in words, and the
  //    "vacation and work on the same day" flag reads as the review prompt it is.
  {
    const candidate: DisputeCandidateRow = {
      id: "cand-2",
      category: "unpaid_vacation",
      source_system: "crm_vacation_signal",
      unit: "days",
      raw_value: "1.00",
      estimated_amount: "466.67",
      calculation_status: "requires_review",
      severity: "Review",
      reason: "REVIEW: vacation AND work recorded on the same day (leave AM, work AM/PM) — confirm full day, AM or PM before deducting",
      evidence: {
        source: "ireports360 visit_type -4 (Annual Vacation)",
        hireDate: "2026-08-17",
        mixedDay: true,
        workAmpm: ["AM", "PM"],
        periodEnd: "2027-08-17",
        periodStart: "2026-08-17",
        unpaidReason: "first_six_months",
        vacationAmpm: ["AM"],
        entitlementDays: 1.25,
        balanceBeforeDays: 0,
      },
      dates: ["2026-09-01"],
    };
    const basis = buildDisputeBasis({
      candidate,
      decision: { ...approved, candidate_id: "cand-2" },
      line: line({ appliedAmount: 466.67, employeeName: "Mohamed Khaled Abdullah Ahmed" }),
      lineExtra: null,
      nameFor,
    });
    assert.equal(basis.needsReview, true);
    assert.equal(basis.detectedBy, "CRM vacation record against the leave balance");
    const facts = new Map(basis.facts.map((fact) => [fact.label, fact.value]));
    assert.match(facts.get("Why the vacation is unpaid") ?? "", /first six months of service/);
    assert.equal(facts.get("Hire date"), "17 Aug 2026");
    assert.equal(facts.get("Part of the day on vacation"), "AM");
    assert.equal(facts.get("Part of the day with work recorded"), "AM, PM");
    assert.match(facts.get("Vacation and work on the same day") ?? "", /^Yes/);
    assert.equal(basis.ratePerUnit, 466.67);
    assert.equal(basis.pushedByName, null, "no push row = no pusher named");
  }

  // 3. A fingerprint day: the absences the reader needs to SEE are written out ("None on record"),
  //    not dropped as empty strings.
  {
    const facts = buildDisputeFacts("fingerprint_report", {
      status: "Late",
      jobTitle: "Product Manager",
      department: "Marketing",
      weeklyPlan: "Field",
      crmActivity: "",
      lateMinutes: "58",
      deviceUserId: "34",
      approvedLeave: "",
      approvedExcuse: "",
      actualLastPunch: "5:42 PM",
      actualFirstPunch: "10:28 AM",
      earlyLeaveMinutes: "",
    });
    const byLabel = new Map(facts.map((fact) => [fact.label, fact.value]));
    assert.equal(byLabel.get("Approved leave that day"), "None on record");
    assert.equal(byLabel.get("Approved excuse that day"), "None on record");
    assert.equal(byLabel.get("CRM activity that day"), "None on record");
    assert.equal(byLabel.get("First fingerprint of the day"), "10:28 AM");
    assert.equal(byLabel.get("Arrived late by (minutes)"), "58");
    assert.ok(!byLabel.has("Left early by (minutes)"), "a blank value with no whenEmpty text adds no row");
    assert.ok(![...byLabel.keys()].some((label) => /device/i.test(label)), "the device user id is provenance, not a fact");
  }

  // 4. 🔴 NO CODE EVER REACHES A FACT. The CRM no-activity evidence carries a recommendationKey with
  //    the employee's HR id in it; it must never be printed. Facts come from a whitelist.
  {
    const facts = buildDisputeFacts("crm_visits_mirror", {
      recommendationKey: "payroll_deduction:no_activity_candidate:AI-0002:2026-09-08_2026-09-16",
      recommendationReason: "N means no activity candidate only.",
      existingCoverageStatus: "payroll_calculation_required",
    });
    assert.deepEqual(facts, [], "an unknown or identifier-bearing key is left out, never printed");
    assert.deepEqual(buildDisputeFacts("a_source_nobody_wrote_down", { anything: "x" }), []);
    assert.deepEqual(buildDisputeFacts("fingerprint_report", null), []);
  }

  // 5. A narrowed decision keeps the exact days HR charged, so the screen can strike the rest.
  {
    const basis = buildDisputeBasis({
      candidate: dsmCandidate,
      decision: { ...approved, applied_dates: ["2026-09-07"], applied_amount: "933.33", applied_value: "1.00" },
      line: line({ appliedAmount: 933.33, appliedDeductionValue: 1 }),
      lineExtra: null,
      nameFor,
    });
    assert.deepEqual(basis.decision?.appliedDates, ["2026-09-07"]);
    assert.equal(basis.chargedAmount, 933.33);
    assert.equal(basis.estimatedAmount, 2800, "the calculated amount stays visible beside what HR charged");
  }

  // 6. An amount-unit deduction (a loan, a manual entry) has no per-day rate to invent.
  {
    const basis = buildDisputeBasis({
      candidate: { ...dsmCandidate, source_system: "manual_hr", unit: "amount", raw_value: "500.00", estimated_amount: "500.00", evidence: { enteredBy: "b-10" } },
      decision: null,
      line: line({ appliedAmount: 500 }),
      lineExtra: null,
      nameFor,
    });
    assert.equal(basis.ratePerUnit, null);
    assert.equal(basis.rateBasis, null);
    assert.equal(basis.detectedBy, "Entered by hand by HR");
    assert.deepEqual(basis.facts, [], "who typed it is an id, not a fact");
    assert.equal(basis.decision, null);
  }

  // 7. Dates read off the string, never through a zone.
  assert.equal(disputeDateLabel("2026-09-07"), "7 Sept 2026");
  assert.equal(disputeDateLabel("2026-01-31"), "31 Jan 2026");
  assert.equal(disputeDateLabel("not a date"), "not a date");

  // 8. THE REPLY'S AUDIENCE. Employee = To; the sender and the managers = CC; the managers also get
  //    their own in-app/Telegram/push notice (they are participants), the sender does not notify
  //    himself. This is the addressing function the reply goes through.
  {
    const { ccKeys, notifyKeys } = resolveConversationAudience({
      authorHrId: "B-10",
      participantHrIds: ["B-76", "B-10", "AI-0008", "AA"],
      submitterHrId: "B-76",
    });
    assert.deepEqual(notifyKeys, ["B-76", "AI-0008", "AA"], "the employee first (the email's To), then each manager; never the author");
    assert.deepEqual(ccKeys, ["B-10", "AI-0008", "AA"], "the sender and the managers ride the email's cc line");
  }

  // 9. The wiring, as source contracts (each is a decision of the owner's, 2026-10-08).
  {
    const comments = readFileSync(new URL("../src/lib/deductions/comments.ts", import.meta.url), "utf8");
    assert.match(
      comments,
      /participantHrIds: \[employeeHrId, input\.authorHrId, \.\.\.managerHrIds\]/,
      "a reply must carry the employee's managers as participants — that is what copies them",
    );
    assert.match(comments, /resolveDisputeAudience\(employeeHrId\)/, "the reply is addressed through the shared audience lookup");
    assert.match(comments, /loadTelegramReach\(/, "the sender is told whether Telegram can reach each person");
    assert.match(
      comments,
      /export async function addDeductionsReply[\s\S]*?Promise<\{ comment: DeductionsComment; delivery: DeductionDisputeDelivery \| null \}>/,
      "addDeductionsReply returns the delivery recap as well as the comment",
    );

    const audience = readFileSync(new URL("../src/lib/deductions/dispute-audience.ts", import.meta.url), "utf8");
    assert.match(audience, /DISPUTE_REPLY_MANAGER_LEVELS = 2/, "the direct manager and the one above (owner's answer, 2026-10-08)");
    assert.match(audience, /manager_hr_id/, "the chain is employees.manager_hr_id, the same walk the notification policy uses");
    assert.match(audience, /isActive\(manager\)/, "a departed manager is never copied");

    const route = readFileSync(new URL("../app/api/admin/deductions/comments/route.ts", import.meta.url), "utf8");
    assert.match(route, /const \{ comment, delivery \} = await addDeductionsReply\(/);
    assert.match(route, /NextResponse\.json\(\{ success: true, comment, delivery \}\)/, "the route hands the recap to the screen");

    const portal = readFileSync(new URL("../src/lib/deductions/portal.ts", import.meta.url), "utf8");
    assert.match(portal, /return attachDisputeDetail\(threads\)/, "every thread the inbox lists carries its case file and its audience");

    const tab = readFileSync(new URL("../src/components/admin/deductions-disputes-tab.tsx", import.meta.url), "utf8");
    assert.match(tab, /Evidence the check recorded/, "the evidence section is on the screen");
    assert.match(tab, /The decision on record/, "the decision section is on the screen");
    assert.match(tab, /How the amount is worked out/, "the arithmetic is on the screen");
    assert.match(tab, /<AudienceLine thread=\{thread\} \/>/, "the To and CC are shown before the reply is sent");
    assert.match(tab, /<ChannelRecap delivery=\{delivery\} \/>/, "what the reply did is shown after it is sent");
    assert.doesNotMatch(tab, /rounded-/, "square edges: no rounded class in the Disputes tab");
    assert.doesNotMatch(tab, /overflow-x-auto|min-w-\[/, "no horizontal scroll: nothing in the tab scrolls sideways");
  }
}
