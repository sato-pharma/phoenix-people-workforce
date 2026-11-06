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
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getMappedAgentHrIds, scanVisitsForRangeCreditingPartners } from "@/lib/crm/reads";
import { getBaseSalaryMap } from "@/lib/payroll/copilot/feeders.ts";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";
import { sumDetectedDeductionDayWeights } from "@/lib/field-workforce-compliance/weekend-policy.ts";

import { calculateDeductionAmountFromBaseSalary } from "../calculations.ts";
import { compactDeductionsHrId } from "../candidate-key.ts";
import {
  collectClaimedLedgerDays,
  ledgerRowStillClaimsItsDaysBySource,
  ledgerReadErrorText,
  type LedgerClaimRow,
} from "../conflict.ts";
import {
  buildHalfDayIdentity,
  combineLeaveParts,
  fullDayCheckLeaveVerdict,
  leavePartOf,
  resolveSlot,
  type LeavePart,
} from "../half-day-rule.ts";
import { addDaysIso, isFieldForceWorkingDay } from "../holiday-bridge.ts";
import { loadProvenWorkedDays } from "../proven-worked-days.ts";
import { assertBaseSalaryMapLoaded } from "./health.ts";
// The rep pipeline's own company-wide CRM data-gap detector, reused here so both
// paths agree on which days a sync outage made unmeasurable — and so the DSM run
// inherits its fail-closed throw on a CRM outage instead of charging through one.
import { getSuspectDatesForMonth } from "./crm.ts";
import { ledgerClaimMonthKeys } from "../cycle.ts";
import type { DeductionsCandidateDraft } from "../types.ts";

/** District sales managers only — never a broader manager title. */
const DSM_TITLE = /district\s+(sales\s+)?manager/i;

/**
 * The one `source_system` this connector writes, and therefore the only one its re-run may retire.
 *
 * Exported so a test can assert it against `collect.ts`'s own `reconcilesSourceScope` registration,
 * which is pinned there as a literal by `deductions-supersede-carries-decision.test.ts`. The two
 * must stay equal: the already-claimed read below excludes exactly the rows reconcile is about to
 * supersede, and either half drifting is silent — too narrow brings back the alternating flip, too
 * wide retires the sibling writer's rows.
 */
export const DSM_NO_RECORD_SOURCE_SYSTEM = "dsm_no_record";

const DSM_NO_RECORD_SOURCE_SYSTEMS: readonly string[] = [DSM_NO_RECORD_SOURCE_SYSTEM];

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
 * 🔴 A HALF-DAY REQUEST CLEARS ONLY ITS HALF (owner, 2026-10-08). Each day carries the part it
 * covers, and `fullDayCheckLeaveVerdict` decides what that does to the day: a full day, or a
 * Thursday morning off, clears it; a Saturday-to-Wednesday half leaves the other half owed, and that
 * half goes to the Half Day (CRM) tab at 0.5, because this row's dates are weighed whole by payroll;
 * a Thursday afternoon off covers no field hour, so the Thursday is judged as if it were not there.
 * Before this, any approved request skipped the whole day, half-day or not.
 *
 * NOT a substitute for recording long-term leave properly. Maternity leave has no representation
 * anywhere in this system — no vacation type, no employment status in use, no code path — so a
 * manager on maternity leave is invisible to this guard and is currently spared only by the
 * whole-month zero-signal guard above. That protection breaks the moment she is tagged on a single
 * visit after returning mid-month, which would charge her for the maternity days earlier in that
 * month. See the note in the loop below.
 */
