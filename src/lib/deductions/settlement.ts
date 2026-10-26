// Unified Deductions module: the final-settlement path for an employee whose
// employment has already ended.
//
// WHY THIS EXISTS
//
// `isCollectableMonth` in collect.ts refuses any month that has not finished,
// and that rule is correct — see its docstring for the 39,225.73 EGP it exists
// to prevent. Its justification is precise, though: *a no-activity day is only
// meaningful once the day is over*. For someone who left on the 9th, every one
// of their days IS over. Waiting for the 1st of next month does not make their
// numbers more correct; it only guarantees their final settlement is paid
// before anyone can compute what should have come off it.
//
// So this module keeps the month guard completely untouched and opens a much
// narrower door beside it: one employee, whose last working day has already
// passed, in the month that contains it.
//
// TWO THINGS HERE ARE LOAD-BEARING
//
//  1. INSERT ONLY, NEVER RECONCILE. Every automated connector declares
//     `reconcilesWholeCategory` or `reconcilesSourceScope`, which supersedes
//     the month's live candidates that a fresh scan no longer emits. A scan
//     filtered down to ONE employee emits nothing for anybody else — so
//     reconciling it would supersede every other employee's candidates for
//     that month. This path therefore always uses `insertCandidateDrafts`.
//     Idempotency still holds: the candidate_key unique index means re-running
//     skips what already exists rather than duplicating it.
//  2. NO AUTO-DECIDE. These are computed candidates like any other and go to
//     HR as Pending. Only a manually typed entry auto-approves, because a human
//     chose the number.

import { currentCairoDateParts } from "@/lib/i18n/format";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { compactDeductionsHrId } from "./candidate-key.ts";
import { DEDUCTION_COLLECTORS, collectorOutputParts, type DeductionCollectorKey } from "./collect.ts";
import { splitDraftsByClaimedDays } from "./conflict.ts";
import { ledgerClaimMonthKeys } from "./cycle.ts";
import { insertCandidateDrafts, listCandidatesForMonth, type CandidateDraftInsertResult } from "./service.ts";
import type { DeductionsCategory } from "./types.ts";

export type LastWorkingDateParts = { year: number; month: number; day: number };

/**
 * Reads the leading YYYY-MM-DD out of a `date` or timestamp column.
 *
 * Deliberately string-based rather than `new Date(...)`: parsing to a Date and
 * reading it back applies the SERVER's timezone, and this machine is not in
 * Cairo. A last working day of 2026-08-09 must mean the 9th regardless of where
 * the process runs.
 */
export function parseLastWorkingDate(value: string | null | undefined): LastWorkingDateParts | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function ordinal(parts: LastWorkingDateParts): number {
  return parts.year * 10000 + parts.month * 100 + parts.day;
}

/**
 * True when this deduction month is the month the employee actually left in.
 *
 * The gate for a MANUAL entry. It does not require the day to have passed:
 * someone leaving on the 31st still has a known, hand-typed figure, and HR
 * entering it on the 23rd is legitimate.
 */
export function isFinalSettlementMonth(input: {
  lastWorkingDate: string | null | undefined;
  month: number;
  year: number;
}): boolean {
  const last = parseLastWorkingDate(input.lastWorkingDate);
  if (!last) return false;
  return last.year === input.year && last.month === input.month;
}

/**
 * True when the employee's last working day is strictly in the past, in Cairo.
 *
 * The extra gate for a COMPUTED settlement scan, and the thing that keeps this
 * module honest against the rule collect.ts enforces: a connector may only
 * judge days that have ended. Same-day is refused — the day is still running.
 */
export function hasEmploymentEnded(input: {
  lastWorkingDate: string | null | undefined;
  now?: Date;
}): boolean {
  const last = parseLastWorkingDate(input.lastWorkingDate);
  if (!last) return false;
  return ordinal(last) < ordinal(currentCairoDateParts(input.now));
}

export type SettlementEligibility =
  | { eligible: true; employeeHrId: string; employeeName: string | null; lastWorkingDate: string }
  | { eligible: false; reason: string };

/**
 * Decides whether one employee may have a settlement scan run for one month.
 *
 * Gates on the DATE, not on employment_status. A leaver whose status has not
 * been flipped yet is still a leaver, and gating on status here would rebuild
 * the exact ordering trap this module exists to remove — where the answer
 * depends on which of two HR actions happened first.
 */
export async function resolveSettlementEligibility(input: {
  employeeHrId: string;
  month: number;
  year: number;
  now?: Date;
}): Promise<SettlementEligibility> {
  const hrId = input.employeeHrId.trim();
  if (!hrId) return { eligible: false, reason: "Validation: employeeHrId is required." };

  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id, full_name, last_working_date")
    .eq("hr_id", hrId)
    .maybeSingle();
  if (error) return { eligible: false, reason: `Employee lookup failed: ${error.message}` };
  if (!data) return { eligible: false, reason: "Not found: no employee matches that record." };

  const employee = data as { hr_id: string; full_name: string | null; last_working_date: string | null };
  const label = employee.full_name ?? employee.hr_id;
  const lastWorkingDate = employee.last_working_date;

  if (!parseLastWorkingDate(lastWorkingDate)) {
    return {
      eligible: false,
      reason: `Validation: ${label} has no last working date recorded, so there is no completed employment period to settle. Record the leaving date first.`,
    };
  }
  if (!isFinalSettlementMonth({ lastWorkingDate, month: input.month, year: input.year })) {
    return {
      eligible: false,
      reason: `Validation: ${label} left on ${lastWorkingDate}, which is not in ${String(input.month).padStart(2, "0")}/${input.year}. A settlement scan only runs for the month the employee actually left in.`,
    };
  }
  if (!hasEmploymentEnded({ lastWorkingDate, now: input.now })) {
    return {
      eligible: false,
      reason: `Validation: ${label}'s last working day (${lastWorkingDate}) has not passed yet. A settlement scan may only judge days that have ended.`,
    };
  }
  return {
    eligible: true,
    employeeHrId: employee.hr_id,
    employeeName: employee.full_name,
    lastWorkingDate: lastWorkingDate as string,
  };
}

