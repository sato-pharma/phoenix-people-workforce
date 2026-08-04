// Unified Deductions module: district-sales-manager CRM no-record days.
//
// WHY THIS IS A SEPARATE CONNECTOR AND NOT A WIDENING OF THE REP PIPELINE.
//
// `field-workforce-compliance/eligibility.ts` deliberately restricts CRM
// no-activity deductions to medical representatives, and carries a red-flag
// warning against putting managers back in scope. That warning was earned: 16
// managers/PMs once carried 131,741.94 EGP — 77% of the whole CRM category —
// and on 35 of those charged days the person had clocked in on the fingerprint
// device. Editing `logsOwnCrmVisitsTitle` would silently re-widen every consumer
// of that predicate and risk repeating exactly that.
//
// The owner's instruction (2026-08-03) narrows rather than reverses it, and the
// production data supports the distinction:
//
//   - A DSM's job IS the daily double visit. When a rep submits a DV the manager
//     is tagged, so a DSM's participation is recorded by design — unlike a
//     Product Manager or National Sales Manager, who appear only if someone
//     happens to tag them. The harm documented in eligibility.ts names a PM and
//     an NSM; it names no DSM.
//   - Measured on July 2026: every working DSM whose team is fully mapped into
//     CRM shows BOTH double-visit days (8-20 of them) and their own agent days
//     (8-20). For those managers the tagging mechanism is demonstrably reliable,
//     so a gap is signal rather than noise.
//
//     That qualifier is load-bearing and was learned the expensive way. The
//     original note here claimed "every working DSM" without it, and the one
//     manager it was wrong about — Momen Abdelhady, whose team is only partly
//     onboarded onto CRM — was accordingly charged 12 days / 8,709.68 EGP for
//     July, 38.7% of his base salary, when the next-worst DSM in the whole role
//     had 5 days. He also shows 1 own-agent day against a peer range of 8-20, so
//     only ONE of the two recording channels has ever worked for him. See the
//     coverage guard in the loop below for how that is now excluded.
//
// So: medical reps stay with the existing engine, DSMs are handled here, and
// every other manager title remains out of scope. Deleting this one file removes
// the DSM rule completely.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getMappedAgentHrIds, scanVisitsForRange } from "@/lib/crm/reads";
import { getBaseSalaryMap } from "@/lib/payroll/copilot/feeders.ts";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";

import { calculateDeductionAmountFromBaseSalary } from "../calculations.ts";
import { compactDeductionsHrId } from "../candidate-key.ts";
import { addDaysIso, isFieldForceWorkingDay } from "../holiday-bridge.ts";
import { assertBaseSalaryMapLoaded } from "./health.ts";
import type { DeductionsCandidateDraft } from "../types.ts";

/** District sales managers only — never a broader manager title. */
const DSM_TITLE = /district\s+(sales\s+)?manager/i;

function monthDays(monthKey: string): string[] {
  const [year, month] = monthKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  const days: string[] = [];
  for (let day = 1; day <= lastDay; day += 1) {
    days.push(`${monthKey}-${String(day).padStart(2, "0")}`);
  }
  return days;
}

/**
 * National-holiday dates touching the month. Charging a DSM for a public
 * holiday would be indefensible, and the raw data invites it: 12 of 18 managers
 * had "no record" on 2 July and 11 on 23 July, purely because those were
 * holidays and nobody worked.
 */
