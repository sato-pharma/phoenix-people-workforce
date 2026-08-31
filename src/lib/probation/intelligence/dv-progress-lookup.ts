// Per-employee DV-Day progress, for readers OUTSIDE the probation module.
//
// WHY THIS EXISTS. Double Visit Analytics shows a probation watchlist whose "DV" column asks one
// question: has the viewer's own tier (dm / nsm / pm_gpm / tm) done the double visit this
// probationer needs from them? It used to answer that from `employee_probation`'s four boolean
// checkbox columns — a table nothing has filled since the Case model took over provisioning, so the
// column read "Pending" for every probationer forever, including the ones whose DM had already done
// eighteen double visits. Measured on production 2026-09-01: employee_probation 0 rows, against 21
// active cases carrying 79 countable DM DV-Days.
//
// The authoritative record is `probation_dv_days`, and the authoritative ROLLUP of it is
// computeDvProgress() in report-metrics.ts — the same function the CEO exception dashboard and the
// consolidated report use. This module is a bulk loader in front of that function, nothing more.
// It deliberately does NOT define its own notion of "done": a second opinion about what counts as a
// completed DV is exactly the thing that lets two screens disagree about the same rep.

import { getSupabaseAdmin } from "@/lib/supabase/server";

import { getProbationConfig } from "./config";
import { computeDvProgress, type DvDayLite, type DvProgress } from "./report-metrics";
import type { ProbationEvaluatorRole } from "./types";

/** Lookup key for an HR_ID. HR ids are MIXED CASE in this database — never compare them raw. */
function key(hrId: string | null | undefined): string {
  return String(hrId ?? "").trim().toLowerCase();
}

type CaseRow = { id: string; employee_hr_id: string };
type DvRow = { case_id: string | null; evaluator_role: ProbationEvaluatorRole | null; dv_status: string };

/**
 * DV-Day progress for every employee with an ACTIVE probation case, keyed by lowercased HR_ID.
 *
 * Scoped through `probation_cases` rather than `probation_dv_days.employee_hr_id` on purpose: a
 * rehired employee's DV-Days from an earlier, closed case must not count toward the current one.
 *
 * Loads all active cases with no `.in()` filter — the set is bounded by construction (a case is
 * active only inside its 90-day window) and a PostgREST `.in()` carrying hundreds of ids returns
 * zero rows with no error, which here would read as "nobody has done a double visit".
 *
 * Throws on a database error; callers that render a widget should treat a failure as "unknown"
 * rather than as "not done".
 */
export async function getActiveProbationDvProgressByEmployee(): Promise<Map<string, DvProgress>> {
  const supabase = getSupabaseAdmin();
  const config = await getProbationConfig();

  const { data: caseData, error: caseError } = await supabase
    .from("probation_cases")
    .select("id, employee_hr_id")
    .eq("status", "active");
  if (caseError) throw new Error(caseError.message);

  const cases = (caseData ?? []) as CaseRow[];
  const byEmployee = new Map<string, DvProgress>();
  if (cases.length === 0) return byEmployee;

  const { data: dvData, error: dvError } = await supabase
    .from("probation_dv_days")
    .select("case_id, evaluator_role, dv_status")
    .in("case_id", cases.map((row) => row.id));
  if (dvError) throw new Error(dvError.message);

  const daysByCase = new Map<string, DvDayLite[]>();
  for (const row of (dvData ?? []) as DvRow[]) {
    if (!row.case_id) continue;
    const list = daysByCase.get(row.case_id);
    const day: DvDayLite = { evaluatorRole: row.evaluator_role, dvStatus: row.dv_status };
    if (list) list.push(day);
    else daysByCase.set(row.case_id, [day]);
  }

  for (const probationCase of cases) {
    // An employee with a case but no DV-Days still gets an entry: computeDvProgress over an empty
    // list is a real answer ("required N, validated 0"), and it is what keeps a brand-new
    // probationer showing Pending rather than dropping out of the watchlist altogether.
    byEmployee.set(
      key(probationCase.employee_hr_id),
      computeDvProgress(daysByCase.get(probationCase.id) ?? [], config),
    );
  }
  return byEmployee;
}

/**
 * Has `role` met its DV requirement on this case?
 *
 * Answers `null` — "not applicable", rendered N/A rather than Pending — in the two cases where the
 * tier owes nothing and a red "Pending" would be a lie:
 *   - the requirement is configured to 0 (today: `tm`), so no DV is owed by that tier at all;
 *   - PM/GPM against a CNS probationer, which the Case model's own resolveEvaluatorRole refuses
 *     with `pm_gpm_not_applicable_cns`.
 *
 * Measured against the requirement, NOT against feedback: the question the watchlist asks is
 * whether the VISIT happened, which is what the retired checkbox meant too. Feedback completion is
 * a separate column on the probation dashboard and must not be conflated with it here.
 */
export function dvRequirementMetForRole(
  progress: DvProgress | undefined,
  role: ProbationEvaluatorRole,
  lineName: string | null,
): boolean | null {
  if (role === "pm_gpm" && String(lineName ?? "").trim().toLowerCase() === "cns") return null;
  if (!progress) return null;
  const roleProgress = progress.byRole[role];
  if (!roleProgress || roleProgress.required <= 0) return null;
  return roleProgress.validated >= roleProgress.required;
}
