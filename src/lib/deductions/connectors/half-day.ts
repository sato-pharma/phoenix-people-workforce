// Unified Deductions module: Half Day (CRM) — the morning or afternoon nobody accounted for.
//
// Owner, 2026-10-08: "identify the AM only working days and the PM only working days for district
// managers or for medical reps and make it an extra tab to show me who didn't work half a day and
// was not submitting a vacation or anything … consider, when reading from the old CRM, the
// campaign visits." Then: "Thursday is AM only, exclude national vacations and approved
// vacations." And for managers: "a manager is a normal employee. He has a half day with no
// record — show it. But before you show it, confirm that this is a real no-record day", naming the
// double visit that vanished when the rep resigned — and "neglect how many are his team".
//
// The rule itself — which half a CRM row covers, what clears a missing half — is pure and lives in
// ../half-day-rule.ts with its own account. This file only gathers the sources and writes rows:
//
//   - ONE ROW PER EMPLOYEE-DAY, rawValue 0.5, priced Base ÷ the month's calendar days × 0.5 — so
//     each half day is decided on its own, and a row can never be half-approved.
//   - Category `crm_half_day`, which REQUIRES APPROVAL: nothing is charged until he sets the row
//     "Approved for Payroll". Its salary column is CRM's, so an approved half day reaches the same
//     payroll step as a CRM no-activity day.
//   - The month's visits are read WITH departed agents' rows. A district manager's fieldwork is the
//     rep's visit row; the default scan hides every row a rep logged once he resigns, and that is
//     precisely the vanished double visit the owner named. The resigned rep's OWN half days in his
//     final month need his own rows too.
//
// Never runs on an unfinished month (collect.ts refuses it), never in the CRM cutover month (owner
// decision 18), and never on a day the company-wide CRM feed looks broken.

import { queryCheckins, scanVisitsForRangeIncludingDeparted } from "@/lib/crm/reads";
import { isCrmCutoverMonth, readCrmCutoverSetting } from "@/lib/crm/cutover.ts";
import { logsOwnCrmVisitsTitle } from "@/lib/field-workforce-compliance/eligibility.ts";
import { isFieldWorkforceThursday } from "@/lib/field-workforce-compliance/weekend-policy.ts";
import { getBaseSalaryMap } from "@/lib/payroll/copilot/feeders.ts";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";

import { DEDUCTIONS_CATEGORY_CONFIG, calculateDeductionAmountFromBaseSalary } from "../calculations.ts";
import { compactDeductionsHrId } from "../candidate-key.ts";
import { collectClaimedLedgerDays, type LedgerClaimRow } from "../conflict.ts";
import {
  buildHalfDayEvidence,
  buildHalfDayIdentity,
  countGpsTracesByDate,
  halfDayReason,
  judgeHalfDay,
  type HalfDayCheckinRow,
  type HalfDayCover,
  halfDayContractOf,
  type HalfDayVisitRow,
} from "../half-day-rule.ts";
import { addDaysIso, isFieldForceWorkingDay } from "../holiday-bridge.ts";
import { loadProvenWorkedDays } from "../proven-worked-days.ts";
import type { DeductionsCandidateDraft, DeductionsCategory } from "../types.ts";
import { DeductionsConnectorDegradedError, assertBaseSalaryMapLoaded } from "./health.ts";
import { ledgerClaimMonthKeys } from "../cycle.ts";
import { detectSuspectDatesFromCounts, getSuspectDatesForMonth } from "./crm.ts";
import { ledgerRowStillClaimsItsDays } from "./vacation.ts";

export const HALF_DAY_CATEGORY: DeductionsCategory = "crm_half_day";
export const HALF_DAY_SOURCE_SYSTEM = "crm_half_day";
const CONNECTOR = "Half Day (CRM) connector";

/** District managers — the same title test the district-manager no-record connector uses. */
const DISTRICT_MANAGER_TITLE = /district\s+(sales\s+)?manager/i;

/** Who this tab judges: medical reps (the system's own "logs his own CRM visits" rule) and district managers. */
export function isHalfDayPopulationTitle(title: string | null | undefined): "rep" | "district_manager" | null {
  if (DISTRICT_MANAGER_TITLE.test(String(title ?? ""))) return "district_manager";
  if (logsOwnCrmVisitsTitle(title)) return "rep";
  return null;
}

