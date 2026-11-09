// Unified Deductions module: governmental-holiday bridging connector.
//
// Owner's rule: anyone with NO RECORD or on VACATION directly before or after a
// governmental national holiday is deducted for that day. "Directly" means the
// nearest day they actually work — the calculation lives in ../holiday-bridge.ts
// and is unit-tested there; this file is only the data-gathering half.
//
// WHY THIS FINDS ANYTHING THE OTHER CONNECTORS DO NOT.
//
// A no-record day is usually already caught by the CRM connector, and an unpaid
// vacation day by the vacation connectors. The bridging rule is stricter: it
// deducts a day next to a holiday EVEN WHEN the normal rules would not — most
// importantly a vacation day the employee has balance for, which is otherwise
// paid in full. That is the population this connector exists to catch.
//
// Which is also why dedup matters. Any day the other connectors already charge
// must NOT be charged again here — the owner's words: "if vacation with no
// balance or no record was deducted before same day do not duplicate". Doing
// this at insert time rather than at publish is deliberate: publish's collision
// gate would refuse the ENTIRE month over such an overlap, so a duplicate here
// would not double-charge, it would block payroll.

import { canonicalHrIdKey } from "@/lib/hr-id";
import { scanVisitsForRangeCreditingPartners } from "@/lib/crm/reads";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getBaseSalaryMap } from "@/lib/payroll/copilot/feeders.ts";
import { isFieldWorkforceFridayOnlyTitle } from "@/lib/field-workforce-compliance/weekend-policy";

import { calculateDeductionAmountFromBaseSalary } from "../calculations.ts";
import { compactDeductionsHrId } from "../candidate-key.ts";
import {
  collectClaimedLedgerDays,
  ledgerRowStillClaimsItsDaysBySource,
  ledgerReadErrorText,
  type LedgerClaimRow,
} from "../conflict.ts";
import { buildHalfDayIdentity, resolveSlot } from "../half-day-rule.ts";
import { loadProvenWorkedDays } from "../proven-worked-days.ts";
import { assertBaseSalaryMapLoaded } from "./health.ts";
import { getHolidayBridgeDaysForMonth } from "../service.ts";
import { ledgerClaimMonthKeys } from "../cycle.ts";
import type { DeductionsCandidateDraft } from "../types.ts";
import { isBeforeHireDate, type HolidayBridgeDay } from "../holiday-bridge.ts";

/**
 * The one `source_system` this connector writes, and therefore the only one its re-run may retire.
 *
 * Exported so a test can assert it against `collect.ts`'s own `reconcilesSourceScope` registration,
 * which is pinned there as a literal by `deductions-supersede-carries-decision.test.ts`. The two
 * must stay equal: the already-claimed read below excludes exactly the rows reconcile is about to
 * supersede, and either half drifting is silent — too narrow brings back the alternating flip, too
 * wide retires the hand-entered `manual_hr` rows that share this category.
 */
export const HOLIDAY_BRIDGE_SOURCE_SYSTEM = "holiday_bridge";

const HOLIDAY_BRIDGE_SOURCE_SYSTEMS: readonly string[] = [HOLIDAY_BRIDGE_SOURCE_SYSTEM];

/**
 * Every employee-day the live ledger already charges for this month, as
 * `${compactHrId}:${date}`. Superseded candidates do not count — they were
 * withdrawn, so the day is free again.
 *
 * 🔴 THIS RUN'S OWN UNLOCKED ROWS ARE EXCLUDED, OR EVERY SECOND RUN FLIPS THE SET.
 * `collect.ts` registers this collector with `reconcilesSourceScope`, so its own live
 * `holiday_bridge` rows are this run's to keep or to retire: a day the fresh scan no longer produces
 * IS superseded. Counting them as already-charged made the scan skip exactly those days, and
 * reconcile then retired the rows for being absent from it — so a re-run emitted nothing and
 * withdrew the previous run's work, taking the owner's decision on each row with it. The same defect
 * is documented with its production evidence in `connectors/dsm-no-record.ts`, which shares this
 * shape; the general rule and the locked-row exception live on
 * `ledgerRowStillClaimsItsDaysBySource`.
 *
 * Keyed on SOURCE SYSTEM, never on category: `other` is shared with `manual_hr`, whose hand-entered
 * rows survive this run. A LOCKED own row keeps claiming its day too — reconcile will not retract
 * published money, so that row is still live afterwards and re-charging its day double-books it.
 */