async function holidayDates(monthKey: string): Promise<Set<string>> {
  const [year, month] = monthKey.split("-").map(Number);
  const dates = new Set<string>();
  const result = await getConfirmedNationalHolidays({ month: month!, year: year! });
  if (!result.calendarReachable) {
    throw new Error(
      "The Egypt national-holiday calendar could not be read. Refusing to charge no-record days rather than risk deducting a public holiday.",
    );
  }
  for (const holiday of result.holidays) {
    const end = holiday.endDate ?? holiday.startDate;
    let cursor = holiday.startDate;
    for (let guard = 0; guard < 40 && cursor <= end; guard += 1) {
      dates.add(cursor);
      const next = new Date(`${cursor}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      cursor = next.toISOString().slice(0, 10);
    }
  }
  return dates;
}

/**
 * Employee-days inside the month covered by an APPROVED leave request, as
 * `${compactHrId}:${date}`.
 *
 * A day the company APPROVED someone's absence cannot also be a day it charges them for being
 * absent. Nothing else in this connector stops that: `claimed` only skips days another DEDUCTION
 * already bills, and an approved paid leave day is not a deduction at all, so it never appears
 * there. In July 2026 five DSMs held 12 approved paid leave days between them and none was charged
 * — but only because every one of those days happened to carry CRM activity anyway. A manager who
 * actually rests on approved leave would have been billed for it.
 *
 * Every type and payment status counts. The question here is "did the company agree this person was
 * away", not "was it paid" — an approved unpaid day is still not a no-record day, and the unpaid
 * vacation connector already charges it separately (double-charging it is exactly what the owner's
 * never-the-same-day-twice rule forbids).
 *
 * NOT a substitute for recording long-term leave properly. Maternity leave has no representation
 * anywhere in this system — no vacation type, no employment status in use, no code path — so a
 * manager on maternity leave is invisible to this guard and is currently spared only by the
 * whole-month zero-signal guard above. That protection breaks the moment she is tagged on a single
 * visit after returning mid-month, which would charge her for the maternity days earlier in that
 * month. See the note in the loop below.
 */
async function approvedLeaveDays(monthKey: string): Promise<Set<string>> {
  const [year, month] = monthKey.split("-").map(Number);
  const start = `${monthKey}-01`;
  const end = `${monthKey}-${String(new Date(Date.UTC(year!, month!, 0)).getUTCDate()).padStart(2, "0")}`;

  const { data, error } = await getSupabaseAdmin()
    .from("v2_vacation_requests")
    .select("employee_hr_id, start_date, end_date")
    .eq("status", "approved")
    .lte("start_date", end)
    .gte("end_date", start);
  if (error) throw new Error(`Failed to load approved leave: ${error.message}`);

  const days = new Set<string>();
  for (const row of (data ?? []) as Array<{ employee_hr_id: string | null; start_date: string | null; end_date: string | null }>) {
    const compact = compactDeductionsHrId(row.employee_hr_id ?? "");
    if (!compact || !row.start_date) continue;
    // end_date is nullable; a request without one is a single day.
    const last = (row.end_date ?? row.start_date).slice(0, 10);
    let cursor = row.start_date.slice(0, 10);
    for (let guard = 0; guard < 400 && cursor <= last; guard += 1) {
      if (cursor >= start && cursor <= end) days.add(`${compact}:${cursor}`);
      cursor = addDaysIso(cursor, 1);
    }
  }
  return days;
}

export async function collectDsmNoRecordCandidates(input: {
  month: number;
  year: number;
  createdBy: string;
}): Promise<DeductionsCandidateDraft[]> {
  const monthKey = `${input.year}-${String(input.month).padStart(2, "0")}`;
  const [holidays, leaveDays] = await Promise.all([holidayDates(monthKey), approvedLeaveDays(monthKey)]);

  // Friday off, and never a public holiday.
  const workingDays = monthDays(monthKey).filter((day) => isFieldForceWorkingDay(day) && !holidays.has(day));
  if (workingDays.length === 0) return [];

  const supabase = getSupabaseAdmin();
  const [{ data: employees, error }, baseSalaryByCompact] = await Promise.all([
    supabase
      .from("employees")
      .select("hr_id, full_name, job_title, hire_date, manager_hr_id")
      .eq("employment_status", "active"),
    getBaseSalaryMap(),
  ]);
  if (error) throw new Error(`Failed to load the DSM roster: ${error.message}`);
  assertBaseSalaryMapLoaded("DSM no-record connector", baseSalaryByCompact);

  const roster = new Map<string, { hrId: string; name: string | null; hireDate: string | null }>();
  // Active direct reports per manager, keyed by the MANAGER's compact hr id.
  //
  // Deliberately NOT filtered by job title. The obvious move is to keep only titles that log their
  // own CRM visits, but that predicate lives in the reps' eligibility module and this connector is
  // kept free of it on purpose — the rep pipeline must stay untouched, and deleting this one file
  // must remove the DSM rule completely (see the note at the top; a test pins both). It also costs
  // nothing today: all 69 active direct reports of a DSM are Medical Representatives, verified in
  // production 2026-08-04. Should a non-CRM report ever be added under a DSM, the guard below
  // would skip that manager rather than mis-bill them — the safe direction to be wrong in.
  const repsByManager = new Map<string, string[]>();
  for (const row of (employees ?? []) as Array<Record<string, unknown>>) {
    const hrId = String(row.hr_id ?? "").trim();
    const jobTitle = String(row.job_title ?? "");
    const managerCompact = compactDeductionsHrId(String(row.manager_hr_id ?? ""));
    if (hrId && managerCompact) {
      const known = repsByManager.get(managerCompact);
      if (known) known.push(hrId);
      else repsByManager.set(managerCompact, [hrId]);
    }
    if (!DSM_TITLE.test(jobTitle)) continue;
    const compact = compactDeductionsHrId(hrId);
    if (!compact) continue;
    roster.set(compact, {
      hrId,
      name: (row.full_name as string | null) ?? null,
      hireDate: (row.hire_date as string | null) ?? null,
    });
  }
  if (roster.size === 0) return [];

  // Which of those reps the CRM feed knew BY THE END OF THIS MONTH. `getMappedAgentHrIds` is the
  // canonical "does CRM know this person at all" detector (it already powers the probation
  // CRM-unmapped badge), and it deliberately ignores the resigned-agent exclusion — so a rep whose
  // CRM slot sits on that list still counts as mapped instead of being misread as an onboarding gap.
  //
  // The date bound is not optional here. Candidates for a month are re-collected repeatedly (July
  // 2026 already has ten superseded generations), so an unbounded "has CRM ever seen this rep"
  // would let a LATER onboarding rewrite an EARLIER month: the day Mahmoud Abdelreheem is finally
  // coded onto CRM, a re-run of July would find Momen's team fully mapped and charge him the 12
  // days that this guard exists to prevent. What matters is whether the mechanism could have
  // recorded him AT THE TIME, and that answer can never change afterwards.
  // The last CALENDAR day, not the last working day: reps do log the occasional Friday/holiday
  // visit (one DSM shows 26 active days against 24 working ones), and a rep whose first-ever visit
  // landed on a month-end Friday would otherwise read as never-mapped.
  const allMonthDays = monthDays(monthKey);
  const monthEnd = allMonthDays[allMonthDays.length - 1]!;
  const mappedRepCompacts = new Set(
    (
      await getMappedAgentHrIds(
        [...roster.keys()].flatMap((compact) => repsByManager.get(compact) ?? []),
        { notAfterDate: monthEnd },
      )
    )
      .map((hrId) => compactDeductionsHrId(hrId))
      .filter((compact): compact is string => Boolean(compact)),
  );

  // Activity = either side of a visit. A DSM is normally the DOUBLE on a rep's
  // visit; counting only the agent side reads every manager as absent.
  const rows = await scanVisitsForRange<{
    agent_hr_id: string | null;
    double_hr_id: string | null;
    visit_date: string | null;
  }>({
    dateFrom: workingDays[0]!,
    dateTo: workingDays[workingDays.length - 1]!,
    columns: "agent_hr_id, double_hr_id, visit_date",
  });
  const activity = new Set<string>();
  const anySignal = new Set<string>();
  for (const row of rows) {
    const date = String(row.visit_date ?? "").slice(0, 10);
    if (!date) continue;
    for (const raw of [row.agent_hr_id, row.double_hr_id]) {
      const compact = compactDeductionsHrId(String(raw ?? ""));
      if (!compact) continue;
      activity.add(`${compact}:${date}`);
      anySignal.add(compact);
    }
  }

  // Employee-days another category already charges. The owner's rule: never the
  // same day twice. Enforced here rather than at publish, where a collision
  // refuses the whole month instead of preventing the double charge.
  const claimed = new Set<string>();
  const { data: existing, error: existingError } = await supabase
    .from("deductions_candidates")
    .select("employee_hr_id_compact, dates")
    .eq("month_key", monthKey)
    .is("superseded_at", null);
  if (existingError) throw new Error(`Failed to load already-deducted days: ${existingError.message}`);
  for (const row of (existing ?? []) as Array<{ employee_hr_id_compact: string; dates: unknown }>) {
    if (!Array.isArray(row.dates)) continue;
    for (const date of row.dates as unknown[]) {
      if (typeof date === "string") claimed.add(`${String(row.employee_hr_id_compact)}:${date}`);
    }
  }

  const drafts: DeductionsCandidateDraft[] = [];
  for (const [compact, manager] of roster) {
    // Zero CRM signal for the WHOLE month is a mapping or onboarding gap, not a
    // month of absence. Three DSMs hit this in July 2026: two were hired mid- or
    // post-month, and one had reps assigned who never tagged her — a problem to
    // investigate, not to charge.
    // 🔴 THIS IS ALSO WHAT CURRENTLY SPARES A MANAGER ON MATERNITY LEAVE, BY ACCIDENT.
    // Sara Samir Jacoub Yohana has been on maternity leave since 26 May 2026 (confirmed by the
    // owner 2026-08-04). Nothing in the system records that: maternity is not a vacation type,
    // `employment_status` is still "active" (`on_leave` exists in the roster's own status list but
    // no employee uses it), and she filed no leave request. She is skipped here ONLY because the
    // leave happens to span whole months, giving her zero signal.
    //
    // That protection is one visit thick. On the month she returns mid-month, a single rep tagging
    // her makes anySignal true, and every maternity working day earlier in that month becomes a
    // charge — roughly 903 EGP each. The durable fix is to record the leave (see approvedLeaveDays
    // above, which already excludes any approved request); this guard must not be mistaken for it.
    if (!anySignal.has(compact)) continue;

    // COVERAGE GUARD — the same reasoning as the zero-signal guard above, one step earlier.
    //
    // "A DSM's participation is recorded by design" only holds while EVERY rep they could ride
    // along with is able to submit a DV that names them. A rep the CRM feed has never heard of is
    // an onboarding gap, and every day the manager spends doubling with that rep is invisible — so
    // their no-record days stop being evidence of absence and become evidence of the gap. Charging
    // through it would bill the manager for their own team's incomplete setup.
    //
    // Measured on July 2026, exactly one DSM fails this and every other manager's team is fully
    // mapped, so no legitimate charge is suppressed: Momen Abdelhady had 1 of 3 active reps
    // (Mahmoud Abdelreheem) with no CRM identity at all, and was being charged 12 days /
    // 8,709.68 EGP — 38.7% of base salary, against a next-worst of 5 days across the whole role.
    // He is also the only DSM who has never logged own-agent days (1 in July vs 8-20 for every
    // working peer), i.e. the one manager for whom only one of the two recording channels has
    // ever worked. Fix the team's CRM mapping and he becomes chargeable again automatically.
    //
    // A manager with no CRM-logging reps at all has no double-visit mechanism either, so they are
    // skipped by the same test rather than charged for a structure they do not have.
    const reps = repsByManager.get(compact) ?? [];
    const everyRepIsMapped = reps.every((repHrId) => {
      const repCompact = compactDeductionsHrId(repHrId);
      return repCompact != null && mappedRepCompacts.has(repCompact);
    });
    if (reps.length === 0 || !everyRepIsMapped) continue;

    const baseSalary = baseSalaryByCompact.get(compact) ?? null;

    const missing = workingDays.filter((day) => {
      // Never charge a day before the person was hired.
      if (manager.hireDate && day < manager.hireDate) return false;
      // Never charge a day the company itself approved them to be away.
      if (leaveDays.has(`${compact}:${day}`)) return false;
      if (activity.has(`${compact}:${day}`)) return false;
      if (claimed.has(`${compact}:${day}`)) return false;
      return true;
    });
    if (missing.length === 0) continue;

    const estimatedAmount = calculateDeductionAmountFromBaseSalary({
      baseSalary,
      deductionDays: missing.length,
      month: input.month,
      year: input.year,
    });
    // An unpriceable row blocks the entire month's publish — skip rather than
    // emit a requires_review candidate with no amount.
    if (estimatedAmount == null) continue;

    drafts.push({
      // CRM, on the owner's instruction (2026-08-03) — these belong beside the
      // reps' no-activity days, which is where a reviewer looks for them.
      //
      // 🔴 CRM is MANDATORY-UNLESS-CLEARED: requiresApproval is false, so these
      // publish with NO approval step. A rep's no-activity day works that way by
      // long-standing rule; this connector is new, so its first months publish
      // themselves unless somebody explicitly marks a row "Do Not Take Action".
      // Filing them under `other` would have required an approval per row. The
      // owner chose the CRM tab knowing that.
      category: "crm",
      sourceSystem: "dsm_no_record",
      sourceRecordId: `dsm-no-record:${compact}:${monthKey}`,
      employeeHrId: manager.hrId,
      employeeName: manager.name,
      monthKey,
      month: input.month,
      year: input.year,
      unit: "days",
      rawValue: missing.length,
      estimatedAmount,
      calculationStatus: "calculated",
      severity: "High",
      reason: `No CRM record on ${missing.length} working day(s) — a district manager's double visits are logged when the rep submits`,
      evidence: {
        rule: "District sales managers are recorded on CRM through the rep's double visit; a working day with neither a DV tag nor an own-agent visit is a no-record day.",
        workingDaysConsidered: workingDays.length,
        holidaysExcluded: [...holidays],
        missingDays: missing,
      },
      dates: missing,
    });
  }

  return drafts;
}