/** Statuses that mean the employee asked for nothing (rejected) — every other undecided state is a request on file. */
const VACATION_IGNORED_STATUSES = new Set(["rejected", "cancelled"]);

function monthBounds(month: number, year: number) {
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days: string[] = [];
  for (let day = 1; day <= lastDay; day += 1) days.push(`${monthKey}-${String(day).padStart(2, "0")}`);
  return { monthKey, start: days[0]!, end: days[days.length - 1]!, days };
}

/** National-holiday dates in the month. Fails closed: a half day must never be charged on a public holiday. */
async function holidayDates(month: number, year: number): Promise<Set<string>> {
  const result = await getConfirmedNationalHolidays({ month, year });
  if (!result.calendarReachable) {
    throw new DeductionsConnectorDegradedError(
      CONNECTOR,
      "the Egypt national-holiday calendar could not be read, so a public holiday could be charged as a half day",
    );
  }
  const dates = new Set<string>();
  for (const holiday of result.holidays) {
    const end = holiday.endDate ?? holiday.startDate;
    let cursor = holiday.startDate;
    for (let guard = 0; guard < 40 && cursor <= end; guard += 1) {
      dates.add(cursor);
      cursor = addDaysIso(cursor, 1);
    }
  }
  return dates;
}

async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T[]> {
  const size = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw new Error(`${CONNECTOR}: failed to load ${what}: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < size) return rows;
  }
}

type EmployeeRow = {
  hr_id: string | null;
  full_name: string | null;
  job_title: string | null;
  hire_date: string | null;
  last_working_date: string | null;
  employment_status: string | null;
  crm_id: string | number | null;
  /** The contracted working pattern — full_day, am_only or pm_only. */
  work_half: string | null;
};

/** The connector's result: the rows, plus what it could NOT raise and why — never dropped silently. */
export type HalfDayCollection = { drafts: DeductionsCandidateDraft[]; notes: string[] };

export async function collectHalfDayCandidates(input: { month: number; year: number; createdBy: string }): Promise<HalfDayCollection> {
  // OWNER DECISION 18: nothing CRM-derived is charged in the month Phoenix replaced iReports360.
  // Read fresh and THROWING on failure, like the CRM connector.
  if (isCrmCutoverMonth(await readCrmCutoverSetting(), input)) {
    return { drafts: [], notes: [`${CONNECTOR}: this is the CRM cutover month — no half day is charged in it (owner decision 18).`] };
  }

  const { monthKey, start, end, days } = monthBounds(input.month, input.year);
  const supabase = getSupabaseAdmin();

  const [holidays, suspectDates, baseSalaryByCompact, employees, visits, checkins, vacations, disputes, ledger] =
    await Promise.all([
      holidayDates(input.month, input.year),
      // Throws on a CRM outage; a day the whole feed looks broken is nobody's half day.
      getSuspectDatesForMonth(input.month, input.year),
      getBaseSalaryMap(),
      readAll<EmployeeRow>(
        (from, to) =>
          supabase
            .from("employees")
            .select("hr_id, full_name, job_title, hire_date, last_working_date, employment_status, crm_id, work_half")
            .order("hr_id", { ascending: true })
            .range(from, to),
        "the employee directory",
      ),
      scanVisitsForRangeIncludingDeparted<HalfDayVisitRow>({
        dateFrom: start,
        dateTo: end,
        columns:
          "visit_date, visit_type, ampm, crm_save_date, agent_hr_id, agent_crm_id, double_hr_id, double_crm_id, double2_hr_id, double2_crm_id, contact_crm_id, source, lat, lon",
      }),
      // One day past the month: a check-in after midnight is the tail of the last evening.
      // includeResignedAgents: a check-in only ever CLEARS a half here, and a resigned rep's
      // check-in is the time of the double visit his manager is credited on.
      queryCheckins<HalfDayCheckinRow>({
        columns: "agent_hr_id, agent_crm_id, contact_crm_id, check_date",
        dateFrom: start,
        dateTo: addDaysIso(end, 1),
        includeResignedAgents: true,
      }),
      readAll<{ employee_hr_id: string | null; start_date: string | null; end_date: string | null; day_part: string | null; status: string | null }>(
        (from, to) =>
          supabase
            .from("v2_vacation_requests")
            .select("employee_hr_id, start_date, end_date, day_part, status")
            .lte("start_date", end)
            .or(`end_date.gte.${start},end_date.is.null`)
            .order("id", { ascending: true })
            .range(from, to),
        "vacation requests",
      ),
      readAll<{ employee_hr_id: string | null; dispute_date: string | null; status: string | null }>(
        (from, to) =>
          supabase
            .from("private_calendar_data_disputes")
            .select("employee_hr_id, dispute_date, status")
            .gte("dispute_date", start)
            .lte("dispute_date", end)
            .order("id", { ascending: true })
            .range(from, to),
        "calendar review requests",
      ),
      readAll<LedgerClaimRow & { employee_name: string | null }>(
        (from, to) =>
          supabase
            .from("deductions_candidates")
            .select("employee_hr_id_compact, employee_name, dates, category, locked_at, source_system")
            .in("month_key", ledgerClaimMonthKeys(monthKey))
            .is("superseded_at", null)
            .order("id", { ascending: true })
            .range(from, to),
        "the live deductions ledger",
      ),
    ]);
  assertBaseSalaryMapLoaded(CONNECTOR, baseSalaryByCompact);

  // A month with no CRM rows at all is an unreadable feed, not a month nobody worked — and the only
  // thing that could then reach this tab is the other half of an approved half-day vacation.
  if (visits.length === 0) {
    throw new DeductionsConnectorDegradedError(CONNECTOR, `the CRM visit feed returned no rows for ${monthKey}`);
  }
  // Each day's GPS traces: iReports360 check-ins plus Phoenix visit captures (a started team's check-ins).
  const gpsTraceCounts = countGpsTracesByDate({ days, visits, checkins });
  const gpsTraceTotal = [...gpsTraceCounts.values()].reduce((sum, count) => sum + count, 0);
  // GPS only ever clears a half. A dense month with none means the check-in read failed, and
  // judging without it would charge mornings the GPS proves were worked.
  if (visits.length >= 1000 && gpsTraceTotal === 0) {
    throw new DeductionsConnectorDegradedError(CONNECTOR, `the GPS check-in feed returned no rows for ${monthKey} against ${visits.length} visits`);
  }

  const identity = buildHalfDayIdentity([
    ...employees.map((row) => ({ hrId: row.hr_id, crmId: row.crm_id })),
    // A resigned rep's crm id is cleared from the directory; his own resolved rows still carry it.
    ...visits.map((row) => ({ hrId: row.agent_hr_id, crmId: row.agent_crm_id })),
    ...visits.map((row) => ({ hrId: row.double_hr_id, crmId: row.double_crm_id })),
    // Slot 2 as well. `buildHalfDayEvidence` already resolves that slot, so leaving its pairs out
    // of the identity map meant a chain visit's SECOND manager could only ever be found by his hr
    // id — the one lookup that is null while the mirror backfills it.
    ...visits.map((row) => ({ hrId: row.double2_hr_id, crmId: row.double2_crm_id })),
  ]);
  const { byPersonDay, firstSignalByPerson, unattributable } = buildHalfDayEvidence({ visits, checkins, identity });

  // Everything else on file, per `${compact}:${date}`.
  const cover = new Map<string, HalfDayCover>();
  const coverFor = (key: string) => {
    const known = cover.get(key);
    if (known) return known;
    const fresh: HalfDayCover = {};
    cover.set(key, fresh);
    return fresh;
  };
  for (const request of vacations) {
    const compact = compactDeductionsHrId(request.employee_hr_id ?? "");
    const status = String(request.status ?? "").trim().toLowerCase();
    if (!compact || !request.start_date || VACATION_IGNORED_STATUSES.has(status)) continue;
    const approved = status === "approved";
    const dayPart = String(request.day_part ?? "full_day").trim().toLowerCase();
    const last = (request.end_date ?? request.start_date).slice(0, 10);
    let cursor = request.start_date.slice(0, 10);
    for (let guard = 0; guard < 400 && cursor <= last; guard += 1) {
      if (cursor >= start && cursor <= end) {
        const entry = coverFor(`${compact}:${cursor}`);
        // Undecided, waiting on another approver, or returned for edit: he DID submit something,
        // so the day waits for that decision instead of being charged around it.
        if (!approved || dayPart === "full_day") entry.leaveTheDayAlone = true;
        else if (dayPart === "am_only") entry.vacationAm = true;
        else if (dayPart === "pm_only") entry.vacationPm = true;
        else entry.leaveTheDayAlone = true;
      }
      cursor = addDaysIso(cursor, 1);
    }
  }
  for (const dispute of disputes) {
    const compact = compactDeductionsHrId(dispute.employee_hr_id ?? "");
    const date = String(dispute.dispute_date ?? "").slice(0, 10);
    if (!compact || !date || String(dispute.status ?? "").trim().toLowerCase() === "rejected") continue;
    coverFor(`${compact}:${date}`).leaveTheDayAlone = true;
  }
  // Days another live deduction already charges — the publish guard allows one row per
  // employee-day, so those are reported below rather than raised. This run's own unpublished rows
  // do NOT claim their days; otherwise every second re-run would retract the first.
  const claimed = collectClaimedLedgerDays(ledger, (row) =>
    ledgerRowStillClaimsItsDays({ category: row.category ?? null, lockedAt: row.locked_at ?? null }, HALF_DAY_CATEGORY),
  );
  const claimingCategory = new Map<string, string>();
  for (const row of ledger) {
    if (row.category === HALF_DAY_CATEGORY && !row.locked_at) continue;
    const compact = String(row.employee_hr_id_compact ?? "").trim();
    if (!compact || !Array.isArray(row.dates)) continue;
    for (const date of row.dates as unknown[]) {
      if (typeof date === "string") claimingCategory.set(`${compact}:${date}`, String(row.category ?? ""));
    }
  }

  // A day whose GPS arrived short is judged with nothing to clear a half — the sync keeps visits
  // when a check-in fetch fails. Same detector as the CRM gap days, on the GPS trace count.
  const gpsGapDates = detectSuspectDatesFromCounts(gpsTraceCounts);

  // Saturday to Wednesday only: Friday is off and Thursday is a morning-only day with no afternoon
  // to miss. National holidays, company-wide CRM gap days and GPS gap days are nobody's half day.
  const judgedDays = days.filter(
    (day) =>
      isFieldForceWorkingDay(day) &&
      !isFieldWorkforceThursday(day) &&
      !holidays.has(day) &&
      !suspectDates.has(day) &&
      !gpsGapDates.has(day),
  );

  const provenWorked = await loadProvenWorkedDays({ end, start });

  const drafts: DeductionsCandidateDraft[] = [];
  const notes: string[] = [];
  const unpriced: string[] = [];
  const collided: string[] = [];
  for (const employee of employees) {
    const hrId = String(employee.hr_id ?? "").trim();
    const compact = compactDeductionsHrId(hrId);
    const role = isHalfDayPopulationTitle(employee.job_title);
    if (!compact || !role) continue;
    const status = String(employee.employment_status ?? "").trim().toLowerCase();
    if (status === "declined_offer") continue;
    // 🔴 A part-half contract means the other half was never owed. Read before any day is judged,
    // so a PM-only rep is not charged for a morning his contract does not include.
    const contractHalf = halfDayContractOf(employee.work_half);
    const hireDate = employee.hire_date ? employee.hire_date.slice(0, 10) : null;
    const lastDay = employee.last_working_date ? employee.last_working_date.slice(0, 10) : null;
    // A leaver is judged up to his last working day; one with no last day on file is not judged at all.
    // "active" and "on_leave" are the directory's two live statuses (isActiveLifecycleStatus).
    if (status !== "active" && status !== "on_leave" && !lastDay) continue;
    // CRM must know him before a day of his can be judged: before his first record of the month
    // there is nothing to measure a half against (onboarding, or a long unrecorded leave).
    const firstSignal = firstSignalByPerson.get(compact);
    if (!firstSignal) continue;

    const baseSalary = baseSalaryByCompact.get(compact) ?? null;
    let unpricedDays = 0;
    for (const day of judgedDays) {
      if (hireDate && day < hireDate) continue;
      if (lastDay && day > lastDay) continue;
      if (day < firstSignal) continue;
      const key = `${compact}:${day}`;
      // PHOENIX CRM, WHETHER OR NOT THE TEAM WAS STARTED. On an unstarted team his Phoenix visits
      // never reach the read door, so `byPersonDay` holds neither half of his day and the rule reads
      // the worked half as uncovered. Suppressed here rather than fed into `cover` or `byPersonDay`,
      // which also feed `firstSignalByPerson` — and a person whose only record is Phoenix must stay
      // unjudged rather than become chargeable.
      if (provenWorked.keys.has(key)) continue;
      // The contracted half travels with the person, not with the day, so it is merged onto
      // whatever else is on file for this day rather than stored per day.
      const verdict = judgeHalfDay(byPersonDay.get(key), { ...(cover.get(key) ?? {}), contractHalf });
      if (verdict.kind !== "half_day") continue;
      if (claimed.has(key)) {
        const category = claimingCategory.get(key);
        const label = category ? DEDUCTIONS_CATEGORY_CONFIG[category as DeductionsCategory]?.label : undefined;
        collided.push(`${employee.full_name ?? "Unnamed employee"} on ${day} (${label ?? "another deduction"})`);
        continue;
      }
      const estimatedAmount = calculateDeductionAmountFromBaseSalary({
        baseSalary,
        deductionDays: 0.5,
        month: input.month,
        year: input.year,
      });
      // An unpriceable row blocks the whole month's publish — report it instead.
      if (estimatedAmount == null) {
        unpricedDays += 1;
        continue;
      }
      const evidence = byPersonDay.get(key);
      const dayCover = cover.get(key) ?? {};
      drafts.push({
        category: HALF_DAY_CATEGORY,
        sourceSystem: HALF_DAY_SOURCE_SYSTEM,
        sourceRecordId: `crm-half-day:${compact}:${day}`,
        employeeHrId: hrId,
        employeeName: employee.full_name ?? null,
        monthKey,
        month: input.month,
        year: input.year,
        unit: "days",
        rawValue: 0.5,
        estimatedAmount,
        calculationStatus: "calculated",
        severity: "Medium",
        reason:
          halfDayReason(verdict) +
          (evidence?.visitsWithoutLocation
            ? ` (${evidence.visitsWithoutLocation} Phoenix visit(s) logged with no location were not counted — a visit must have a location and a time)`
            : ""),
        evidence: {
          rule:
            "Saturday-Wednesday working day with exactly one half accounted for, and no visit, GPS check-in, save time, approved vacation or request in the other half. An approved weekly plan never accounts for a half (owner, 2026-10-12). Thursday (a morning-only day), Friday and national holidays are never judged.",
          role: role === "district_manager" ? "District manager" : "Medical representative",
          missingHalf: verdict.missing,
          coveredBy: verdict.coveredBy,
          visitsTaggedAm: evidence?.visitsAm ?? 0,
          visitsTaggedPm: evidence?.visitsPm ?? 0,
          visitsWholeDayOrUntimed: evidence?.visitsBoth ?? 0,
          campaignVisits: evidence?.campaignVisits ?? 0,
          creditedAsDoubleVisitPartner: evidence?.partnerVisits ?? 0,
          phoenixVisitsWithoutLocationNotCounted: evidence?.visitsWithoutLocation ?? 0,
          approvedVacation: dayCover.vacationAm ? "AM off" : dayCover.vacationPm ? "PM off" : null,
          deductionDays: 0.5,
          dayRateBasis: "Base salary ÷ calendar days in the month × 0.5",
          holidaysExcluded: [...holidays].filter((date) => date.startsWith(`${monthKey}-`)).sort(),
          suspectDatesExcluded: [...suspectDates].filter((date) => date.startsWith(`${monthKey}-`)).sort(),
          gpsGapDatesExcluded: [...gpsGapDates].sort(),
        },
        dates: [day],
      });
    }
    if (unpricedDays > 0) unpriced.push(`${employee.full_name ?? "Unnamed employee"} (${unpricedDays})`);
  }

  const skippedGpsGaps = [...gpsGapDates].filter((day) => isFieldForceWorkingDay(day) && !isFieldWorkforceThursday(day) && !holidays.has(day)).sort();
  if (skippedGpsGaps.length > 0) {
    notes.push(
      `${CONNECTOR}: not judged because the GPS check-ins for the day arrived far short of a normal day (re-sync the check-ins, then collect again): ${skippedGpsGaps.join(", ")}.`,
    );
  }
  if (collided.length > 0) {
    notes.push(
      `${CONNECTOR}: ${collided.length} half day(s) not raised because another deduction already charges that date — decide them on that tab: ${collided.join("; ")}.`,
    );
  }
  if (unpriced.length > 0) {
    notes.push(`${CONNECTOR}: no base salary on file, so these half days were not priced or raised: ${unpriced.join("; ")}.`);
  }
  if (unattributable > 0) {
    notes.push(
      `${CONNECTOR}: ${unattributable} CRM row slot(s) carry a CRM id two employees share; they were credited to nobody, and every day such a row falls on was left alone for each of those employees.`,
    );
  }
  return { drafts, notes };
}