async function loadAlreadyDeductedDays(monthKey: string): Promise<Set<string>> {
  // Paged: PostgREST stops a response at 1,000 rows, and a short ledger read would re-charge a day
  // that is already charged. An error never ends the walk early — it throws (fail closed).
  let data: LedgerClaimRow[];
  try {
    data = await fetchAllRows<LedgerClaimRow>(
      () =>
        getSupabaseAdmin()
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
  // it as claimed would drop a genuine bridge deduction that lands on the real 1st (conflict.ts) —
  // and this run's own replaceable rows, per the note above.
  return collectClaimedLedgerDays(data, (row) =>
    ledgerRowStillClaimsItsDaysBySource(
      { sourceSystem: row.source_system ?? null, lockedAt: row.locked_at ?? null },
      HOLIDAY_BRIDGE_SOURCE_SYSTEMS,
    ),
  );
}

/**
 * Field force only, on the owner's instruction — medical reps AND district
 * sales managers.
 *
 * ACTIVE only. Omitting this filter is not a small oversight: the first dry run
 * flagged 44 resigned, terminated and historical-payroll records for "not
 * logging visits", which is true of everyone who no longer works here. They
 * would have been charged a day's pay on every bridge day.
 *
 * And the HIRE DATE rides along, because "active" says nothing about WHEN he started. A rep hired on
 * 11 October has CRM signal that month, so the zero-signal guard lets him through, and 7 and 10
 * October — before he joined — read as "no record" bridge days (owner report 2026-11-09: 18 joiners
 * charged around Armed Forces Day). A day before the hire date is never a day he could have bridged.
 */
type FieldForceEmployee = { hrId: string; name: string | null; hireDate: string | null };

async function loadFieldForceRoster(): Promise<Map<string, FieldForceEmployee>> {
  const roster = new Map<string, FieldForceEmployee>();
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id, full_name, job_title, employment_status, hire_date")
    .eq("employment_status", "active");
  if (error) throw new Error(`Failed to load the field-force roster: ${error.message}`);
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    if (!isFieldWorkforceFridayOnlyTitle(row.job_title as string | null)) continue;
    const hrId = String(row.hr_id ?? "").trim();
    const compact = compactDeductionsHrId(hrId);
    if (!compact) continue;
    const hireDate = String(row.hire_date ?? "").slice(0, 10) || null;
    roster.set(compact, { hrId, name: (row.full_name as string | null) ?? null, hireDate });
  }
  return roster;
}

/**
 * Approved vacation covering any of the bridge days, keyed by
 * `${compactHrId}:${date}`.
 *
 * Every approved vacation type counts, balance or not — that is the point of
 * the rule. The normal balance-first logic lives in the vacation connectors and
 * is untouched here.
 */
async function loadVacationOnBridgeDays(bridgeDays: readonly HolidayBridgeDay[]): Promise<Set<string>> {
  const onLeave = new Set<string>();
  if (bridgeDays.length === 0) return onLeave;
  const sorted = [...bridgeDays].map((bridge) => bridge.date).sort();
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  const { data, error } = await getSupabaseAdmin()
    .from("v2_vacation_requests")
    .select("employee_hr_id, start_date, end_date")
    .eq("status", "approved")
    .lte("start_date", last)
    .gte("end_date", first);
  if (error) throw new Error(`Failed to load vacation requests for holiday bridging: ${error.message}`);

  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const compact = compactDeductionsHrId(String(row.employee_hr_id ?? ""));
    if (!compact) continue;
    const start = String(row.start_date ?? "");
    const end = String(row.end_date ?? "");
    for (const bridge of bridgeDays) {
      if (bridge.date >= start && bridge.date <= end) onLeave.add(`${compact}:${bridge.date}`);
    }
  }
  return onLeave;
}

