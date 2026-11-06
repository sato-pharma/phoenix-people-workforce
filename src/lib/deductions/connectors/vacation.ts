// Unified Deductions module: Unpaid Vacation + Insufficient Balance Vacation
// category connectors — one shared query builder, split by
// v2_vacation_requests.unpaid_reason (a real, already-coded enum:
// 'first_six_months' | 'insufficient_balance' | 'missing_hire_date').
//
// insufficient_balance is the one reason that's a genuine balance-math
// shortfall; first_six_months (a flat policy block, pre-entitlement) and
// missing_hire_date (a data-quality fallback with no balance period to
// compute) both represent "not entitled to paid leave right now" for reasons
// unrelated to balance math, so they land together as plain Unpaid Vacation.
// Ported from deductions-governance/connectors/vacation.ts's query shape,
// which took every unpaid_duration_days > 0 row with no reason filter at all.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { canonicalHrIdKey } from "@/lib/hr-id.ts";
import { scanVisitsForRangeIncludingDeparted } from "@/lib/crm/reads.ts";
import { calculatePaymentForRequest } from "@/lib/vacation/service.ts";
import { getBaseSalaryMap } from "@/lib/payroll/copilot/feeders.ts";
import { assertBaseSalaryMapLoaded, assertSourceScanned } from "./health.ts";
import { calculateDeductionAmountFromBaseSalary } from "../calculations.ts";
import { compactDeductionsHrId } from "../candidate-key.ts";
import { collectClaimedLedgerDays, ledgerReadErrorText, type LedgerClaimRow } from "../conflict.ts";
import { ledgerClaimMonthKeys } from "../cycle.ts";
import type { DeductionsCandidateDraft, DeductionsCategory } from "../types.ts";

type VacationRequestRow = {
  id: string;
  employee_hr_id: string | null;
  employee_name: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string | null;
  payment_status: string | null;
  unpaid_duration_days: number | string | null;
  unpaid_reason: string | null;
  vacation_type: string | null;
  manager_hr_id: string | null;
  manager_of_manager_hr_id: string | null;
};

/**
 * iReports360's Annual Vacation code. `ireports360-source.ts` maps -4 to the "AV" status
 * and its own comment calls it "the only genuine leave type here" — the other negative
 * codes are excuses, health days and the like, which are NOT vacation and must not be
 * charged as one.
 */
const CRM_ANNUAL_VACATION_VISIT_TYPE = -4;

/**
 * WHO A CRM VACATION DAY BELONGS TO — owner decision 2026-09-13 (questions workbook, rows 1–4).
 *
 * Until now a -4 day was matched on `employees.crm_id` = the visit's CRM slot, as the slot stands
 * TODAY. That misses leave logged under a slot that was later cleared (a resigned rep), and it would
 * hand a reused slot's old days to whoever holds it now. The owner chose "the new join, but only
 * within each person's own employment dates", and for the three reused slots (1399, 1475, 1485)
 * "Nobody — drop them":
 *
 *   1. The visit's sync-stamped `agent_hr_id` wins — this is what finds a resigned rep's leave after
 *      their slot was cleared.
 *   2. No stamp (a mapping added after the row was last synced): the CURRENT slot holder.
 *   Either way, only for a day on or after that person's hire date and on or before their last
 *   working date. A day before the holder was hired belongs to nobody — the previous occupant's
 *   leave is never charged to the new joiner.
 *
 * PUBLISHED MONTHS NEVER MOVE. The rule applies from `CRM_VACATION_EMPLOYMENT_JOIN_FROM` onward; an
 * earlier month is collected with the old slot-as-it-stands join, byte-for-byte as before, so
 * re-collecting a month payroll already published can never add or retract a day.
 */
export const CRM_VACATION_EMPLOYMENT_JOIN_FROM = "2026-09";

export type CrmVacationEmployee = {
  hrId: string;
  name: string | null;
  hireDate: string | null;
  lastWorkingDate: string | null;
};

export function resolveCrmVacationEmployee(input: {
  monthKey: string;
  day: string;
  crmId: string;
  agentHrId: string | null;
  byCrmId: ReadonlyMap<string, CrmVacationEmployee>;
  byHrIdKey: ReadonlyMap<string, CrmVacationEmployee>;
}): CrmVacationEmployee | null {
  if (input.monthKey < CRM_VACATION_EMPLOYMENT_JOIN_FROM) {
    return input.byCrmId.get(input.crmId) ?? null;
  }
  const stampKey = canonicalHrIdKey(input.agentHrId);
  const person = stampKey ? input.byHrIdKey.get(stampKey) : input.byCrmId.get(input.crmId);
  // The employment window binds a STAMPED person too, not only the slot holder: the sync's guard
  // keeps a stamp past the last working date while the CRM label still matches, and it re-resolves
  // only a recent window, so a stamp can outlive a corrected hire date.
  if (!person || !person.hireDate) return null;
  if (input.day < person.hireDate) return null;
  if (person.lastWorkingDate && input.day > person.lastWorkingDate) return null;
  return person;
}

