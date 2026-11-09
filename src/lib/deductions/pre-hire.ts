// Unified Deductions module: no deduction stands on a day before the employee was hired.
//
// Every connector already skips a day before the hire date it reads at collection time. What none of
// them can see is a hire date that MOVES LATER after the lines were written: a rep's August
// unpaid-vacation lines were collected on 8 October, his hire date was set to 1 October on the 12th,
// and six lines for days before he joined stayed Pending (owner, 2026-11-09: "stop hire-date edits
// from leaving pre-hire deductions behind").
//
// So when a hire date moves later, this re-states the employee's unlocked lines against it, through
// the same reconcile pass a re-collect uses — a line wholly before the hire date is retired, a line
// that straddles it is replaced by one holding only the days from the hire date on (its decision
// carried onto the replacement), and an approved figure that moved re-opens its payroll step.
//
// Never touched: a LOCKED (published) line — reconcile refuses those by design and reports them; a
// `manual_hr` line or any non-day line — a loan or an "other" amount is dated on the 1st of its month
// as a placeholder, not on a day he worked, so the hire date says nothing about it; and a multi-day
// line whose day count is not one per date (a vacation request lists calendar days but charges
// working days), which cannot be narrowed exactly and is reported instead.

import { daysForTickedDates, scaleDeductionAmountToKeptDates } from "./calculations.ts";
import { compactDeductionsHrId } from "./candidate-key.ts";
import type { DeductionsCandidate, DeductionsCandidateDraft } from "./types.ts";

/** The hand-entered writer — its dates are placeholders, never worked days. */
const MANUAL_SOURCE_SYSTEM = "manual_hr";

export type PreHireGroup = {
  category: DeductionsCandidate["category"];
  monthKey: string;
  sourceSystem: string;
  /** The lines holding a pre-hire day — the ONLY ones reconcile may retire. */
  candidateIds: string[];
  /** The replacement for each line that straddles the hire date, holding only the days from it on.
   *  A line wholly before the hire date has none, so reconcile retires it. */
  drafts: DeductionsCandidateDraft[];
  retired: number;
  narrowed: number;
};

export type PreHirePlan = {
  groups: PreHireGroup[];
  /** Lines that hold a pre-hire day but cannot be re-stated exactly. */
  notNarrowable: Array<{ id: string; reason: string }>;
};

function toDraft(row: DeductionsCandidate, override?: Partial<DeductionsCandidateDraft>): DeductionsCandidateDraft {
  return {
    category: row.category,
    sourceSystem: row.sourceSystem,
    sourceRecordId: row.sourceRecordId,
    employeeHrId: row.employeeHrId,
    employeeName: row.employeeName,
    monthKey: row.monthKey,
    month: row.month,
    year: row.year,
    unit: row.unit,
    rawValue: row.rawValue,
    estimatedAmount: row.estimatedAmount,
    calculationStatus: row.calculationStatus,
    severity: row.severity,
    reason: row.reason,
    evidence: row.evidence,
    dates: row.dates,
    hierarchySnapshot: row.hierarchySnapshot,
    ...override,
  };
}

/**
 * Pure: given ONE employee's live lines and his hire date (`YYYY-MM-DD`), the groups reconcile must
 * re-state. A group is (category, month, source) — reconcile's own unit of authority — and only a
 * group holding at least one line that can be re-stated is returned.
 */
export function planPreHireRetirement(input: { rows: readonly DeductionsCandidate[]; hireDate: string }): PreHirePlan {
  const hireDate = input.hireDate.slice(0, 10);
  const eligible = input.rows.filter(
    (row) => !row.supersededAt && !row.lockedAt && row.unit === "days" && row.sourceSystem !== MANUAL_SOURCE_SYSTEM,
  );
  const byGroup = new Map<string, DeductionsCandidate[]>();
  for (const row of eligible) {
    const key = `${row.category}|${row.monthKey}|${row.sourceSystem}`;
    const list = byGroup.get(key) ?? [];
    list.push(row);
    byGroup.set(key, list);
  }

  const groups: PreHireGroup[] = [];
  const notNarrowable: PreHirePlan["notNarrowable"] = [];
  for (const rows of byGroup.values()) {
    if (!rows.some((row) => row.dates.some((date) => date.slice(0, 10) < hireDate))) continue;
    const drafts: DeductionsCandidateDraft[] = [];
    const candidateIds: string[] = [];
    let retired = 0;
    let narrowed = 0;
    for (const row of rows) {
      const kept = row.dates.filter((date) => date.slice(0, 10) >= hireDate);
      if (kept.length === row.dates.length) continue;
      if (kept.length === 0) {
        candidateIds.push(row.id);
        retired += 1;
        continue;
      }
      // Straddles the hire date. Exact only when the line charges one day per date.
      if (Number(row.rawValue) !== row.dates.length) {
        notNarrowable.push({
          id: row.id,
          reason: `charges ${row.rawValue} day(s) over ${row.dates.length} date(s), so the days before ${hireDate} cannot be removed exactly`,
        });
        continue;
      }
      const rawValue = daysForTickedDates({ rawValue: row.rawValue, detectedDates: row.dates.length, tickedDates: kept.length });
      drafts.push(
        toDraft(row, {
          dates: kept,
          rawValue,
          estimatedAmount: scaleDeductionAmountToKeptDates({
            appliedDays: rawValue,
            category: row.category,
            detectedDates: row.dates,
            estimatedAmount: row.estimatedAmount,
            keptDates: kept,
            rawValue: row.rawValue,
          }),
        }),
      );
      candidateIds.push(row.id);
      narrowed += 1;
    }
    if (retired === 0 && narrowed === 0) continue;
    const first = rows[0]!;
    groups.push({ category: first.category, monthKey: first.monthKey, sourceSystem: first.sourceSystem, candidateIds, drafts, retired, narrowed });
  }
  return { groups, notNarrowable };
}

