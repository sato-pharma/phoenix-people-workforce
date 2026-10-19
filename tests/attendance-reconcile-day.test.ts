import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { reconcileDay, type ReconcileInput } from "../src/lib/attendance/digest-reconcile.ts";
import {
  isPlanMeetingActivity,
  judgedHalfDayPart,
  officeHalfConfig,
  planOfficeCoveredPart,
  planOfficeDayLabel,
  planOfficeDayNote,
  resolvePlanOfficeDay,
  type PlanOfficeEntry,
} from "../src/lib/attendance/plan-office-resolution.ts";
import type { PlanSlot } from "../src/lib/weekly-planning/plan-v1.ts";

function base(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    tier: "every_working_day",
    isWorkingDay: true,
    isHoliday: false,
    hasApprovedLeave: false,
    hasApprovedExcuse: false,
    planSaysOffice: null,
    hasPunch: true,
    deviceOutage: false,
    hasCrmLeave: false,
    hasCrmFieldVisit: false,
    ...overrides,
  };
}

export function runAttendanceReconcileDayTests() {
  // --- Tier 1 (head office): judged every working day ---
  assert.equal(reconcileDay(base()).action, "judge", "a normal working day is judged");
  assert.equal(reconcileDay(base({ isWorkingDay: false })).action, "skip", "weekly off is skipped");
  assert.equal(reconcileDay(base({ isHoliday: true })).action, "skip", "holiday is skipped");
  assert.equal(reconcileDay(base({ hasApprovedLeave: true })).action, "skip", "approved leave is skipped");
  assert.equal(reconcileDay(base({ hasApprovedExcuse: true })).action, "skip", "approved excuse is skipped");
  // Tier 1 is judged even with no punch (becomes a missing-punch line downstream).
  assert.equal(reconcileDay(base({ hasPunch: false })).action, "judge", "head office no-punch working day is still judged");

  // Universal cancels win over the tier logic (precedence).
  assert.equal(
    reconcileDay(base({ isHoliday: true, isWorkingDay: true })).action,
    "skip",
    "holiday overrides a working day",
  );

  // --- Tier 2 (office-hybrid): judged only when plan=office AND a punch exists ---
  const t2 = (overrides: Partial<ReconcileInput>) => reconcileDay(base({ tier: "office_days_only", ...overrides }));

  assert.equal(t2({ planSaysOffice: true, hasPunch: true }).action, "judge", "office day with a punch is judged");

  const noShow = t2({ planSaysOffice: true, hasPunch: false });
  assert.equal(noShow.action, "flag");
  assert.equal(noShow.action === "flag" && noShow.flagType, "office_no_show", "office day, no punch → no-show flag");

  const anomaly = t2({ planSaysOffice: false, hasPunch: true });
  assert.equal(anomaly.action, "flag");
  assert.equal(anomaly.action === "flag" && anomaly.flagType, "field_punch_anomaly", "field day, a punch → anomaly flag");

  assert.equal(t2({ planSaysOffice: false, hasPunch: false }).action, "skip", "field day with no punch is a normal field day");
  assert.equal(t2({ planSaysOffice: null, hasPunch: true }).action, "skip", "no plan → not an office day, skipped");

  // Tier-2 mismatches are still cancelled by holidays/leave (no flag on a holiday).
  assert.equal(
    t2({ planSaysOffice: true, hasPunch: false, isHoliday: true }).action,
    "skip",
    "a holiday cancels even a tier-2 office no-show",
  );
  assert.equal(
    t2({ planSaysOffice: true, hasPunch: true, hasApprovedLeave: true }).action,
    "skip",
    "approved leave cancels even a tier-2 office+punch day",
  );

  // --- Device-outage fail-safe: applies to BOTH tiers, before any tier logic ---
  assert.equal(
    reconcileDay(base({ deviceOutage: true, hasPunch: false })).action,
    "skip",
    "tier-1 no-punch day is skipped, not judged, when the device was down",
  );
  assert.equal(
    t2({ planSaysOffice: true, hasPunch: false, deviceOutage: true }).action,
    "skip",
    "an outage cancels a tier-2 office no-show flag — the missing punch isn't the employee's fault",
  );
  assert.equal(
    t2({ planSaysOffice: false, hasPunch: true, deviceOutage: true }).action,
    "skip",
    "an outage cancels a tier-2 field-punch anomaly flag too (the punch signal itself is untrustworthy that day)",
  );
  assert.equal(
    reconcileDay(base({ deviceOutage: true, hasPunch: true })).action,
    "skip",
    "an outage day is skipped even if this employee happens to have a punch (company-wide signal wins)",
  );

  // --- CRM awareness (2026-07-21): universal cancels, both tiers ---
  assert.equal(
    reconcileDay(base({ hasCrmLeave: true })).action,
    "skip",
    "a CRM-recorded leave day is skipped even with no matching Phoenix vacation_requests row",
  );
  assert.equal(
    reconcileDay(base({ hasCrmFieldVisit: true, hasPunch: false })).action,
    "skip",
    "tier-1, no office punch, but a real CRM field visit that day — skipped, not a missing-punch line",
  );
  assert.equal(
    t2({ planSaysOffice: true, hasPunch: false, hasCrmFieldVisit: true }).action,
    "skip",
    "a real CRM field visit cancels even a tier-2 office no-show flag",
  );
  assert.equal(
    t2({ planSaysOffice: null, hasCrmLeave: true }).action,
    "skip",
    "CRM leave cancels a tier-2 day regardless of plan/no-plan",
  );
  // Precedence: CRM signals are universal cancels, so they still win even when
  // a punch also exists that day (e.g. a half-day office stop before a field visit).
  assert.equal(
    reconcileDay(base({ hasCrmFieldVisit: true, hasPunch: true })).action,
    "skip",
    "a real CRM field visit cancels judgment even if a punch also exists that day",
  );

  // --- The SAME rule, in the code that actually deducts (2026-08-01) ---
  //
  // Everything above tests reconcileDay() in digest-reconcile.ts — the engine of
  // the attendance-digest feature, which was DROPPED (migration
  // 20260722124339_drop_attendance_digest_feature). So the correct cascade was
  // tested in code that no longer runs, while fingerprint-report.ts — the live
  // path that produces the money — fetched the approved-excuse map, rendered it
  // into a label, and charged the deduction anyway.
  //
  // Cost, measured on July 2026 production data: 1,666.66 EGP over three days
  // that were each fully covered by an approved excuse — A-9 on 07-07 (800.00),
  // B-155 on 07-09 and 07-14 (433.33 each).
  //
  // A behaviour test cannot reach getFingerprintAttendanceReport (it builds a
  // Supabase client), so this is a wiring assertion on the live file.
  //
  // Extended 2026-09-08: the inline expression this used to pin named only the
  // exception and the excuse, so it ALSO pinned the fail-open for the other three
  // cancels — a full-day approved leave, a CRM-recorded leave and a real CRM field
  // visit were each fetched, labelled and charged anyway, costing 3,274.19 EGP over
  // five days in August 2026. The rule now lives in isAttendanceDeductionCancelled
  // beside reconcileDay above, where the two can be read together; what this file
  // still has to prove is that the LIVE money path actually calls it, since a
  // correct helper nothing invokes is the same fail-open by another route.
  {
    const report = readFileSync("src/lib/attendance/fingerprint-report.ts", "utf8");
    assert.match(
      report,
      /import \{ isAttendanceDeductionCancelled \} from "@\/lib\/attendance\/digest-reconcile"/,
      "the live report must import the shared cancel rule rather than re-deriving its own",
    );
    assert.match(
      report,
      /const deductionCancelled = isAttendanceDeductionCancelled\(\{/,
      "the deduction must be cancelled through the shared rule, so the gate and the money cannot drift apart",
    );
    assert.doesNotMatch(
      report,
      /const deductionCancelled = hasApprovedException \|\| hasApprovedExcuse/,
      "the old inline rule charged approved leave and CRM-covered days — it must not come back",
    );
    assert.match(
      report,
      /deductionValue: deductionCancelled \?/,
      "the money field must be gated on deductionCancelled, not on hasApprovedException alone",
    );
    assert.doesNotMatch(
      report,
      /deductionDays: hasApprovedException \?/,
      "deductionDays gated on hasApprovedException alone is the fail-open that charged excused days",
    );
  }

  // --- Which plan decides a date, and how much of it is an office day (owner, 2026-10-19) ---
  {
    const weekly = (isOffice: boolean, slot: PlanSlot = "full"): PlanOfficeEntry => ({ kind: "weekly", isOffice, slot });
    const monthly = (isOffice: boolean, slot: PlanSlot = "full"): PlanOfficeEntry => ({ kind: "monthly", isOffice, slot });

    assert.equal(resolvePlanOfficeDay([]), null, "no approved plan on the date is 'no plan'");

    // 1. The approved weekly plan governs; the monthly plan is shown beside it.
    const overruled = resolvePlanOfficeDay([monthly(true), weekly(false)]);
    assert.equal(overruled?.isOffice, false, "a monthly Office day never overrides the approved weekly plan's Field day");
    assert.equal(overruled?.followed, "weekly");
    assert.deepEqual(overruled?.monthlyDisagrees, { isOffice: true }, "the monthly Office day is kept so both can be shown");
    assert.equal(planOfficeDayLabel(overruled), "Field (monthly plan: Office)");
    assert.match(planOfficeDayNote(overruled), /weekly plan says Field; the monthly plan says Office — the weekly plan is followed/);
    const weeklyOffice = resolvePlanOfficeDay([monthly(false), weekly(true)]);
    assert.equal(weeklyOffice?.isOffice, true, "the weekly plan's Office day stands over a monthly Field day too");
    assert.equal(planOfficeDayLabel(weeklyOffice), "Office (monthly plan: Field)");
    const agree = resolvePlanOfficeDay([monthly(true), weekly(true)]);
    assert.equal(agree?.monthlyDisagrees, null, "when the two agree there is nothing extra to show");
    assert.equal(planOfficeDayLabel(agree), "Office");
    const monthlyOnly = resolvePlanOfficeDay([monthly(true)]);
    assert.equal(monthlyOnly?.isOffice, true, "a monthly plan still decides a date no weekly plan covers");
    assert.equal(monthlyOnly?.followed, "monthly");
    assert.equal(planOfficeDayLabel(resolvePlanOfficeDay([weekly(false)])), "Field");
    assert.equal(planOfficeDayLabel(null), "");

    // 2. A half-day Office plan is HALF an office day.
    const officeMorning = resolvePlanOfficeDay([weekly(true, "am"), weekly(false, "pm")]);
    assert.equal(officeMorning?.isOffice, true, "an Office morning still expects a punch");
    assert.equal(officeMorning?.officeHalf, "am");
    assert.equal(planOfficeCoveredPart(officeMorning), "pm_only", "the field afternoon is the covered half");
    assert.equal(planOfficeDayLabel(officeMorning), "Office (morning)");
    assert.match(planOfficeDayNote(officeMorning), /Office for the morning only — judged on that half/);
    const officeAfternoonOnly = resolvePlanOfficeDay([weekly(true, "pm")]);
    assert.equal(officeAfternoonOnly?.officeHalf, "pm", "a Group Product Manager's afternoon-only Office plan is half a day");
    assert.equal(planOfficeCoveredPart(officeAfternoonOnly), "am_only");
    assert.equal(resolvePlanOfficeDay([weekly(true, "am"), weekly(true, "pm")])?.officeHalf, null, "Office on both halves is a full office day");
    assert.equal(resolvePlanOfficeDay([weekly(true, "full")])?.officeHalf, null);
    assert.equal(planOfficeCoveredPart(resolvePlanOfficeDay([weekly(false, "am")])), null, "a field day has no office half to judge");
    // A monthly Office half never reaches the judgment once a weekly plan covers the date.
    assert.equal(resolvePlanOfficeDay([monthly(true, "am"), weekly(false, "full")])?.officeHalf, null);

    // 3. On a day with an Office half, a meeting half counts as office too (owner, 2026-10-19).
    const meeting = (slot: PlanSlot, kind: PlanOfficeEntry["kind"] = "weekly"): PlanOfficeEntry => ({ kind, isOffice: false, isMeeting: true, slot });
    const officeThenMeeting = resolvePlanOfficeDay([weekly(true, "am"), meeting("pm")]);
    assert.equal(officeThenMeeting?.isOffice, true);
    assert.equal(officeThenMeeting?.officeHalf, null, "Office morning plus a Meeting afternoon is a full office day");
    assert.equal(planOfficeCoveredPart(officeThenMeeting), null, "so the whole day is judged");
    assert.equal(planOfficeDayLabel(officeThenMeeting), "Office");
    assert.equal(resolvePlanOfficeDay([meeting("am"), weekly(true, "pm")])?.officeHalf, null, "in either order");
    assert.equal(resolvePlanOfficeDay([meeting("full")])?.isOffice, false, "a meeting alone never makes an office day");
    assert.equal(resolvePlanOfficeDay([meeting("am"), weekly(false, "pm")])?.isOffice, false, "nor does a meeting beside a field half");
    assert.equal(resolvePlanOfficeDay([weekly(true, "am"), meeting("am"), weekly(false, "pm")])?.officeHalf, "am", "a meeting on the office half itself adds nothing");
    assert.equal(resolvePlanOfficeDay([monthly(true, "am"), meeting("pm", "monthly"), weekly(false, "full")])?.isOffice, false, "the weekly plan still governs");
    assert.equal(isPlanMeetingActivity("Meeting"), true);
    assert.equal(isPlanMeetingActivity("Meeting with Team"), true);
    assert.equal(isPlanMeetingActivity("Double Visit"), false);
    assert.equal(isPlanMeetingActivity("Field"), false);

    // The fingerprint report — the engine that produces the deductions — judges the same half
    // (owner, 2026-10-19: "deductions follow it too").
    assert.equal(judgedHalfDayPart({ halfDayVacationPart: null, judgmentMode: "office_days_only", planDay: officeMorning }), "pm_only", "an office morning is judged on the morning");
    assert.equal(judgedHalfDayPart({ halfDayVacationPart: null, judgmentMode: "office_days_only", planDay: officeAfternoonOnly }), "am_only");
    assert.equal(judgedHalfDayPart({ halfDayVacationPart: null, judgmentMode: "every_working_day", planDay: officeMorning }), null, "a seat judged every working day is untouched by the plan");
    assert.equal(judgedHalfDayPart({ halfDayVacationPart: null, judgmentMode: undefined, planDay: officeMorning }), null, "an unknown mode is untouched too");
    assert.equal(judgedHalfDayPart({ halfDayVacationPart: null, judgmentMode: "office_days_only", planDay: officeThenMeeting }), null, "a full office day keeps the full hours");
    assert.equal(judgedHalfDayPart({ halfDayVacationPart: null, judgmentMode: "office_days_only", planDay: undefined }), null, "no plan, no halving");
    assert.equal(judgedHalfDayPart({ halfDayVacationPart: "am_only", judgmentMode: "office_days_only", planDay: officeMorning }), "am_only", "an approved half-day vacation keeps its own half, so a day is never halved twice");

    // The office half is judged with the half-day vacation math: half the presence, and an office
    // afternoon judged from where the afternoon begins, with the flex window kept.
    const full = { scheduledStartMinutes: 540, flexCeilingMinutes: 570, requiredMinutes: 470 };
    assert.deepEqual(officeHalfConfig(full, null), full, "a full office day keeps the whole requirement");
    assert.deepEqual(officeHalfConfig(full, "pm_only"), { scheduledStartMinutes: 540, flexCeilingMinutes: 570, requiredMinutes: 235 });
    assert.deepEqual(officeHalfConfig(full, "am_only"), { scheduledStartMinutes: 775, flexCeilingMinutes: 805, requiredMinutes: 235 });

    const dayReport = readFileSync("src/lib/attendance/employee-day-report.ts", "utf8");
    assert.match(
      dayReport,
      /config: officeHalfConfig\(config, planOfficeCoveredPart\(planDay\)\)/,
      "the employee day report must judge a half-day Office plan on its office half",
    );
    assert.match(
      dayReport,
      /const planDay = dayPolicy\.policy\.judgment_mode === "office_days_only" \? officeDates\.get\(dateIso\) : undefined;/,
      "only an office-days-only seat is judged by the plan, so only there may it halve the day",
    );
    const officeDays = readFileSync("src/lib/attendance/plan-office-days.ts", "utf8");
    assert.match(officeDays, /plan_kind,employee_plan_items\(activity_date,activity_type,start_time,end_time\)/, "the lookup must read each plan's kind and each item's half");
    assert.match(officeDays, /resolvePlanOfficeDay\(entries\)/, "every date goes through the one resolver");
    assert.match(
      officeDays,
      /const kind = header\.plan_kind === "monthly" \? "monthly" : "weekly";/,
      "only a monthly plan is read as monthly, so an unexpected kind can never overrule the week",
    );
    const fingerprintReport = readFileSync("src/lib/attendance/fingerprint-report.ts", "utf8");
    assert.match(
      fingerprintReport,
      /weeklyPlan: planOfficeDayLabel\(planDay\),/,
      "the report's Weekly Plan cell shows the plan that was followed, and the monthly plan beside it when they disagree",
    );
    assert.match(
      fingerprintReport,
      /const judgedHalfPart = judgedHalfDayPart\(\{ halfDayVacationPart, judgmentMode: policy\?\.judgment_mode, planDay \}\);/,
      "the deduction engine must judge a half-Office day on an office-days-only seat on its office half",
    );
    assert.equal(
      (fingerprintReport.match(/halfDayVacationPart: judgedHalfPart,/g) ?? []).length,
      2,
      "both judgment branches (flexible hours and the older grace formula) must judge that half",
    );
    assert.match(
      fingerprintReport,
      /isAttendanceDeductionCancelled\(\{\s*halfDayVacationPart,/,
      "the cancel rule still reads the real vacation alone — an office half never cancels a charge",
    );
    assert.match(officeDays, /isMeeting: isPlanMeetingActivity\(item\.activity_type\),/, "a Plans-tab meeting half is read");
    assert.match(officeDays, /isMeeting: halfDay\.kind === "admin" && halfDay\.activityType === "meeting",/, "and a Phoenix CRM manager's meeting half");
  }
}