/**
 * Days a field-force employee produced no CRM record at all, restricted to the
 * bridge days. Read straight from the visit mirror rather than re-deriving the
 * compliance engine's verdict: for this rule the question is simply "was there
 * any activity that day", and a day with zero rows is a no-record day.
 */
async function loadNoRecordOnBridgeDays(input: {
  bridgeDays: readonly HolidayBridgeDay[];
  roster: Map<string, FieldForceEmployee>;
  monthKey: string;
}): Promise<Set<string>> {
  const noRecord = new Set<string>();
  if (input.bridgeDays.length === 0) return noRecord;
  const dates = input.bridgeDays.map((bridge) => bridge.date);
  // Scan the WHOLE month, not just the bridge days. The per-day answer needs
  // only the bridge days, but the "did this person produce any CRM signal at
  // all this month" question needs the full span — see the zero-signal guard
  // below, which cannot be answered from four days of data.
  const first = `${input.monthKey}-01`;
  // The real last day, never a hardcoded 31. "2026-06-31" is not a date and
  // Postgres rejects it outright — which took the whole connector down for
  // every 30-day month and February.
  const [scanYear, scanMonth] = input.monthKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(scanYear!, scanMonth!, 0)).getUTCDate();
  const last = `${input.monthKey}-${String(lastDay).padStart(2, "0")}`;

  const withActivity = new Set<string>();
  // Through crm/reads.ts, never a direct query on the mirror. That single-door
  // rule is guarded by tests/crm-single-source.test.ts, and it exists so CRM
  // feed semantics — the effective view, excluded agents, resigned reps — live
  // in one place instead of eroding one convenient query at a time.
  //
  // Crediting partners, not the plain scan: a manager's bridge day is recorded as the DOUBLE on a
  // rep's row, so the rep resigning later took the manager's only evidence with it and charged him
  // for the day (owner report 2026-10-07). A rescued row's `agent_hr_id` is nulled by the read
  // door, so the loop below gives the day to the partner and to nobody who has left.
  const rows = await scanVisitsForRangeCreditingPartners<{
    agent_hr_id: string | null;
    agent_crm_id: string | null;
    double_hr_id: string | null;
    double_crm_id: string | null;
    double2_hr_id: string | null;
    double2_crm_id: string | null;
    visit_date: string | null;
  }>({
    dateFrom: first,
    dateTo: last,
    columns: "agent_hr_id, agent_crm_id, double_hr_id, double_crm_id, double2_hr_id, double2_crm_id, visit_date",
  });
  // A slot can carry only the CRM login, never the HR id, while its HR mapping backfills — the DSM
  // connector met exactly that and charged worked days. Resolved through the SAME `resolveSlot` the
  // DSM and Half Day connectors use, with the identity learned from the feed's own rows (never from
  // `employees.crm_id`). An ambiguous login credits every claimant: a day here can only REMOVE a
  // charge, so not charging is the safe direction to be wrong in.
  const identity = buildHalfDayIdentity([
    ...rows.map((row) => ({ hrId: row.agent_hr_id, crmId: row.agent_crm_id })),
    ...rows.map((row) => ({ hrId: row.double_hr_id, crmId: row.double_crm_id })),
    ...rows.map((row) => ({ hrId: row.double2_hr_id, crmId: row.double2_crm_id })),
  ]);
  for (const row of rows) {
    const date = String(row.visit_date ?? "").slice(0, 10);
    if (!date) continue;
    // BOTH sides of the visit count as activity.
    //
    // District sales managers do not log CRM visits of their own — they work
    // the day out WITH a rep, and the system records them as the double on that
    // rep's visit. Crediting only `agent_hr_id` therefore reads every manager as
    // absent every single day: the first dry run flagged 18 DSMs on all four
    // bridge days for exactly this reason. Same fix visit-workload.ts already
    // applies company-wide.
    // And the chain's SECOND manager, who is just as present and would otherwise be charged for a
    // day he spent in the field.
    for (const slot of [
      { hr: row.agent_hr_id, crm: row.agent_crm_id },
      { hr: row.double_hr_id, crm: row.double_crm_id },
      { hr: row.double2_hr_id, crm: row.double2_crm_id },
    ]) {
      const resolved = resolveSlot(slot.hr, slot.crm, identity);
      if (resolved.ambiguous) {
        for (const claimant of resolved.claimants) withActivity.add(`${claimant}:${date}`);
        continue;
      }
      if (resolved.compact) withActivity.add(`${resolved.compact}:${date}`);
    }
  }

  // Anyone who produced CRM signal at some point this month. Zero signal for a
  // WHOLE month is a data-mapping gap, not 31 days of absence — the CRM
  // connector already refuses to deduct on that basis (loadZeroCrmSignalHrIdKeys)
  // and so must this one. The first dry run charged two district managers four
  // days each purely because they are not mapped to the feed at all.
  const hasAnySignalThisMonth = new Set<string>();
  for (const key of withActivity) hasAnySignalThisMonth.add(key.split(":")[0]!);

  for (const [compact] of input.roster) {
    if (!hasAnySignalThisMonth.has(compact)) continue;
    for (const date of dates) {
      const key = `${compact}:${date}`;
      if (!withActivity.has(key)) noRecord.add(key);
    }
  }
  return noRecord;
}