/**
 * The key that ties one person's work rows to their vacation rows on the same day.
 *
 * The CRM slot when the row has one — every iReports360 row does, so vendor months key exactly as
 * before. From the CRM cutover a visit filed in Phoenix by someone with no CRM slot (a new hire) has
 * no `agent_crm_id`; keying on the slot alone skipped his rows entirely, so his half-day leave was
 * never seen as mixed and was charged as a full day. Such a row keys on his canonical hr id instead,
 * prefixed so it can never collide with a numeric slot.
 */
export function crmVacationPersonKey(agentCrmId: unknown, agentHrId: unknown): string {
  const crmId = String(agentCrmId ?? "").trim();
  if (crmId) return crmId;
  const hrKey = canonicalHrIdKey(agentHrId == null ? null : String(agentHrId));
  return hrKey ? `hr:${hrKey}` : "";
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function unpaidDays(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : 0;
}

/** Every ISO date from start..end inclusive. Small ranges only (a leave request). */
export function expandDateRange(startDate: string, endDate: string): string[] {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const dates: string[] = [];
  const cursor = new Date(start);
  // Hard cap: a single leave request spanning more than a year is a data error,
  // not something to loop over indefinitely.
  while (cursor <= end && dates.length < 400) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export type MonthClippedLeave = {
  datesInMonth: string[];
  daysInMonth: number;
  totalSpanDays: number;
  spansMonthBoundary: boolean;
};

/**
 * Clips a leave request to one month and apportions its unpaid days.
 *
 * A request overlapping the month boundary (e.g. 25 May – 5 Jun) previously
 * produced a candidate carrying the request's FULL unpaid_duration_days in BOTH
 * months — 11 unpaid days became 22 days deducted. The candidate_key includes
 * monthKey, so the unique index saw two legitimately distinct keys and allowed
 * both.
 *
 * Unpaid days are apportioned pro-rata across the span rather than assumed to
 * fall in either month, because v2_vacation_requests records only a total —
 * it does not say WHICH days within the range were the unpaid ones.
 */
export function clipLeaveToMonth(input: {
  startDate: string;
  endDate: string;
  monthKey: string;
  totalUnpaidDays: number;
}): MonthClippedLeave {
  const allDates = expandDateRange(input.startDate, input.endDate);
  const datesInMonth = allDates.filter((date) => date.startsWith(`${input.monthKey}-`));
  const totalSpanDays = allDates.length;
  if (totalSpanDays === 0 || datesInMonth.length === 0) {
    return { datesInMonth: [], daysInMonth: 0, totalSpanDays, spansMonthBoundary: false };
  }
  const spansMonthBoundary = datesInMonth.length < totalSpanDays;
  const daysInMonth = spansMonthBoundary
    ? Math.round(input.totalUnpaidDays * (datesInMonth.length / totalSpanDays) * 100) / 100
    : input.totalUnpaidDays;
  return { datesInMonth, daysInMonth, totalSpanDays, spansMonthBoundary };
}

export type VacationDaysAfterLedgerCheck = {
  datesInMonth: string[];
  daysInMonth: number;
  /** In-month days handed back because a live candidate already charges them. */
  droppedDates: string[];
};

/**
 * THE REVERSE HALF OF THE CRM PATH'S `if (covered) continue`.
 *
 * This connector emits from two sources that key their candidates differently —
 * `crm-vacation:{HR_ID}:{DATE}:{category}` and `vacation:{requestUuid}:{category}`.
 * Same employee, same day, same category, DIFFERENT key, so neither the partial
 * unique index on (category, candidate_key) nor `insertCandidateDrafts`' key
 * probe can see the collision.
 *
 * The CRM path already defers to an HR request. The request path had no matching
 * check, so re-running a month that already held CRM-signal candidates charged
 * those days a second time: on 2026-08-03, 23 rows created where 7 were due and
 * 13 duplicate employee-days in July 2026 (119 live → 135). Withdrawn, nothing
 * published.
 *
 * And the publish gate would NOT have named it. `findDayCollisions` only reports
 * a day whose claiming categories number more than one; two `unpaid_vacation`
 * rows on one day are invisible to it. The only backstop left is
 * `deductions_publication_lines_guard_day_overlap`, which raises a raw
 * unique_violation mid-publish. So this is the check that has to hold.
 *
 * OVERLAP CAN BE PARTIAL. A multi-day request may have some days claimed and
 * some free, so the claimed ones are dropped and the day count is re-derived
 * from the survivors rather than the whole draft being skipped. The unpaid total
 * is apportioned pro-rata for the same reason `clipLeaveToMonth` does it:
 * v2_vacation_requests records only a total, never which days were unpaid.
 * Dropping nothing leaves the ratio at exactly 1, so an unaffected request keeps
 * the value it has today.
 */
export function excludeAlreadyClaimedVacationDays(input: {
  clipped: MonthClippedLeave;
  /** Employee-days already claimed by any live candidate, as `${compactHrId}:${date}`. */
  alreadyDeducted: ReadonlySet<string>;
  employeeHrIdCompact: string | null;
}): VacationDaysAfterLedgerCheck {
  const { clipped } = input;
  const compact = input.employeeHrIdCompact ?? "";
  // No usable compact id means no key that can match the ledger. Matching on an
  // empty prefix would collide with every other unidentified row, so nothing is
  // dropped and the draft goes on to be priced as it is today.
  if (!compact || clipped.datesInMonth.length === 0) {
    return { datesInMonth: [...clipped.datesInMonth], daysInMonth: clipped.daysInMonth, droppedDates: [] };
  }

  const kept: string[] = [];
  const droppedDates: string[] = [];
  for (const date of clipped.datesInMonth) {
    if (input.alreadyDeducted.has(`${compact}:${date}`)) droppedDates.push(date);
    else kept.push(date);
  }
  if (droppedDates.length === 0) {
    return { datesInMonth: kept, daysInMonth: clipped.daysInMonth, droppedDates };
  }
  if (kept.length === 0) return { datesInMonth: [], daysInMonth: 0, droppedDates };

  const daysInMonth = Math.round(clipped.daysInMonth * (kept.length / clipped.datesInMonth.length) * 100) / 100;
  return { datesInMonth: kept, daysInMonth, droppedDates };
}

/**
 * WHETHER ONE LIVE LEDGER ROW STILL CLAIMS ITS DAYS AGAINST THIS RUN.
 *
 * 🔴 WHY THIS EXISTS, MEASURED ON PRODUCTION. Owner-reported 2026-10-07:
 * *"since u can read the vacation with no balance deductions correct why no
 * automated payroll showing the deductions i approved in deductions module"*.
 * The answer was that the connector was deleting its own work every time it ran.
 *
 * `collect.ts` registers both vacation collectors with `reconcilesWholeCategory`,
 * which means every live candidate in the category this run collects is the
 * run's to keep or to retire: a key the fresh scan does not produce IS
 * superseded. The already-claimed read, however, took every live candidate in
 * the month with no category filter — including the run's OWN rows from the
 * previous run. So the request path saw the day it charged last time, treated it
 * as taken, emitted no draft for it, and reconcile then retired the row for
 * being absent from the fresh scan. Every re-collect deleted the previous
 * re-collect's candidates, with `superseded_by_candidate_id` NULL because there
 * was no replacement to pair with, and the decision on each went with it.
 *
 * Measured for 2026-09 before this fix: `vacation_balance` held 11 candidate
 * keys and 29 superseded rows against 2 live ones, and 13 of the owner's
 * decisions had been erased — three of them approvals (1,050.00 + 500.00 +
 * 483.33 EGP). Nine approved, still-unpaid vacation requests worth 7,374.99 EGP
 * had no live candidate at all while the requests sat untouched in
 * `v2_vacation_requests`. `crm_vacation_signal` never churned because the CRM
 * path does not read the ledger — it defers to live HR requests directly — which
 * is why the one pushed vacation line survived.
 *
 * 🔴 A LOCKED ROW IS THE EXCEPTION AND MUST STAY CLAIMED. Reconcile refuses to
 * supersede a candidate with `locked_at` — published money is never retracted
 * automatically — so that row will still be live after this run. Re-charging its
 * day would put two live candidates on one employee-day, which
 * `findDayCollisions` cannot see (it only reports a day claimed by more than one
 * CATEGORY) and which surfaces as a raw unique_violation mid-publish from
 * `deductions_publication_lines_guard_day_overlap`.
 *
 * Another category's row always claims its day: this run will not touch it.
 */
export function ledgerRowStillClaimsItsDays(
  row: { category: string | null; lockedAt: string | null },
  reconciledCategory: string,
): boolean {
  // Not in this run's reconcile scope — it survives the run, so the day is taken.
  if (String(row.category ?? "") !== reconciledCategory) return true;
  // This run's own row. Only a published one survives; the rest are ours to replace.
  return Boolean(row.lockedAt);
}

/**
 * Every employee-day the live ledger already charges for this month, as
 * `${compactHrId}:${date}`. Superseded candidates do not count — they were
 * withdrawn, so the day is free again. Same read the holiday-bridge and DSM
 * no-record connectors make, narrowed by `ledgerRowStillClaimsItsDays` so a run
 * cannot block itself out of re-producing the candidates it owns.
 */
async function loadAlreadyDeductedDays(input: {
  monthKey: string;
  reconciledCategory: DeductionsCategory;
}): Promise<Set<string>> {
  // Paged: PostgREST stops a response at 1,000 rows, and a short ledger read would re-charge a day
  // that is already charged. An error never ends the walk early — it throws (fail closed).
  let data: LedgerClaimRow[];
  try {
    data = await fetchAllRows<LedgerClaimRow>(
      () =>
        getSupabaseAdmin()
          .from("deductions_candidates")
          .select("id, employee_hr_id_compact, dates, category, locked_at, source_system")
          .in("month_key", ledgerClaimMonthKeys(input.monthKey))
          .is("superseded_at", null),
      "id",
    );
  } catch (error) {
    // Fail closed. An unreadable ledger is not an empty one, and continuing would
    // recreate exactly the duplicates this guard exists to stop.
    throw new Error(`Vacation connector: failed to load already-deducted days: ${ledgerReadErrorText(error)}`);
  }
  // Skips a manual_hr placeholder row (its date is `${monthKey}-01`, not a detected day) and this
  // run's OWN category unless locked — see collectClaimedLedgerDays / ledgerRowStillClaimsItsDays.
  return collectClaimedLedgerDays(data, (row) =>
    ledgerRowStillClaimsItsDays({ category: row.category ?? null, lockedAt: row.locked_at ?? null }, input.reconciledCategory),
  );
}

async function collectVacationCandidatesByReason(input: {
  month: number;
  year: number;
  category: Extract<DeductionsCategory, "unpaid_vacation" | "insufficient_balance_vacation">;
  unpaidReasons: string[];
  reasonLabel: string;
}): Promise<DeductionsCandidateDraft[]> {
  const monthKey = `${input.year}-${String(input.month).padStart(2, "0")}`;
  const start = `${monthKey}-01`;
  const end = `${monthKey}-${String(lastDayOfMonth(input.year, input.month)).padStart(2, "0")}`;

  const { data, error } = await getSupabaseAdmin()
    .from("v2_vacation_requests")
    .select(
      "id,employee_hr_id,employee_name,start_date,end_date,status,payment_status,unpaid_duration_days,unpaid_reason,vacation_type,manager_hr_id,manager_of_manager_hr_id",
    )
    .eq("status", "approved")
    .gt("unpaid_duration_days", 0)
    .in("unpaid_reason", input.unpaidReasons)
    .lte("start_date", end)
    .gte("end_date", start);
  if (error) throw new Error(`Failed to load vacation requests: ${error.message}`);

  // B6. This connector used to emit no estimatedAmount at all, so every approved
  // unpaid-vacation candidate landed as a NULL amount — and publishMonth refuses a
  // month containing one. A single 0.5-day request therefore blocked the WHOLE
  // month's publish with no in-app way to resolve it (July 2026: Hany Saad Mohamed
  // Omar). Compute the money here, exactly as the CRM and No-Records connectors do.
  const [baseSalaryByCompact, alreadyDeducted] = await Promise.all([
    getBaseSalaryMap(),
    // Another category's live candidate can already have claimed some of these
    // days — see excludeAlreadyClaimedVacationDays. This run's OWN category is
    // excluded unless the row is locked, because reconcile retires whatever this
    // scan does not re-produce: counting it would delete this connector's own
    // candidates on every run (ledgerRowStillClaimsItsDays).
    loadAlreadyDeductedDays({ monthKey, reconciledCategory: input.category }),
  ]);
  // Fail closed: an empty map is a feeder outage, not "nobody has a salary".
  assertBaseSalaryMapLoaded("Vacation connector", baseSalaryByCompact);

  const drafts: DeductionsCandidateDraft[] = [];
  for (const row of (data ?? []) as VacationRequestRow[]) {
    const totalUnpaidDays = unpaidDays(row.unpaid_duration_days);
    if (totalUnpaidDays <= 0 || !row.employee_hr_id) continue;
    const startDate = row.start_date?.slice(0, 10) ?? start;
    const endDate = row.end_date?.slice(0, 10) ?? startDate;

    // Clip to THIS month. A request spanning the boundary must not contribute
    // its whole unpaid total to both months.
    const clipped = clipLeaveToMonth({ startDate, endDate, monthKey, totalUnpaidDays });
    if (clipped.daysInMonth <= 0 || clipped.datesInMonth.length === 0) continue;

    // getBaseSalaryMap is keyed by the COMPACT hr-id (hyphens stripped), not the
    // canonical one — using the wrong key silently misses every lookup, a bug the
    // CRM connector already hit once.
    const compactKey = compactDeductionsHrId(row.employee_hr_id);

    // Drop any day a live candidate already charges — most often a
    // `crm_vacation_signal` row this connector itself created on an earlier run
    // for a day that had no HR request yet. Done BEFORE the money is computed,
    // so the amount follows the days that actually survive.
    const afterLedger = excludeAlreadyClaimedVacationDays({
      clipped,
      alreadyDeducted,
      employeeHrIdCompact: compactKey,
    });
    if (afterLedger.daysInMonth <= 0 || afterLedger.datesInMonth.length === 0) continue;

    const baseSalary = compactKey ? (baseSalaryByCompact.get(compactKey) ?? null) : null;
    const estimatedAmount = calculateDeductionAmountFromBaseSalary({
      baseSalary,
      deductionDays: afterLedger.daysInMonth,
      month: input.month,
      year: input.year,
    });

    drafts.push({
      category: input.category,
      sourceSystem: "vacation_balance",
      sourceRecordId: `vacation:${row.id}:${input.category}`,
      employeeHrId: row.employee_hr_id,
      employeeName: row.employee_name,
      monthKey,
      month: input.month,
      year: input.year,
      unit: "days",
      rawValue: afterLedger.daysInMonth,
      estimatedAmount,
      calculationStatus: estimatedAmount != null ? "calculated" : "requires_review",
      severity: "Medium",
      reason: [
        input.reasonLabel,
        clipped.spansMonthBoundary
          ? `${clipped.daysInMonth} of ${totalUnpaidDays} unpaid day(s) fall in this month (request runs ${startDate} to ${endDate})`
          : null,
        afterLedger.droppedDates.length > 0
          ? `${afterLedger.droppedDates.length} day(s) are already deducted under another candidate and were left out (${afterLedger.droppedDates.join(", ")})`
          : null,
      ]
        .filter(Boolean)
        .join(" — "),
      evidence: {
        requestId: row.id,
        paymentStatus: row.payment_status,
        status: row.status,
        unpaidReason: row.unpaid_reason,
        vacationType: row.vacation_type,
        requestStartDate: startDate,
        requestEndDate: endDate,
        totalUnpaidDaysOnRequest: totalUnpaidDays,
        spansMonthBoundary: clipped.spansMonthBoundary,
        // Apportioned pro-rata: v2_vacation_requests stores only a total, never
        // which specific days were the unpaid ones.
        apportionment: clipped.spansMonthBoundary
          ? `${clipped.datesInMonth.length} of ${clipped.totalSpanDays} calendar day(s) in this month`
          : null,
        // A data-quality flag, not a business outcome — lets a future report
        // surface "N unpaid-vacation rows exist only because hire_date is missing".
        dataQualityFlag: row.unpaid_reason === "missing_hire_date" ? "missing_hire_date" : null,
        // Which days another live candidate already charges, and what the row
        // would have been without that check — so a reviewer can see why this
        // request is priced below its own unpaid total.
        daysAlreadyClaimedByAnotherCandidate: afterLedger.droppedDates,
        daysInMonthBeforeLedgerCheck: afterLedger.droppedDates.length > 0 ? clipped.daysInMonth : null,
      },
      // Every real in-month calendar day, not just [start, end]. The old two-date
      // form made days 2..n-1 invisible to same-day overlap detection.
      dates: afterLedger.datesInMonth,
      hierarchySnapshot: {
        managerHrId: row.manager_hr_id,
        managerOfManagerHrId: row.manager_of_manager_hr_id,
      },
    });
  }
  return drafts;
}

/**
 * VACATIONS ARE SUBMITTED IN TWO PLACES, AND THIS CONNECTOR ONLY EVER READ ONE.
 *
 * `v2_vacation_requests` is the HR system. But a vacation can also be entered on CRM —
 * iReports360 visit type -4, "Annual Vacation", which `ireports360-source.ts` maps to the
 * "AV" status. That second source was invisible here, so an employee who took leave on CRM
 * with no balance to cover it generated NO candidate at all.
 *
 * This is the only under-detection in the module: every other defect found on 2026-08-02
 * over-charged. Measured on July 2026 production: 84 CRM vacation days across 43 employees
 * had no matching HR request. Running each through the balance engine, 61 were covered by
 * balance and 23 were not — 15 Medical Reps hired Jan–May 2026, all `first_six_months`,
 * 10,725.76 EGP that should have been deducted and was not.
 *
 * WHY IT CALLS THE ENGINE RATHER THAN JUDGING BALANCE ITSELF
 *
 * There is no balance table. A balance is derived per employee from the hire-date-anchored
 * entitlement period, approved requests inside it, days consumed via payroll settlement,
 * and debt carried forward from prior periods. `calculatePaymentForRequest` is the same
 * function that runs when someone files a request, so calling it keeps this connector and
 * the vacation module in agreement by construction. Re-deriving the arithmetic is exactly
 * how two `calculateDeductionAmountFromBaseSalary` functions came to disagree on a divisor.
 *
 * The unpaid REASON the engine returns decides the category, so a CRM day lands in the same
 * bucket an identical HR request would.
 */
async function collectCrmSubmittedUnpaidVacationDays(input: {
  month: number;
  year: number;
  category: Extract<DeductionsCategory, "unpaid_vacation" | "insufficient_balance_vacation">;
  unpaidReasons: string[];
}): Promise<DeductionsCandidateDraft[]> {
  const monthKey = `${input.year}-${String(input.month).padStart(2, "0")}`;
  const start = `${monthKey}-01`;
  const end = `${monthKey}-${String(lastDayOfMonth(input.year, input.month)).padStart(2, "0")}`;
  const supabase = getSupabaseAdmin();

  const baseSalaryByCompact = await getBaseSalaryMap();
  assertBaseSalaryMapLoaded("Vacation connector (CRM source)", baseSalaryByCompact);

  // The CRM mirror is read through src/lib/crm's single door, never queried directly —
  // `tests/crm-single-source-door` enforces that, and it caught the first cut of this.
  //
  // INCLUDING DEPARTED on purpose. The plain scan hides a resigned rep's visits from
  // company-wide views, but that read's own doc says a caller looking up one person's own
  // history for payroll must not have it hidden. A leaver's unpaid vacation is still owed,
  // so excluding them would silently drop exactly the people whose final month matters.
  const [{ data: employeeRows, error: employeeError }, visits, { data: requestRows, error: requestError }] =
    await Promise.all([
      supabase.from("employees").select("hr_id,full_name,crm_id,hire_date,last_working_date"),
      // `ampm` and the NON-vacation rows are both needed to spot a part-day. A
      // rep can log AM annual leave and then work the afternoon — see the mixed
      // day below — and filtering to visit_type -4 before looking would throw
      // away the very evidence that says it was half a day.
      scanVisitsForRangeIncludingDeparted<{
        agent_crm_id: unknown;
        agent_hr_id: unknown;
        visit_date: unknown;
        visit_type: unknown;
        ampm: unknown;
      }>({
        // agent_hr_id: the sync's employment-guarded stamp — see resolveCrmVacationEmployee.
        columns: "agent_crm_id,agent_hr_id,visit_date,visit_type,ampm",
        dateFrom: start,
        dateTo: end,
      }),
      supabase.from("v2_vacation_requests").select("employee_hr_id,start_date,end_date").lte("start_date", end).gte("end_date", start),
    ]);
  // Fail closed on every read. A silent empty result here means "nobody took CRM leave",
  // which is indistinguishable from the outage that produced this gap in the first place.
  // (scanVisitsForRangeIncludingDeparted throws on failure rather than returning empty.)
  if (employeeError) throw new Error(`Vacation connector: employees read failed: ${employeeError.message}`);
  if (requestError) throw new Error(`Vacation connector: vacation request read failed: ${requestError.message}`);
  // This scan now feeds a RECONCILE, not an insert-only pass: a day it does not
  // return is superseded in the ledger. An empty mirror would therefore RETRACT
  // vacation days that really happened, not merely miss them, so zero visits
  // company-wide for a whole month has to fail the run. Zero ANNUAL-LEAVE rows is
  // a legitimate answer and is checked against the whole scan, not the -4 subset.
  assertSourceScanned("Vacation connector (CRM source)", visits.length, "the iReports360 visit mirror");
  const visitRows = visits.filter((visit) => Number(visit.visit_type) === CRM_ANNUAL_VACATION_VISIT_TYPE);

  // MIXED DAYS: a date carrying BOTH a vacation record and real work.
  //
  // Owner's rule (2026-08-03): such a day must not be charged as a full day
  // unattended. Measured on July 2026 production, 19 days across 17 people look
  // like this — roughly one vacation day in four — and each was being charged at
  // 1.00 day. One rep logged AM annual leave and then filed 9 afternoon records;
  // he was charged a full day three times over.
  //
  // The `ampm` values are kept as evidence rather than acted on: the system can
  // see it was probably half a day, but the owner confirms full/AM/PM and the
  // applied value follows that decision, because this is pay.
  const workAmpmByDay = new Map<string, Set<string>>();
  const vacationAmpmByDay = new Map<string, Set<string>>();
  for (const visit of visits) {
    const personKey = crmVacationPersonKey(visit.agent_crm_id, visit.agent_hr_id);
    const day = String(visit.visit_date ?? "").slice(0, 10);
    if (!personKey || !day) continue;
    const key = `${personKey}:${day}`;
    const ampm = String(visit.ampm ?? "").trim().toUpperCase();
    const bucket = Number(visit.visit_type) === CRM_ANNUAL_VACATION_VISIT_TYPE ? vacationAmpmByDay : workAmpmByDay;
    const set = bucket.get(key) ?? new Set<string>();
    if (ampm) set.add(ampm);
    bucket.set(key, set);
  }

  const employeeByCrmId = new Map<string, CrmVacationEmployee>();
  const employeeByHrIdKey = new Map<string, CrmVacationEmployee>();
  for (const row of (employeeRows ?? []) as Array<{
    hr_id: string;
    full_name: string | null;
    crm_id: string | null;
    hire_date: string | null;
    last_working_date: string | null;
  }>) {
    const employee: CrmVacationEmployee = {
      hrId: row.hr_id,
      name: row.full_name,
      hireDate: row.hire_date,
      lastWorkingDate: row.last_working_date ? String(row.last_working_date).slice(0, 10) : null,
    };
    const crmId = row.crm_id != null ? String(row.crm_id).trim() : "";
    if (crmId) employeeByCrmId.set(crmId, employee);
    const hrKey = canonicalHrIdKey(row.hr_id);
    if (hrKey) employeeByHrIdKey.set(hrKey, employee);
  }

  // Keyed canonically, never on the raw string. The two sides come from different
  // tables (employees.hr_id vs v2_vacation_requests.employee_hr_id); a case or
  // spacing difference between them would silently miss the coverage lookup, and
  // a missed lookup here is a day charged twice, not a cosmetic mismatch.
  const coveredByHrId = new Map<string, Array<{ start: string; end: string }>>();
  for (const row of (requestRows ?? []) as Array<{ employee_hr_id: string | null; start_date: string | null; end_date: string | null }>) {
    const hrId = canonicalHrIdKey(row.employee_hr_id);
    if (!hrId || !row.start_date) continue;
    const list = coveredByHrId.get(hrId) ?? [];
    list.push({ start: String(row.start_date).slice(0, 10), end: String(row.end_date ?? row.start_date).slice(0, 10) });
    coveredByHrId.set(hrId, list);
  }

  // One entry per (employee, day): several -4 rows on one date is still one vacation day.
  const daysByHrId = new Map<
    string,
    { name: string | null; hireDate: string | null; personKey: string; days: Set<string> }
  >();
  for (const visit of (visitRows ?? []) as Array<{ agent_crm_id: unknown; agent_hr_id: unknown; visit_date: unknown }>) {
    const crmId = String(visit.agent_crm_id ?? "").trim();
    const day = String(visit.visit_date ?? "").slice(0, 10);
    if (!day) continue;
    const employee = resolveCrmVacationEmployee({
      monthKey,
      day,
      crmId,
      agentHrId: visit.agent_hr_id == null ? null : String(visit.agent_hr_id),
      byCrmId: employeeByCrmId,
      byHrIdKey: employeeByHrIdKey,
    });
    if (!employee) continue;
    const covered = (coveredByHrId.get(canonicalHrIdKey(employee.hrId) ?? "") ?? []).some(
      (range) => day >= range.start && day <= range.end,
    );
    // An HR request already covers this day — the request path above owns it, and taking
    // it here too would double-book the same absence.
    if (covered) continue;
    const entry = daysByHrId.get(employee.hrId) ?? {
      name: employee.name,
      hireDate: employee.hireDate,
      personKey: crmVacationPersonKey(visit.agent_crm_id, visit.agent_hr_id),
      days: new Set<string>(),
    };
    entry.days.add(day);
    daysByHrId.set(employee.hrId, entry);
  }

  const drafts: DeductionsCandidateDraft[] = [];
  for (const [hrId, entry] of daysByHrId) {
    // No hire date means no entitlement period, so the balance is uncomputable. The HR
    // path treats that as `missing_hire_date`; here it would be a guess, so skip rather
    // than charge on an assumption.
    if (!entry.hireDate) continue;

    // Chronological, and consumption is tracked locally: these days are not persisted, so
    // the engine judges every one of them against the same untouched balance. Without this
    // a single remaining day would "cover" several dates at once.
    const orderedDays = [...entry.days].sort();
    let consumedSoFar = 0;
    for (const day of orderedDays) {
      const snapshot = await calculatePaymentForRequest({
        durationDays: 1,
        employeeHrId: hrId,
        hireDate: entry.hireDate,
        startDate: day,
        vacationType: "annual",
      });
      const balanceBefore = snapshot.balanceBeforeDays - consumedSoFar;
      consumedSoFar += 1;

      const unpaid = balanceBefore <= 0 || snapshot.unpaidDurationDays > 0;
      if (!unpaid) continue;
      // Route by the engine's own reason so a CRM day lands in the same category an
      // identical HR request would. A reason outside this collector's set belongs to the
      // sibling collector, not here.
      const reason = snapshot.unpaidReason ?? (balanceBefore <= 0 ? "insufficient_balance" : null);
      if (!reason || !input.unpaidReasons.includes(reason)) continue;

      const compactKey = compactDeductionsHrId(hrId);
      const baseSalary = compactKey ? (baseSalaryByCompact.get(compactKey) ?? null) : null;
      const estimatedAmount = calculateDeductionAmountFromBaseSalary({
        baseSalary,
        deductionDays: 1,
        month: input.month,
        year: input.year,
      });
      if (estimatedAmount == null) continue; // no salary basis => no salary-based deduction

      // Did this SAME day also carry real work? If so it is very likely a part
      // day, and it is flagged for the owner to confirm full/AM/PM rather than
      // charged at 1.00 on the connector's own authority.
      const dayKey = `${entry.personKey}:${day}`;
      const workAmpm = [...(workAmpmByDay.get(dayKey) ?? [])].sort();
      const vacationAmpm = [...(vacationAmpmByDay.get(dayKey) ?? [])].sort();
      const isMixedDay = workAmpm.length > 0;

      drafts.push({
        category: input.category,
        sourceSystem: "crm_vacation_signal",
        sourceRecordId: `crm-vacation:${hrId}:${day}:${input.category}`,
        employeeHrId: hrId,
        employeeName: entry.name,
        monthKey,
        month: input.month,
        year: input.year,
        unit: "days",
        // Still 1 — that is what was DETECTED. The reviewer lowers it to 0.5 via
        // the applied-days control if they judge it a half day. Pre-setting 0.5
        // here would be the connector deciding, which is what the flag exists to
        // avoid.
        rawValue: 1,
        estimatedAmount,
        // requires_review is the flag. A mixed day must never look settled.
        calculationStatus: isMixedDay ? "requires_review" : "calculated",
        severity: isMixedDay ? "Review" : "Medium",
        reason: isMixedDay
          ? `REVIEW: vacation AND work recorded on the same day (leave ${vacationAmpm.join("/") || "?"}, work ${workAmpm.join("/")}) — confirm full day, AM or PM before deducting`
          : `Vacation taken on CRM with no HR request, and not covered by balance (${reason})`,
        evidence: {
          source: "ireports360 visit_type -4 (Annual Vacation)",
          // The AM/PM split is recorded whether or not it is a mixed day, so a
          // reviewer can see WHY it was flagged without leaving the screen.
          mixedDay: isMixedDay,
          vacationAmpm,
          workAmpm,
          unpaidReason: reason,
          entitlementDays: snapshot.entitlementDays,
          balanceBeforeDays: Math.round(balanceBefore * 100) / 100,
          periodStart: snapshot.periodStart,
          periodEnd: snapshot.periodEnd,
          hireDate: entry.hireDate,
        },
        dates: [day],
      });
    }
  }

  return drafts;
}

/**
 * ONE EMPLOYEE-DAY OF UNPAID VACATION IS CHARGEABLE ONCE, AND THE HR REQUEST WINS.
 *
 * It is the human-filed record: someone applied, a manager approved it, and the
 * balance engine priced it. A CRM annual-leave record is a detection of the same
 * absence, so where both describe a day, only the request may charge it.
 *
 * The CRM scan already skips a day an HR request covers, but that guard is one
 * directional and buried inside the scan, so it holds only for the two drafts of
 * a single run. Stating the rule here — where the two sources are combined, and
 * where the next reader looks — is what stops a future widening of either query
 * from reintroducing the duplicate. It is also the only form of the rule that
 * can be unit-tested: both sources are Supabase-backed, this is not.
 *
 * The stale half of the pair is a separate problem: a CRM candidate written
 * before the request was filed stays live, and the (category, candidate_key)
 * unique index cannot see it because the two keys differ only by their source
 * prefix. `collect.ts` reconciles this category so that older row is superseded
 * rather than left to charge the same day again (July 2026 production: 19
 * employee-days, 8,822.54 EGP).
 */
export function mergeVacationSourcesHrRequestWins(input: {
  fromCrm: readonly DeductionsCandidateDraft[];
  fromRequests: readonly DeductionsCandidateDraft[];
}): DeductionsCandidateDraft[] {
  const claimedByRequest = new Set<string>();
  for (const draft of input.fromRequests) {
    const hrKey = canonicalHrIdKey(draft.employeeHrId);
    if (!hrKey) continue;
    for (const date of draft.dates) {
      claimedByRequest.add(`${hrKey}:${date}`);
    }
  }

  const crmDraftsNotAlreadyClaimed = input.fromCrm.filter((draft) => {
    const hrKey = canonicalHrIdKey(draft.employeeHrId);
    // An unidentifiable employee cannot be matched against a request, and
    // dropping it here would silently lose a real absence — the service layer
    // rejects the draft and reports it instead.
    if (!hrKey) return true;
    return !draft.dates.some((date) => claimedByRequest.has(`${hrKey}:${date}`));
  });

  return [...input.fromRequests, ...crmDraftsNotAlreadyClaimed];
}

export async function collectUnpaidVacationCandidates(input: {
  month: number;
  year: number;
}): Promise<DeductionsCandidateDraft[]> {
  const unpaidReasons = ["first_six_months", "missing_hire_date"];
  const [fromRequests, fromCrm] = await Promise.all([
    collectVacationCandidatesByReason({
      ...input,
      category: "unpaid_vacation",
      unpaidReasons,
      reasonLabel: "Approved vacation is unpaid (not yet entitled within first 6 months, or hire date missing)",
    }),
    collectCrmSubmittedUnpaidVacationDays({ ...input, category: "unpaid_vacation", unpaidReasons }),
  ]);
  return mergeVacationSourcesHrRequestWins({ fromCrm, fromRequests });
}

export async function collectInsufficientBalanceVacationCandidates(input: {
  month: number;
  year: number;
}): Promise<DeductionsCandidateDraft[]> {
  const unpaidReasons = ["insufficient_balance"];
  const [fromRequests, fromCrm] = await Promise.all([
    collectVacationCandidatesByReason({
      ...input,
      category: "insufficient_balance_vacation",
      unpaidReasons,
      reasonLabel: "Approved vacation includes unpaid days because balance was insufficient",
    }),
    collectCrmSubmittedUnpaidVacationDays({ ...input, category: "insufficient_balance_vacation", unpaidReasons }),
  ]);
  return mergeVacationSourcesHrRequestWins({ fromCrm, fromRequests });
}