/**
 * Runs ONE connector for ONE leaver, for the month they left in.
 *
 * One connector per call, matching `collectOneConnectorForMonth`: each
 * connector is a company-wide scan and running all of them inside one HTTP
 * request is what got the first cut of this module reverted (#1377).
 */
export async function collectSettlementForLeaver(input: {
  employeeHrId: string;
  month: number;
  year: number;
  createdBy: string;
  connector: DeductionCollectorKey;
  now?: Date;
}): Promise<CandidateDraftInsertResult> {
  const collector = DEDUCTION_COLLECTORS.find((entry) => entry.key === input.connector);
  if (!collector) {
    throw new Error(`Validation: unknown deductions connector "${input.connector}".`);
  }

  const eligibility = await resolveSettlementEligibility({
    employeeHrId: input.employeeHrId,
    month: input.month,
    year: input.year,
    now: input.now,
  });
  if (!eligibility.eligible) throw new Error(eligibility.reason);

  const wanted = compactDeductionsHrId(eligibility.employeeHrId);
  if (!wanted) {
    throw new Error(`Validation: ${eligibility.employeeHrId} does not normalize to a usable HR key.`);
  }

  try {
    // Only the drafts: a connector's notes describe the whole company, not this leaver.
    const { drafts: scanned } = collectorOutputParts(
      await collector.run({
        month: input.month,
        year: input.year,
        createdBy: input.createdBy,
      }),
    );
    const mine = scanned.filter((draft) => compactDeductionsHrId(draft.employeeHrId) === wanted);
    if (mine.length === 0) {
      return { created: 0, skippedExisting: 0, warnings: [] };
    }
    // THIS PATH CANNOT RETIRE AN EARLIER ROW, so it must never add one beside it. The draft's key
    // (`leaver_<hr>_<month>`) is not the normal scan's per-day key, so the unique index lets both in —
    // 2026-09 production: an approved and a pending row for the same employee-day. A live read that
    // fails holds EVERYTHING back (fail closed): adding a duplicate is the expensive mistake.
    const sourceLabel = `${collector.label} (final settlement)`;
    const warnings: string[] = [];
    const live: Awaited<ReturnType<typeof listCandidatesForMonth>> = [];
    try {
      // The draft's own month AND the next one: from October 2026 a one-part employee's days from the
      // 22nd on sit on the Head Office cycle row of the FOLLOWING payroll month (cycle.ts), and reading
      // only this month would add those days a second time.
      const scopes = new Set(
        mine.flatMap((draft) =>
          ledgerClaimMonthKeys(draft.monthKey).map((monthKey) => `${monthKey}\u0000${draft.category}`),
        ),
      );
      for (const scope of scopes) {
        const [monthKey, category] = scope.split("\u0000");
        live.push(
          ...(await listCandidatesForMonth({
            monthKey,
            category: category as DeductionsCategory,
            employeeHrIdCompact: wanted,
          })),
        );
      }
    } catch (error) {
      return {
        created: 0,
        skippedExisting: 0,
        warnings: [
          `${sourceLabel}: nothing was added — the existing deductions for ${eligibility.employeeName ?? "this employee"} could not be read to rule out a double charge (${error instanceof Error ? error.message : String(error)}).`,
        ],
      };
    }
    const { keep, held } = splitDraftsByClaimedDays(mine, live);
    for (const entry of held) {
      warnings.push(
        `${sourceLabel}: ${eligibility.employeeName ?? "this employee"} already has a live deduction on ${entry.claimedDates.join(", ")} — not added again.` +
          (entry.openDates.length > 0
            ? ` ${entry.openDates.join(", ")} ${entry.openDates.length === 1 ? "is" : "are"} not covered by it; clear or edit the earlier row, then run the settlement again.`
            : ""),
      );
    }
    if (keep.length === 0) return { created: 0, skippedExisting: held.length, warnings };

    // insertCandidateDrafts, NEVER reconcileCandidateDrafts — see the module
    // header. A one-employee draft set would supersede the whole month.
    const inserted = await insertCandidateDrafts({
      createdBy: input.createdBy,
      drafts: keep,
      sourceLabel,
    });
    return { ...inserted, skippedExisting: inserted.skippedExisting + held.length, warnings: [...warnings, ...inserted.warnings] };
  } catch (error) {
    return {
      created: 0,
      skippedExisting: 0,
      warnings: [
        `${collector.label}: settlement scan failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}