/**
 * Bridge-day candidates for one month.
 *
 * Filed under `other` (which maps to other_deductions in payroll) rather than
 * inventing an eighth category: a new category means a new DB enum value, a new
 * always-visible tab, and a migration — and the row is already fully explained
 * by its reason and evidence. The UI's "Holiday bridge" column annotates it
 * from the same calculation regardless of which category it sits in.
 */
export async function collectHolidayBridgeCandidates(input: {
  month: number;
  year: number;
  createdBy: string;
}): Promise<DeductionsCandidateDraft[]> {
  const monthKey = `${input.year}-${String(input.month).padStart(2, "0")}`;
  const { bridgeDays, calendarReachable } = await getHolidayBridgeDaysForMonth(monthKey);

  // REFUSE, do not return empty. When the Egypt holiday calendar cannot be read
  // the holiday set may be partial — and a missing public holiday looks exactly
  // like an ordinary working day, so this connector could flag a day that was
  // actually a national holiday and charge someone a day's pay for it. Throwing
  // surfaces "connector failed" in the collection UI; returning [] would show a
  // confident "0 new" that an operator cannot tell from "nobody qualified".
  if (!calendarReachable) {
    throw new Error(
      "The Egypt national-holiday calendar could not be read, so the holiday list may be incomplete. Refusing to compute bridging days rather than risk deducting a day that was actually a public holiday.",
    );
  }

  if (bridgeDays.length === 0) return [];

  // The bridge days' own span — the only window the Phoenix work-evidence read needs. A bridge day
  // can sit in the previous or next month (the day before a 1st-of-the-month holiday), so the month
  // is the wrong bound.
  const bridgeDateSpan = [...new Set(bridgeDays.map((bridge) => bridge.date))].sort();

  const [roster, alreadyDeducted, baseSalaryByCompact] = await Promise.all([
    loadFieldForceRoster(),
    loadAlreadyDeductedDays(monthKey),
    getBaseSalaryMap(),
  ]);
  // A silently-empty salary map would price every candidate at null and look
  // like "nobody qualifies" — the same failure this guard exists for elsewhere.
  assertBaseSalaryMapLoaded("Holiday bridging connector", baseSalaryByCompact);

  const [onLeave, noRecord, provenWorked] = await Promise.all([
    loadVacationOnBridgeDays(bridgeDays),
    loadNoRecordOnBridgeDays({ bridgeDays, roster, monthKey }),
    // PHOENIX CRM, WHETHER OR NOT THE TEAM WAS STARTED — a rep on an unstarted team logs real
    // visits that the read door does not serve, so `loadNoRecordOnBridgeDays` cannot see them.
    // Read below against BOTH causes, not folded into `withActivity`: that set feeds
    // `hasAnySignalThisMonth`, and feeding it would turn a mapping-gap skip into a charge.
    loadProvenWorkedDays({ end: bridgeDateSpan[bridgeDateSpan.length - 1]!, start: bridgeDateSpan[0]! }),
  ]);

  // One candidate per employee-DAY, not per holiday edge. A working day can sit
  // between two holidays — 17 June 2026 is both "after Muharram" and "before
  // Day off for Muharram" — and charging it twice is precisely the duplicate
  // this rule forbids. The first edge encountered names the row.
  const bridgeByDate = new Map<string, HolidayBridgeDay>();
  for (const bridge of bridgeDays) {
    if (!bridgeByDate.has(bridge.date)) bridgeByDate.set(bridge.date, bridge);
  }
  const uniqueBridgeDays = [...bridgeByDate.values()];

  const drafts: DeductionsCandidateDraft[] = [];
  for (const [compact, employee] of roster) {
    for (const bridge of uniqueBridgeDays) {
      // Not yet hired that day — nothing to bridge. Same rule the Half Day, DSM and vacation
      // connectors already keep (`day < hireDate`).
      if (isBeforeHireDate(bridge.date, employee.hireDate)) continue;
      const key = `${compact}:${bridge.date}`;
      // The dedup rule: a day another category already charges is never charged
      // twice. Checked BEFORE anything else so the cheapest exit wins.
      if (alreadyDeducted.has(key)) continue;

      // A day Phoenix CRM proves he worked is never charged — against BOTH causes. A rep who logged
      // real visits on a bridge day did not bridge the holiday, whatever a leave row says about it,
      // and charging a day someone provably worked is the error this suppressor exists for.
      if (provenWorked.keys.has(key)) continue;

      const hasLeave = onLeave.has(key);
      const hasNoRecord = noRecord.has(key);
      if (!hasLeave && !hasNoRecord) continue;

      const baseSalary = baseSalaryByCompact.get(compact) ?? null;
      const estimatedAmount = calculateDeductionAmountFromBaseSalary({
        baseSalary,
        deductionDays: 1,
        month: input.month,
        year: input.year,
      });
      // No base salary on record means no priceable deduction. Emitting it
      // anyway would create a `requires_review` row with no amount, and
      // publishMonth refuses those outright — one such row blocks the ENTIRE
      // month's publish. Same call the no-records-activity connector makes.
      if (estimatedAmount == null) continue;

      const cause = hasLeave ? "vacation" : "no record";
      drafts.push({
        category: "other",
        sourceSystem: HOLIDAY_BRIDGE_SOURCE_SYSTEM,
        // Deterministic and clock-free, so re-running the collection skips what
        // already exists instead of duplicating it.
        sourceRecordId: `holiday-bridge:${canonicalHrIdKey(employee.hrId) ?? compact}:${bridge.date}`,
        employeeHrId: employee.hrId,
        employeeName: employee.name,
        monthKey,
        month: input.month,
        year: input.year,
        unit: "days",
        rawValue: 1,
        estimatedAmount,
        calculationStatus: estimatedAmount != null ? "calculated" : "requires_review",
        severity: "High",
        reason: `${cause === "vacation" ? "Vacation" : "No record"} on the working day ${bridge.adjacentTo} ${bridge.holidayName}`,
        evidence: {
          cause,
          adjacentTo: bridge.adjacentTo,
          holidayName: bridge.holidayName,
          holidayStartDate: bridge.holidayStartDate,
          holidayEndDate: bridge.holidayEndDate,
          rule: "Governmental-holiday bridging: the nearest working day either side of a national holiday.",
        },
        dates: [bridge.date],
      });
    }
  }

  return drafts;
}
