// Phoenix Workforce — the count behind the owner's "Probation Due" sidebar shortcut (27 Nov 2026).
//
// The rule itself — still employed, no final decision, inside `lifecycleRiskWindows.probationCriticalDays`
// — is `probationDecisionsDue` in src/lib/needs-you/sources.ts, the Needs You board's own filter, so the
// number on the rail and the number on the board can never disagree. Nothing is re-counted here.

import type { AccessContext } from "@/lib/auth/permissions";
import { forbiddenError } from "@/lib/http/api-errors";
import { probationDecisionsDue } from "@/lib/needs-you/sources";
import { canReadAllProbation, getProbationRows } from "@/lib/probation/service";

/**
 * How many probation decisions are due, for a viewer the Probation page (/probation) admits — refused
 * (403) for anyone it would redirect, so a count is never shown for a page that cannot be opened. A
 * failed read throws, and the badge says "unavailable" rather than 0.
 */
export async function countProbationDecisionsDue(access: AccessContext): Promise<number> {
  if (!canReadAllProbation(access)) throw forbiddenError("Only a company-wide probation reader sees the probation queue.");
  return probationDecisionsDue(await getProbationRows(access)).length;
}
