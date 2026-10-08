import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { isEligibleForPublish } from "../src/lib/deductions/calculations.ts";
import { DEDUCTION_COLLECTORS, isDeductionCollectorKey } from "../src/lib/deductions/collect.ts";
import { combineLeaveParts, fullDayCheckLeaveVerdict, judgeHalfDay, leavePartOf } from "../src/lib/deductions/half-day-rule.ts";
import { sumDetectedDeductionDayWeights } from "../src/lib/field-workforce-compliance/weekend-policy.ts";

// The DSM no-record rule reverses a documented exclusion that once cost
// 131,741.94 EGP in wrong deductions, so its guards are asserted as WIRING:
// the behaviour itself is DB-bound (roster + CRM feed + ledger) and cannot be
// unit-tested without a live client, which this repo's runner cannot host — see
// scripts/check-deductions-write-contract.ts for why. What CAN be pinned is
// that each guard is present and that the rule stayed narrow.

export async function runDeductionsDsmNoRecordTests(): Promise<void> {
  const source = readFileSync("src/lib/deductions/connectors/dsm-no-record.ts", "utf8");

  // Executable lines only. This file DOCUMENTS at length why Product Managers,
  // National Sales Managers and logsOwnCrmVisitsTitle stay out of scope — so any
  // "must not mention X" assertion run against the raw text fails on the very
  // comment that explains the safeguard. Assert against the code.
  const code = stripComments(source);

  // ── The rule must stay narrow ────────────────────────────────────────────
  // eligibility.ts excludes managers from CRM no-activity because a Product
  // Manager and a National Sales Manager were charged for days they had clocked
  // in. The owner's exception is DSMs specifically — their double visits ARE
  // logged when the rep submits. Widening this to "manager" would walk straight
  // back into the incident.
  {
    assert.match(
      source,
      /district\\s\+\(sales\\s\+\)\?manager/i,
      "the roster filter must match DISTRICT sales managers specifically",
    );
    for (const outOfScope of ["product manager", "national sales manager", "regional"]) {
      assert.doesNotMatch(
        code,
        new RegExp(outOfScope, "i"),
        `${outOfScope} must never be pulled into scope — that population is what the 131,741.94 EGP incident was made of`,
      );
    }
  }

  // ── It must not widen the shared rep predicate ───────────────────────────
  // Editing logsOwnCrmVisitsTitle would silently re-scope every consumer of it.
  // This rule lives in its own file precisely so deleting the file removes it.
  {
    assert.doesNotMatch(
      code,
      /logsOwnCrmVisitsTitle/,
      "the DSM rule must NOT reach into the reps' eligibility predicate — a separate connector is what keeps the rep pipeline untouched",
    );
    const eligibility = readFileSync("src/lib/field-workforce-compliance/eligibility.ts", "utf8");
    assert.match(
      eligibility,
      /OWN_CRM_VISIT_LOGGER_TITLES = new Set<string>\(\[\s*"medical representative",\s*"medical rep",\s*"employee medical rep",\s*\]\)/,
      "the reps-only predicate must stay reps-only; the DSM exception is implemented elsewhere",
    );
  }

  // ── The five guards that keep a gap from becoming a wrong deduction ──────
  {
    assert.match(
      source,
      /employment_status", "active"/,
      "only ACTIVE managers — resigned and historical records have no records because they no longer work here",
    );
    assert.match(
      source,
      /if \(!anySignal\.has\(compact\)\) continue;/,
      "zero CRM signal for a whole month is a mapping gap, not a month of absence",
    );
    assert.match(
      source,
      /if \(manager\.hireDate && day < manager\.hireDate\) return false;/,
      "a day before the person was hired must never be charged",
    );
    assert.match(
      source,
      /if \(claimed\.has\(`\$\{compact\}:\$\{day\}`\)\) return false;/,
      "a day another category already charges must never be charged again",
    );
  }

  // ── The coverage guard ───────────────────────────────────────────────────
  // The whole rule rests on "a DSM's double visits are logged when the rep
  // submits". That is only true while every rep the manager could ride along
  // with is actually known to CRM. Momen Abdelhady had 1 of 3 active reps with
  // no CRM identity at all and was charged 12 days / 8,709.68 EGP for July 2026
  // — 38.7% of base, against a next-worst of 5 days in the whole role. Without
  // this guard the rule bills a manager for their own team's incomplete setup.
  {
    assert.match(
      code,
      /manager_hr_id/,
      "the roster query must load manager_hr_id — without it the connector cannot tell which reps a manager could have doubled with",
    );
    assert.match(
      code,
      /getMappedAgentHrIds/,
      "rep CRM-mapping must be resolved from the FEED (getMappedAgentHrIds), never from employees.crm_id — that column is stale on reused CRM logins and points at resigned people",
    );
    assert.match(
      code,
      /if \(reps\.length === 0 \|\| !everyRepIsMapped\) continue;/,
      "a DSM whose team is not fully mapped into CRM must be SKIPPED — their no-record days measure the onboarding gap, not absence",
    );

    // The mapping question must be asked AS OF THE MONTH, never "ever". Candidates
    // are re-collected repeatedly (July 2026 already has ten superseded
    // generations), so an unbounded check lets a later onboarding rewrite an
    // earlier month: the day Mahmoud Abdelreheem is coded onto CRM, a re-run of
    // July would find Momen's team complete and bill him the 12 days this guard
    // exists to prevent.
    assert.match(
      code,
      /notAfterDate: monthEnd/,
      "rep CRM-mapping must be evaluated as of the collected month's end — an unbounded check lets a LATER onboarding retroactively make an EARLIER month chargeable",
    );
    assert.match(
      code,
      /const monthEnd = allMonthDays\[allMonthDays\.length - 1\]!/,
      "the bound must be the last CALENDAR day, not the last working day — reps do log Friday/holiday visits",
    );
  }

  // ── An approved absence must never be charged as an absence ──────────────
  // `claimed` only skips days another DEDUCTION already bills, and an approved
  // PAID leave day is not a deduction, so it never lands there. In July 2026
  // five DSMs held 12 approved paid leave days and none was charged — but only
  // because each of those days happened to carry CRM activity anyway.
  {
    assert.match(
      code,
      /\.eq\("status", "approved"\)/,
      "leave must be read from APPROVED requests only — a pending or rejected request is not permission to be away",
    );
    assert.match(
      code,
      /const leave = fullDayCheckLeaveVerdict\(leaveDays\.get\(`\$\{compact\}:\$\{day\}`\), day\);\s*if \(leave === "cleared"\) return false;/,
      "a day the company approved the manager to be away must never be charged as a no-record day",
    );
    // A half-day vacation clears only its half (owner, 2026-10-08). The other half is owed, and it
    // is the Half Day (CRM) tab's: never on this row, whose dates payroll weighs as whole days.
    assert.match(
      code,
      /\.select\("employee_hr_id, start_date, end_date, day_part"\)/,
      "the leave read must carry the day part, or every half-day request reads as a whole day off",
    );
    assert.match(
      code,
      /if \(leave === "half_day"\) \{\s*halfDayLeaveDates\.push\(day\);\s*return false;\s*\}/,
      "a Saturday-to-Wednesday half-day vacation must leave this row and go to the Half Day (CRM) tab — on this row payroll would bill the half as a whole day",
    );
    assert.match(code, /halfDayVacationDatesOnTheHalfDayTab: halfDayLeaveDates/, "the hand-off is written on the row's evidence");

    const SAT = "2026-10-03";
    const TUE = "2026-08-04";
    const THU = "2026-09-17";
    assert.equal(fullDayCheckLeaveVerdict(undefined, TUE), "judge", "no leave: the day is judged");
    assert.equal(fullDayCheckLeaveVerdict("full_day", TUE), "cleared", "a full day off clears the day");
    assert.equal(fullDayCheckLeaveVerdict("pm_only", TUE), "half_day", "an afternoon off on a Tuesday leaves the morning owed");
    assert.equal(fullDayCheckLeaveVerdict("am_only", SAT), "half_day", "a morning off on a Saturday leaves the afternoon owed");
    assert.equal(fullDayCheckLeaveVerdict("am_only", THU), "cleared", "a Thursday morning off clears the Thursday — it is a morning-only day");
    assert.equal(fullDayCheckLeaveVerdict("pm_only", THU), "judge", "a Thursday afternoon off covers no field hour, so the Thursday is judged and its morning charged at the Thursday half");

    assert.equal(leavePartOf("AM_ONLY "), "am_only");
    assert.equal(leavePartOf("pm_only"), "pm_only");
    assert.equal(leavePartOf(null), "full_day", "a request with no day part is a whole day — the vacation module's own default");
    assert.equal(leavePartOf("half"), "full_day", "an unknown part is read as the whole day, never as no leave");
    assert.equal(combineLeaveParts(undefined, "am_only"), "am_only");
    assert.equal(combineLeaveParts("am_only", "am_only"), "am_only");
    assert.equal(combineLeaveParts("am_only", "pm_only"), "full_day", "a morning off and an afternoon off on one day is the day off");
    assert.equal(combineLeaveParts("full_day", "pm_only"), "full_day");

    // Why the half cannot ride on this row: payroll weighs a CRM row's dates, and only a Thursday is half.
    assert.equal(sumDetectedDeductionDayWeights([TUE]), 1, "on a CRM row a Tuesday weighs a whole day");
    // And where it lands instead: the Half Day (CRM) rule charges exactly that half.
    assert.deepEqual(
      judgeHalfDay(undefined, { vacationPm: true }),
      { kind: "half_day", missing: "AM", coveredBy: ["approved_vacation"] },
      "an afternoon off with nothing in the morning is a Half Day (CRM) row for the morning",
    );
    assert.deepEqual(
      judgeHalfDay(undefined, { vacationAm: true }),
      { kind: "half_day", missing: "PM", coveredBy: ["approved_vacation"] },
      "a morning off with nothing in the afternoon is a Half Day (CRM) row for the afternoon",
    );
    // Deliberately unfiltered by type/payment status: the question is whether the
    // company agreed the person was away, not whether it paid for it.
    assert.doesNotMatch(
      code,
      /payment_status/,
      "approved leave must count regardless of payment status — an approved UNPAID day is already charged by the vacation connector, and billing it twice is what the never-the-same-day-twice rule forbids",
    );
  }

  // ── employees.crm_id must never become the mapping source ────────────────
  // Verified in production 2026-08-04: on 3 reused CRM logins that column names
  // a RESIGNED person while the feed resolves the current holder correctly
  // (1391 Soad Atef vs Tayseer Khaled, 1399 Mohamed Yasser vs Nada Elsharkawy,
  // 1536 Essam Youssef vs Mayar Tarek). Joining on it silently attributes a
  // working rep's activity to a leaver.
  {
    assert.doesNotMatch(
      code,
      /crm_id/,
      "this connector must resolve people through the feed's own agent_hr_id/double_hr_id, never by joining employees.crm_id",
    );
  }

  // ── Holidays and Fridays are not working days ────────────────────────────
  // Without this, 12 of 18 managers would have been charged for 2 July and 11
  // for 23 July — both national holidays that nobody worked.
  {
    assert.match(
      source,
      /isFieldForceWorkingDay\(day\) && !holidays\.has\(day\)/,
      "working days must exclude BOTH Friday and national holidays",
    );
    assert.match(
      source,
      /calendarReachable/,
      "an unreadable holiday calendar must refuse, not silently charge public holidays",
    );
  }

  // ── A company-wide CRM data-gap day is not a manager's absence ────────────
  // A sync outage depresses EVERY agent's day, so charging through one bills the
  // whole role for a feed problem. The rep pipeline already drops these; this path
  // did not, so it must reuse the SAME detector (both agree, and both fail closed
  // on a CRM outage rather than charging through it).
  {
    assert.match(
      code,
      /getSuspectDatesForMonth\(input\.month, input\.year\)/,
      "company-wide CRM data-gap days must be found with the rep pipeline's own detector, so the two paths cannot disagree and both fail closed on a CRM outage",
    );
    assert.match(
      code,
      /!suspectDates\.has\(day\)/,
      "a suspect (data-gap) day must be dropped from the working-day set before any manager is charged for it",
    );
  }

  // ── Thursday is a HALF working day, not a full one ────────────────────────
  // Owner rule 2026-08-02: the field-force week is Sat–Wed full, Thursday morning
  // only, Friday off — and a district manager is a Friday-only title the rule
  // covers. The rep pipeline charges a no-record Thursday at 0.5; this path billed
  // a FULL day. The money must come off the weighted count while the reported day
  // count stays the real number of flagged days.
  {
    assert.match(
      code,
      /sumDetectedDeductionDayWeights\(missing\)/,
      "the charged amount must use the Thursday-weighted day count (Thursday = 0.5), matching how the rep pipeline already treats a no-record Thursday",
    );
    assert.match(
      code,
      /rawValue: missing\.length/,
      "rawValue must stay the REAL number of flagged days — only the money uses the weighted count",
    );
    assert.doesNotMatch(
      code,
      /deductionDays: missing\.length/,
      "the raw day count must never again be charged directly — that is the full-day Thursday bug this guard exists to stop",
    );
  }

  // ── An unpriceable row must never be emitted ─────────────────────────────
  {
    assert.match(
      source,
      /if \(estimatedAmount == null\) continue;/,
      "a row with no computable amount blocks the entire month's publish",
    );
  }

  // ── NEVER auto-publish ───────────────────────────────────────────────────
  // Owner's instruction (2026-08-03). These sit in the CRM tab, which is
  // mandatory-unless-cleared — so without this the rule would publish itself.
  // The behaviour is asserted here, not just the wiring, because it is the one
  // property standing between a brand-new rule and 29,548.40 EGP going through
  // with nobody having looked at it.
  {
    const dsmRow = { category: "crm" as const, sourceSystem: "dsm_no_record" };

    assert.equal(
      isEligibleForPublish({ ...dsmRow, decision: null }),
      false,
      "a DSM no-record row with NO decision must not publish",
    );
    assert.equal(
      isEligibleForPublish({ ...dsmRow, decision: { decisionStatus: "Pending" } }),
      false,
      "Pending must not publish — this is exactly what mandatory-unless-cleared would have allowed",
    );
    assert.equal(
      isEligibleForPublish({ ...dsmRow, decision: { decisionStatus: "Needs Follow-up" } }),
      false,
      "an open question is not an approval",
    );
    assert.equal(
      isEligibleForPublish({ ...dsmRow, decision: { decisionStatus: "Disputed" } }),
      false,
      "a disputed manager day must not publish while it is disputed",
    );
    assert.equal(
      isEligibleForPublish({ ...dsmRow, decision: { decisionStatus: "Approved for Payroll" } }),
      true,
      "an explicit approval is the ONLY way a DSM no-record day publishes",
    );

    // The reps' long-standing mandatory behaviour must be untouched — the whole
    // point of keying on source system rather than category.
    assert.equal(
      isEligibleForPublish({ category: "crm", sourceSystem: "crm_visits_mirror", decision: { decisionStatus: "Pending" } }),
      true,
      "a REP's CRM no-activity day must still publish on Pending; only the DSM source is gated",
    );
    assert.equal(
      isEligibleForPublish({ category: "crm", decision: { decisionStatus: "Pending" } }),
      true,
      "a candidate with no source system recorded must keep the category's own rule",
    );
  }

  // ── Registered, and in an order its dedup can rely on ────────────────────
  {
    assert.equal(isDeductionCollectorKey("dsm_no_record"), true, "the connector must be registered to be runnable");
    const order = DEDUCTION_COLLECTORS.map((collector) => collector.key);
    assert.ok(order.indexOf("dsm_no_record") > order.indexOf("crm"), "must run after the rep pipeline it dedups against");
  }
}