/** True when a hire date moved LATER (or was set for the first time) — the only edit that can strand a line. */
export function hireDateMovedLater(previous: string | null | undefined, next: string | null | undefined): boolean {
  const after = String(next ?? "").slice(0, 10);
  if (!after) return false;
  const before = String(previous ?? "").slice(0, 10);
  return !before || after > before;
}

/**
 * The one call every employee save makes after it writes a hire date. Does nothing unless the date
 * moved later; never throws — a failure must not undo the save, so it is logged loudly instead.
 */
export async function restatePreHireDeductionsAfterHireDateSave(input: {
  employeeHrId: string;
  previousHireDate: string | null | undefined;
  savedHireDate: string | null | undefined;
  actorHrId: string | null | undefined;
}): Promise<void> {
  if (!hireDateMovedLater(input.previousHireDate, input.savedHireDate)) return;
  const { logError } = await import("@/lib/observability/log");
  try {
    const result = await retirePreHireDeductions({
      employeeHrId: input.employeeHrId,
      hireDate: String(input.savedHireDate).slice(0, 10),
      actorHrId: input.actorHrId || "system",
    });
    if (result.warnings.length > 0) {
      logError("Pre-hire deductions were re-stated with warnings", {
        labels: { event: "deductions_pre_hire_restate_warning", hrId: input.employeeHrId },
        error: new Error(result.warnings.join(" | ")),
      });
    }
  } catch (error) {
    logError("Pre-hire deductions could not be re-stated after a hire-date change", {
      labels: { event: "deductions_pre_hire_restate_failed", hrId: input.employeeHrId },
      error,
    });
  }
}

/**
 * Re-states one employee's unlocked deduction lines against his hire date. Returns what it did; never
 * throws for a reconcile warning (those are returned), only for a failed read.
 */
export async function retirePreHireDeductions(input: {
  employeeHrId: string;
  hireDate: string;
  actorHrId: string;
}): Promise<{ retired: number; narrowed: number; warnings: string[] }> {
  const compact = compactDeductionsHrId(input.employeeHrId);
  if (!compact || !input.hireDate) return { retired: 0, narrowed: 0, warnings: [] };

  const { getSupabaseAdmin } = await import("@/lib/supabase/server");
  const { fetchAllRows } = await import("@/lib/supabase/paginated");
  const { mapCandidateRow, reconcileCandidateDrafts } = await import("./service.ts");

  const rows = await fetchAllRows<Record<string, unknown>>(
    () =>
      getSupabaseAdmin()
        .from("deductions_candidates")
        .select("*")
        .eq("employee_hr_id_compact", compact)
        .is("superseded_at", null)
        .is("locked_at", null),
    "id",
  );
  const plan = planPreHireRetirement({ rows: rows.map(mapCandidateRow), hireDate: input.hireDate });

  const warnings = plan.notNarrowable.map((line) => `Pre-hire line ${line.id} left as it is: ${line.reason}.`);
  let retired = 0;
  let narrowed = 0;
  for (const group of plan.groups) {
    const result = await reconcileCandidateDrafts({
      createdBy: input.actorHrId,
      drafts: group.drafts,
      sourceLabel: `Hire date moved to ${input.hireDate.slice(0, 10)}`,
      scope: {
        category: group.category,
        monthKey: group.monthKey,
        sourceSystems: [group.sourceSystem],
        employeeFilter: (employeeHrIdCompact) => employeeHrIdCompact === compact,
        // Only the lines holding a pre-hire day; every other line of his is left exactly as it is.
        onlyCandidateIds: new Set(group.candidateIds),
      },
    });
    warnings.push(...result.warnings);
    retired += group.retired;
    narrowed += group.narrowed;
  }
  return { retired, narrowed, warnings };
}
