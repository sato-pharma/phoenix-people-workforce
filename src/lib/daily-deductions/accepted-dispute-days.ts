/**
 * THE DAYS AN ACCEPTED DAILY-DEDUCTION DISPUTE SPARES — month-end collection never charges them again.
 *
 * Owner, 2026-11-13, asked what accepting a dispute on a released daily deduction should do, chose
 * "Withdraw + never charge": the released line is withdrawn (`decideDailyDispute`), the days show
 * verified on his calendar, and *the month-end deduction can never charge those days again — any type*.
 *
 * A released daily line feeds no salary run; the monthly Deductions module charges from its own
 * collection, which re-detects the same days from the same connectors. So the spare is applied to the
 * collected DRAFTS, before anything is written — in both collection doors (`collect.ts`, the calendar
 * month and the Head Office cycle) and in the daily tally itself, so the Super Admin's next Compute
 * does not raise the day again either.
 *
 * Scoped to the SAME employee AND the SAME category as the disputed line: the dispute argued with
 * that finding ("no CRM activity on 3 November"), not with every other reason a day could be charged.
 *
 * A draft that charges exactly one day per date is narrowed exactly (the kept dates re-priced by
 * `scaleDeductionAmountToKeptDates`, the one door every narrowing uses — a CRM Thursday keeps its
 * half-day weight). A draft whose every date is spared is dropped. A draft that charges a different
 * number of days than it lists dates (a vacation request lists calendar days, charges working days)
 * cannot have a day removed exactly, so it is KEPT and named in a note for the Super Admin, never
 * silently re-priced.
 *
 * FAILS CLOSED like every deduction source: a failed read throws, and the connector reports the
 * failure instead of charging days somebody already won.
 */

import { daysForTickedDates, scaleDeductionAmountToKeptDates } from "@/lib/deductions/calculations.ts";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import type { DeductionsCandidateDraft } from "@/lib/deductions/types.ts";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type AcceptedDailyDisputeRow = {
  category: string;
  dates: unknown;
  employee_hr_id_compact: string;
  status: string;
};

/** `${compact}\u0000${category}` → the spared dates. */
export type SparedDailyDays = Map<string, Set<string>>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function spareKey(compact: string, category: string): string {
  return `${compact}\u0000${category}`;
}

/** Pure: the spared days from the dispute rows. Only `accepted` spares anything. */
export function sparedDaysFromDisputes(rows: readonly AcceptedDailyDisputeRow[]): SparedDailyDays {
  const spared: SparedDailyDays = new Map();
  for (const row of rows) {
    if (row.status !== "accepted") continue;
    const compact = compactDeductionsHrId(row.employee_hr_id_compact);
    if (!compact || !row.category) continue;
    const dates = Array.isArray(row.dates) ? (row.dates as unknown[]).map((value) => String(value).slice(0, 10)) : [];
    const key = spareKey(compact, row.category);
    const set = spared.get(key) ?? new Set<string>();
    for (const date of dates) if (ISO_DATE.test(date)) set.add(date);
    if (set.size > 0) spared.set(key, set);
  }
  return spared;
}

/**
 * Pure: remove every spared day from the drafts. Returns the drafts to keep and a note for every
 * draft it narrowed, dropped or could not narrow, so the collection screen says what happened.
 */
export function spareAcceptedDailyDisputeDays(
  drafts: readonly DeductionsCandidateDraft[],
  spared: SparedDailyDays,
): { kept: DeductionsCandidateDraft[]; notes: string[] } {
  if (spared.size === 0) return { kept: [...drafts], notes: [] };
  const kept: DeductionsCandidateDraft[] = [];
  const notes: string[] = [];
  for (const draft of drafts) {
    const compact = compactDeductionsHrId(draft.employeeHrId);
    const days = compact ? spared.get(spareKey(compact, draft.category)) : undefined;
    const dates = Array.isArray(draft.dates) ? draft.dates : [];
    const hit = days ? dates.filter((date) => days.has(String(date).slice(0, 10))) : [];
    if (!days || hit.length === 0 || draft.unit !== "days") {
      kept.push(draft);
      continue;
    }
    const who = draft.employeeName?.trim() || "An employee";
    const remaining = dates.filter((date) => !days.has(String(date).slice(0, 10)));
    if (remaining.length === 0) {
      notes.push(`${who}: ${hit.join(", ")} not charged — the employee's dispute on the released daily deduction was accepted.`);
      continue;
    }
    const rawValue = Number(draft.rawValue);
    if (!Number.isFinite(rawValue) || rawValue !== dates.length) {
      kept.push(draft);
      notes.push(
        `${who}: ${hit.join(", ")} won a daily deduction dispute, but this finding charges ${draft.rawValue} day(s) over ` +
          `${dates.length} date(s), so those days cannot be removed exactly. It was kept — narrow it by hand.`,
      );
      continue;
    }
    const appliedDays = daysForTickedDates({ rawValue, detectedDates: dates.length, tickedDates: remaining.length });
    kept.push({
      ...draft,
      dates: remaining,
      rawValue: appliedDays,
      estimatedAmount: scaleDeductionAmountToKeptDates({
        appliedDays,
        category: draft.category,
        detectedDates: dates,
        estimatedAmount: draft.estimatedAmount,
        keptDates: remaining,
        rawValue,
      }),
    });
    notes.push(`${who}: ${hit.join(", ")} not charged — the employee's dispute on the released daily deduction was accepted.`);
  }
  return { kept, notes };
}

/** Every ACCEPTED daily-deduction dispute, as spared days. Throws on a failed read (fails closed). */
export async function loadSparedDailyDays(): Promise<SparedDailyDays> {
  let rows: Array<AcceptedDailyDisputeRow & { id: string }>;
  try {
    rows = await fetchAllRows<AcceptedDailyDisputeRow & { id: string }>(
      () =>
        getSupabaseAdmin()
          .from("daily_deductions_disputes")
          .select("id,employee_hr_id_compact,category,dates,status")
          .eq("status", "accepted"),
      "id",
    );
  } catch (error) {
    throw new Error(
      `Failed to load the accepted daily deduction disputes: ${(error as { message?: string } | null)?.message ?? String(error)}`,
    );
  }
  return sparedDaysFromDisputes(rows);
}

/** Read the spared days and apply them — the one call each collection door makes. */
export async function applyAcceptedDailyDisputes(
  drafts: DeductionsCandidateDraft[],
): Promise<{ drafts: DeductionsCandidateDraft[]; notes: string[] }> {
  if (drafts.length === 0) return { drafts, notes: [] };
  const spared = await loadSparedDailyDays();
  const result = spareAcceptedDailyDisputeDays(drafts, spared);
  return { drafts: result.kept, notes: result.notes };
}
