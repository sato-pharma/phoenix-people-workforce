// Phoenix Workforce — the probation decisions that are due: ONE definition, read by the Needs You board's
// "probation decisions" row and by the owner's "Probation" sidebar shortcut (27 Nov 2026), so the number
// on the rail and the number on the board can never disagree.
//
// The rule is the board's, moved here unchanged: a person still employed whose probation has no final
// decision (`isProbationDecisionOutstanding`) and is inside the product's own "due soon" window
// (`lifecycleRiskWindows.probationCriticalDays`). The account of why each filter exists is on the
// Needs You adapter in src/lib/needs-you/sources.ts.

import type { AccessContext } from "@/lib/auth/permissions";
import { isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { forbiddenError } from "@/lib/http/api-errors";
import { lifecycleRiskWindows } from "@/lib/lifecycle-risk/metrics";
import { canReadAllProbation, getProbationRows, isProbationDecisionOutstanding } from "@/lib/probation/service";
import type { ProbationRow } from "@/lib/probation/types";

type ProbationRowLike = Pick<ProbationRow, "workflow" | "days_remaining" | "employment_status">;

/** The rows whose probation decision is due — the board's own filter. Never edits the shared rows. */
export function probationDecisionsDue<Row extends ProbationRowLike>(rows: readonly Row[]): Row[] {
  return rows.filter(
    (row) =>
      isActiveLifecycleStatus(row.employment_status) &&
      isProbationDecisionOutstanding(row) &&
      row.days_remaining <= lifecycleRiskWindows.probationCriticalDays,
  );
}

/**
 * How many probation decisions are due, for a viewer the Probation page (/probation) admits — refused
 * (403) for anyone it would redirect, so a count is never shown for a page that cannot be opened. A
 * failed read throws, and the badge says "unavailable" rather than 0.
 */
export async function countProbationDecisionsDue(access: AccessContext): Promise<number> {
  if (!canReadAllProbation(access)) throw forbiddenError("Only a company-wide probation reader sees the probation queue.");
  return probationDecisionsDue(await getProbationRows(access)).length;
}
