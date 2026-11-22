/**
 * Which ACCEPTED outstation claims are stranded off payroll — pure, so the rule is assertable without a database.
 *
 * WHY THIS EXISTS (claims 111 and 347, found 21 Nov 2026). A claim accepted while its departure photo or workload was
 * still missing is held, and the capture that completes it releases it into payroll. That release is a follow-on of
 * the capture and never throws: when it fails, "the next capture tries again" — but after the departure photo there
 * is no next capture. Two District Managers' accepted claims (EGP 320 since 21 Nov, EGP 775 since 5 Nov) sat with
 * every gate complete and no payroll row, because the release had run under the employee's own access and a District
 * Manager cannot approve expenses. The morning job now retries every claim this function names, as the system.
 *
 * A claim is stranded when ALL hold:
 *   - it is accepted (`accepted_by_admin` / `accepted_by_system`) — a decision already made; this never decides one;
 *   - the payroll gate lets it through (resolveOutstationGateState — the SAME resolver the release itself uses), so a
 *     claim still waiting for its photo or its workload is never pushed;
 *   - it has NO `outstation_expenses` row at all (`OUTSTATION-<id>`). A queued-but-unimported row is already on its
 *     way to a payroll run and is left alone.
 */

import { resolveOutstationGateState } from "@/lib/outstation/expense-gate";
import { outstationPayrollTripId } from "@/lib/outstation/payroll-expense-mapping";
import type { OutstationEvidenceGateStatus, OutstationWorkloadGateStatus } from "@/lib/outstation/types";

/** At most this many claims a morning: a surprise backlog is released over days, never in one burst. */
export const STRANDED_RELEASE_MAX_PER_RUN = 25;

export type StrandedReleaseCandidate = {
  carEvidenceImagePath: string | null;
  departureEvidenceImagePath: string | null;
  employeeRole: string;
  evidenceGateStatus: OutstationEvidenceGateStatus;
  id: number;
  status: string;
  workloadGateStatus: OutstationWorkloadGateStatus;
};

export function selectStrandedAcceptedClaims<T extends StrandedReleaseCandidate>(
  requests: readonly T[],
  payrollTripIds: ReadonlySet<string>,
  max = STRANDED_RELEASE_MAX_PER_RUN,
): T[] {
  return requests
    .filter((request) => request.status.startsWith("accepted"))
    .filter((request) => !payrollTripIds.has(outstationPayrollTripId(request.id)))
    .filter(
      (request) =>
        resolveOutstationGateState({
          employeeRole: request.employeeRole,
          evidenceGateStatus: request.evidenceGateStatus,
          hasArrivalPhoto: Boolean(request.carEvidenceImagePath),
          hasDeparturePhoto: Boolean(request.departureEvidenceImagePath),
          workloadGateStatus: request.workloadGateStatus,
        }).isPayrollEligible,
    )
    .sort((left, right) => left.id - right.id)
    .slice(0, Math.max(0, max));
}
