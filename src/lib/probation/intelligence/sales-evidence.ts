import type { PhoenixRole } from "@/lib/auth/permissions";
import { describeSalesMonths, getEmployeeSales, type SalesMonthPoint } from "@/lib/employee-360/deep-service";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Sales against target, for the months of a person's probation (owner, 2026-11-03).
 *
 * WHOSE FIGURE. It is the TERRITORY'S, credited to whoever held the seat that month, read through
 * Employee 360's own reader, so the published Monthly Closing is the only source and confidential
 * products are masked for the viewer exactly as they are there. A new rep inherits a territory's
 * performance, so the screen labels it as that and never as the person's own work.
 *
 * DISPLAY ONLY. It feeds no score, no readiness, no `system_evidence` and no decision. Nothing here
 * is written anywhere.
 *
 * NEVER A ZERO FOR A MONTH WITH NO FIGURE. An unpublished month says "Not published yet"; a published
 * month with nothing credited says there is no figure; a missing target stays missing. A failed read
 * says so, rather than showing a short table that reads as a poor one.
 */

export type ProbationSalesMonth =
  | { achievementPct: number | null; kind: "figure"; label: string; month: string; sales: number; target: number | null }
  | { kind: "no_figure"; label: string; month: string }
  | { kind: "not_published"; label: string; month: string };

export type ProbationSalesEvidence =
  | { state: "unavailable" }
  | {
      /** Sales ÷ target over the months carrying a target. Null when no month carries one. */
      achievementPct: number | null;
      months: ProbationSalesMonth[];
      state: "ready";
    };

/** Every `YYYY-MM` from the first date's month to the last's, inclusive. Empty for a bad or reversed pair. */
export function monthsBetween(fromDate: string, toDate: string): string[] {
  const from = /^(\d{4})-(\d{2})/.exec(fromDate);
  const to = /^(\d{4})-(\d{2})/.exec(toDate);
  if (!from || !to) return [];
  const out: string[] = [];
  let year = Number(from[1]);
  let month = Number(from[2]);
  const endKey = `${to[1]}-${to[2]}`;
  for (;;) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    if (key > endKey || out.length >= 36) break;
    out.push(key);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

/** The shaping step, pure, so a test can drive it without a closing. */
export function buildProbationSalesEvidence(input: {
  endDate: string | null;
  monthly: readonly SalesMonthPoint[];
  startDate: string | null;
  todayIso: string;
  unpublishedMonths: readonly string[];
}): ProbationSalesEvidence {
  if (!input.startDate) return { achievementPct: null, months: [], state: "ready" };
  const last = input.endDate && input.endDate < input.todayIso ? input.endDate : input.todayIso;
  const byMonth = new Map(input.monthly.map((point) => [point.month, point] as const));
  const unpublished = new Set(input.unpublishedMonths);

  let gradedSales = 0;
  let totalTarget = 0;
  const months = monthsBetween(input.startDate, last).map((month): ProbationSalesMonth => {
    const label = describeSalesMonths([month]);
    const point = byMonth.get(month);
    if (!point) return unpublished.has(month) ? { kind: "not_published", label, month } : { kind: "no_figure", label, month };
    if (point.hasTarget) {
      gradedSales += point.sales;
      totalTarget += point.target;
    }
    return {
      achievementPct: point.hasTarget ? point.achievementPct : null,
      kind: "figure",
      label,
      month,
      sales: point.sales,
      target: point.hasTarget ? point.target : null,
    };
  });

  return {
    achievementPct: totalTarget > 0 ? (gradedSales / totalTarget) * 100 : null,
    months,
    state: "ready",
  };
}

/** For the evaluator's feedback page, which holds a task, not a case: the case's dates come from its own row. */
export async function loadFeedbackSalesEvidence(
  task: { caseId: string | null; employeeHrId: string },
  viewerRole: PhoenixRole,
): Promise<ProbationSalesEvidence> {
  if (!task.caseId) return { state: "unavailable" };
  const { data, error } = await getSupabaseAdmin()
    .from("probation_cases")
    .select("probation_start_date, probation_end_date, hire_date")
    .eq("id", task.caseId)
    .maybeSingle();
  if (error || !data) return { state: "unavailable" };
  const row = data as { hire_date: string | null; probation_end_date: string | null; probation_start_date: string | null };
  return getProbationSalesEvidence({
    employeeHrId: task.employeeHrId,
    endDate: row.probation_end_date,
    startDate: row.probation_start_date ?? row.hire_date,
    todayIso: currentCairoDateOnlyIso(),
    viewerRole,
  });
}

/** Never throws: the evaluation page stands without this panel, and says so. */
export async function getProbationSalesEvidence(input: {
  employeeHrId: string;
  endDate: string | null;
  startDate: string | null;
  todayIso: string;
  viewerRole: PhoenixRole;
}): Promise<ProbationSalesEvidence> {
  try {
    const summary = await getEmployeeSales(input.employeeHrId, [input.employeeHrId], input.viewerRole);
    if (summary.teamUnreadable) return { state: "unavailable" };
    return buildProbationSalesEvidence({
      endDate: input.endDate,
      monthly: summary.monthly,
      startDate: input.startDate,
      todayIso: input.todayIso,
      unpublishedMonths: summary.unpublishedMonths,
    });
  } catch (error) {
    logWarning("Probation sales evidence could not be read; the panel says so", {
      context: { message: error instanceof Error ? error.message : String(error) },
      labels: { event: "probation_sales_evidence_unavailable" },
    });
    return { state: "unavailable" };
  }
}