async function approvedLeaveDays(monthKey: string): Promise<Map<string, LeavePart>> {
  const [year, month] = monthKey.split("-").map(Number);
  const start = `${monthKey}-01`;
  const end = `${monthKey}-${String(new Date(Date.UTC(year!, month!, 0)).getUTCDate()).padStart(2, "0")}`;

  const { data, error } = await getSupabaseAdmin()
    .from("v2_vacation_requests")
    .select("employee_hr_id, start_date, end_date, day_part")
    .eq("status", "approved")
    .lte("start_date", end)
    .gte("end_date", start);
  if (error) throw new Error(`Failed to load approved leave: ${error.message}`);

  const days = new Map<string, LeavePart>();
  for (const row of (data ?? []) as Array<{ employee_hr_id: string | null; start_date: string | null; end_date: string | null; day_part: string | null }>) {
    const compact = compactDeductionsHrId(row.employee_hr_id ?? "");
    if (!compact || !row.start_date) continue;
    const part = leavePartOf(row.day_part);
    // end_date is nullable; a request without one is a single day.
    const last = (row.end_date ?? row.start_date).slice(0, 10);
    let cursor = row.start_date.slice(0, 10);
    for (let guard = 0; guard < 400 && cursor <= last; guard += 1) {
      if (cursor >= start && cursor <= end) {
        const key = `${compact}:${cursor}`;
        days.set(key, combineLeaveParts(days.get(key), part));
      }
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
  const [holidays, leaveDays, suspectDates] = await Promise.all([
    holidayDates(monthKey),
    approvedLeaveDays(monthKey),
    // A day the whole company's CRM feed looks broken (a sync outage) is no more
    // a manager's absence than a rep's. The rep pipeline already drops these; the
    // DSM path did not, so a company-wide gap billed every DSM a full day. Same
    // detector, so the two paths cannot disagree — and it THROWS on a CRM outage,
    // which fails this run closed rather than charging through missing data.
    getSuspectDatesForMonth(input.month, input.year),
  ]);

  // Friday off, never a public holiday, and never a company-wide CRM data-gap day.
  const workingDays = monthDays(monthKey).filter(
    (day) => isFieldForceWorkingDay(day) && !holidays.has(day) && !suspectDates.has(day),
  );
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
  //
  // Crediting partners, not the plain scan: the day a rep resigns, the plain scan drops HIS rows —
  // and with them the only record that his manager was in the field that day, which charged the
  // manager a no-record deduction months after the fact (owner report 2026-10-07). A rescued row
  // comes back with `agent_hr_id` nulled, so the loop below credits the partner and nobody else.
  const rows = await scanVisitsForRangeCreditingPartners<{
    agent_hr_id: string | null;
    agent_crm_id: number | string | null;
    double_hr_id: string | null;
    double_crm_id: number | string | null;
    double2_hr_id: string | null;
    double2_crm_id: number | string | null;
    visit_date: string | null;
  }>({
    dateFrom: workingDays[0]!,
    dateTo: workingDays[workingDays.length - 1]!,
    columns:
      "agent_hr_id, agent_crm_id, double_hr_id, double_crm_id, double2_hr_id, double2_crm_id, visit_date",
  });

  // 🔴 EITHER ID CREDITS THE DAY — THE HR ID ALONE IS NOT ENOUGH (owner, 2026-10-09: the module
  // "must read both dm single or double visit").
  //
  // The mirror resolves `*_hr_id` asynchronously and leaves it NULL for weeks, while `*_crm_id` is
  // on the row from the moment it is written (half-day-rule.ts records 2,050 such rows since June).
  // This connector read the hr id columns alone, so during that window a manager who was in the
  // field read as ABSENT — and absent here means a FULL day charged, with no approval step, because
  // these rows publish themselves unless somebody marks them "Do Not Take Action".
  //
  // Measured on production 2026-10-09: of 52 flagged DSM no-record days, THREE are days the manager
  // is now provably credited on as a double partner — Sameh Shabaan El Hoseiny 2026-07-06 (7 rows on
  // Ahmed Essam's visits), Taha Mohamed AboElftouh 2026-07-13 (8 rows), Yehya Mohamed Kamal
  // 2026-07-21 (10 rows). Every one of those rows re-synced on 2026-09-20 17:17 UTC, five weeks
  // AFTER the candidates were created on 2026-08-11, which is the backfill arriving too late.
  //
  // The resolver is `resolveSlot`, shared with the Half Day (CRM) connector so the two cannot
  // disagree about who was on a visit. An AMBIGUOUS crm id (two people claim it) credits EVERY
  // claimant's day rather than nobody's: the only thing a day can do here is REMOVE a charge, and
  // on a contested identity not charging is the safe direction to be wrong in.
  //
  // 🔴 THE MAP IS BUILT FROM THE FEED'S OWN ROWS AND NEVER FROM `employees.crm_id`, which the rule
  // below this block has forbidden since 2026-08-04: on 3 reused CRM logins that column names a
  // RESIGNED person while the feed resolves the current holder correctly, so joining it would
  // attribute a working rep's day to a leaver. A row that carries BOTH ids teaches the pairing, and
  // the rows carrying only the crm id are then resolved from it.
  const identity = buildHalfDayIdentity([
    ...rows.map((row) => ({ hrId: row.agent_hr_id, crmId: row.agent_crm_id })),
    ...rows.map((row) => ({ hrId: row.double_hr_id, crmId: row.double_crm_id })),
    ...rows.map((row) => ({ hrId: row.double2_hr_id, crmId: row.double2_crm_id })),
  ]);

  const activity = new Set<string>();
  const anySignal = new Set<string>();
  const credit = (compact: string, date: string) => {
    activity.add(`${compact}:${date}`);
    anySignal.add(compact);
  };
  for (const row of rows) {
    const date = String(row.visit_date ?? "").slice(0, 10);
    if (!date) continue;
    // All three slots. The agent slot is the manager's OWN single visit, the other two are the
    // visits he is credited on as a partner — a chain visit's second manager stands in slot 2 — and
    // a manager read as ABSENT here is a manager this category DEDUCTS FROM.
    const slots: Array<{ hr: unknown; crm: unknown }> = [
      { hr: row.agent_hr_id, crm: row.agent_crm_id },
      { hr: row.double_hr_id, crm: row.double_crm_id },
      { hr: row.double2_hr_id, crm: row.double2_crm_id },
    ];
    for (const slot of slots) {
      const resolved = resolveSlot(slot.hr, slot.crm, identity);
      if (resolved.ambiguous) {
        for (const claimant of resolved.claimants) credit(claimant, date);
        continue;
      }
      if (!resolved.compact) continue;
      credit(resolved.compact, date);
    }
  }

  // Employee-days another writer already charges. The owner's rule: never the
  // same day twice. Enforced here rather than at publish, where a collision
  // refuses the whole month instead of preventing the double charge.
  //
  // 🔴 THIS RUN'S OWN UNLOCKED ROWS ARE EXCLUDED, OR EVERY SECOND RUN FLIPS THE SET.
  // `collect.ts` registers this collector with `reconcilesSourceScope`, so its own live
  // `dsm_no_record` rows are this run's to keep or to retire: a day set the fresh scan no longer
  // produces IS superseded. Reading those rows as already-charged made the scan omit exactly the
  // days they cover, and reconcile then retired them for being absent from the scan — so a re-run
  // emitted nothing and withdrew the previous run's work, decision and all. Measured on production
  // for 2026-09: rows created 2026-10-03 20:01 and 2026-10-06 03:40, 04:55, 23:35 and 23:40 UTC
  // alternate, with Dina Hamdy Fadel Mohamed Bdair, Mohamed Alaa Eleiwa Abozaid and Nermeen Salah
  // Abdelaty Abohussien re-created and superseded on alternate runs while Sameh Shabaan El Hoseiny
  // El Hoseiny flips the opposite way.
  //
  // Keyed on SOURCE SYSTEM, never on category: `crm` is shared with `crm_visits_mirror`, whose rows
  // survive this run and so must keep claiming their days. A LOCKED own row keeps claiming too —
  // reconcile will not retract published money, so that row is still live afterwards.
  // Paged: PostgREST stops a response at 1,000 rows, and a short ledger read would re-charge a day
  // that is already charged. An error never ends the walk early — it throws (fail closed).
  let existing: LedgerClaimRow[];
  try {
    existing = await fetchAllRows<LedgerClaimRow>(
      () =>
        supabase
          .from("deductions_candidates")
          .select("id, employee_hr_id_compact, dates, locked_at, source_system")
          .in("month_key", ledgerClaimMonthKeys(monthKey))
          .is("superseded_at", null),
      "id",
    );
  } catch (error) {
    throw new Error(`Failed to load already-deducted days: ${ledgerReadErrorText(error)}`);
  }
  // Skips a manual_hr placeholder row — its date is `${monthKey}-01`, not a detected day, so treating
  // it as claimed would drop a genuine no-record deduction that lands on the real 1st (conflict.ts) —
  // and this run's own replaceable rows, per the note above.
  const claimed = collectClaimedLedgerDays(existing, (row) =>
    ledgerRowStillClaimsItsDaysBySource(
      { sourceSystem: row.source_system ?? null, lockedAt: row.locked_at ?? null },
      DSM_NO_RECORD_SOURCE_SYSTEMS,
    ),
  );

  // PHOENIX CRM, WHETHER OR NOT THE TEAM WAS STARTED. A manager's Phoenix visits reach the read door
  // only from the Saturday the Super Admin pressed Start on his team, so on an unstarted team his
  // real double visits are invisible to `activity` above. Read as a SUPPRESSOR in the `missing`
  // filter below and deliberately NOT folded into `activity`, which feeds `anySignal`: doing that
  // would turn the zero-signal mapping-gap skip into a charge. See ../phoenix-worked-days.ts.
  const provenWorked = await loadProvenWorkedDays({ end: monthEnd, start: allMonthDays[0]! });

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

    // Days a half-day vacation left half owed: the Half Day (CRM) tab charges that half at 0.5.
    const halfDayLeaveDates: string[] = [];
    const missing = workingDays.filter((day) => {
      // Never charge a day before the person was hired.
      if (manager.hireDate && day < manager.hireDate) return false;
      if (activity.has(`${compact}:${day}`)) return false;
      // A day Phoenix CRM proves he worked is never charged, started team or not.
      if (provenWorked.keys.has(`${compact}:${day}`)) return false;
      if (claimed.has(`${compact}:${day}`)) return false;
      // Never charge a day the company itself approved them to be away — but a half-day vacation
      // clears only its half (fullDayCheckLeaveVerdict).
      const leave = fullDayCheckLeaveVerdict(leaveDays.get(`${compact}:${day}`), day);
      if (leave === "cleared") return false;
      if (leave === "half_day") {
        halfDayLeaveDates.push(day);
        return false;
      }
      return true;
    });
    if (missing.length === 0) continue;

    // Thursday is a HALF working day for the field force (owner rule 2026-08-02),
    // and a district manager is one of the Friday-only titles that rule covers.
    // The rep pipeline already charges a no-record Thursday at 0.5; this path was
    // billing it at a FULL day. The money comes off the weighted count while
    // rawValue/dates keep reporting the REAL flagged days — exactly how
    // collectLeaverCrmCandidate keeps the evidence and the charge separately
    // auditable. sumDetectedDeductionDayWeights is the title-free helper for dates
    // that have ALREADY passed the weekly-off filter (Friday/holiday excluded
    // above), so a DSM's Saturdays stay full days and only the Thursday half bites.
    const deductionDays = sumDetectedDeductionDayWeights(missing);
    const estimatedAmount = calculateDeductionAmountFromBaseSalary({
      baseSalary,
      deductionDays,
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
      sourceSystem: DSM_NO_RECORD_SOURCE_SYSTEM,
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
        // Company-wide CRM data-gap days removed before charging — a sync outage
        // is not a manager's absence. Same detector the rep pipeline uses.
        suspectDatesExcluded: [...suspectDates].filter((day) => day.startsWith(`${monthKey}-`)).sort(),
        // What actually fed the amount: Thursdays counted as 0.5, all other
        // flagged days as 1. missingDays stays the real count of flagged days.
        deductionDaysWeighted: deductionDays,
        missingDays: missing,
        // A half-day vacation with nothing in the other half: not on this row, which payroll weighs
        // a whole day per date, but on the Half Day (CRM) tab at 0.5.
        halfDayVacationDatesOnTheHalfDayTab: halfDayLeaveDates,
      },
      dates: missing,
    });
  }

  return drafts;
}
