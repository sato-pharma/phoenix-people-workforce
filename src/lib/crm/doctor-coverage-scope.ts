/**
 * Doctor Coverage — viewer scope resolution.
 *
 * Answers one question: for this signed-in viewer, WHICH reps' visits may they see?
 * The board itself (sfe-doctor-coverage.ts) is scope-blind and aggregates whatever rows it is
 * handed, so this module is the security boundary for the module's data.
 *
 * WHY THIS EXISTS. Until 2026-08-08 `getSfeDoctorCoverage({ month })` took no viewer argument at
 * all: every seat that could open the page received all 205 agents and 12,420 doctors, company-wide
 * (measured in production). The portal page's own header admitted it — "line-scoping this view is a
 * known follow-up, not built yet" — which meant a National Sales Manager, who owns exactly ONE
 * line, was reading every other line's reps and doctor panels. That is the hole this closes.
 *
 * It also widens the audience, which is the point: the board previously reached only Super Admin,
 * SFE Manager and NSM — analyst and executive seats. The District Manager who runs the coaching
 * conversation and the Medical Rep who actually walks into the clinic could not see it at all, so
 * the module produced no corrective action by construction. Owner decision 2026-08-08: DM sees own
 * reps, Medical Rep sees own panel, RM sees own region, PM/GPM see their line, MM stays company.
 *
 * Design constraints carried over verbatim from business-review-s1/portal-scope.ts, because each
 * one of them was paid for with a real defect in this repo:
 *
 *  - Scope comes from the ORG TREE, never a region or line LABEL on the viewer's own row. PR #1479:
 *    six live areas sit in an operational region different from their geographic one, and
 *    region-label scoping hid 1,194 of one DM's own sales rows. The Regional Manager scope here is
 *    therefore a subtree walk, not a `regionName` string match.
 *  - A manager gets their WHOLE subtree, not one level. PR #1486: resolving a hierarchy scope with a
 *    one-level manager check made an RM see their DSMs but none of the reps beneath them, so a
 *    semester rolled up to "0.0%" and EGP 0 payout — wrong, and silent. `isWithinManagerHierarchy`
 *    climbs the full chain and is seat-continuity aware.
 *  - Scope is applied BEFORE any ranking or truncation. PR #1487: truncating company-wide first and
 *    filtering after silently emptied a scoped viewer's list. Here the agent list goes into the
 *    Postgres query, so nothing is ever ranked pre-scope.
 *  - Every failure path returns NO access, never a wider one. A missing hr id, an unknown role or a
 *    blank line resolves to `none`, never to `company`.
 *  - The role comes from the live AccessContext, never from client input.
 */

import { getEmployeeDirectoryRows, isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { isWithinManagerHierarchy, sameWorkforceLine } from "@/lib/workforce/hierarchy-resolver";
import { doctorCoverageScopeBasisForRole, type DoctorCoverageScopeBasis } from "@/lib/crm/doctor-coverage-roles";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import type { AccessContext } from "@/lib/auth/permissions";

export type DoctorCoverageScope =
  | { kind: "company"; basis: "company"; label: string }
  /** Explicit allow-list of `agent_hr_id`s. Never empty — an empty resolution returns `none`. */
  | { kind: "agents"; basis: Exclude<DoctorCoverageScopeBasis, "company">; agentHrIds: string[]; label: string }
  | { kind: "none"; reason: string };

/** Directory fields this module actually reads — keeps the pure core testable without a DB. */
export type DoctorCoverageScopeEmployee = {
  employmentStatus: string | null;
  hrId: string;
  lineId: number | null;
  lineName: string | null;
  managerHrId: string | null;
  pendingManagerReplacementForHrId: string | null;
};

/**
 * Pure core — fixture-testable, no IO. `employees` must be the FULL directory including inactive
 * people (see the note on the hierarchy map below); this function does the active-only filtering
 * itself on the way out.
 */
export function resolveDoctorCoverageScope(input: {
  role: string;
  viewerHrId: string | null;
  employees: readonly DoctorCoverageScopeEmployee[];
}): DoctorCoverageScope {
  const basis = doctorCoverageScopeBasisForRole(input.role);
  if (!basis) {
    return { kind: "none", reason: `Doctor coverage is not available to the ${input.role} role.` };
  }
  if (basis === "company") {
    return { kind: "company", basis: "company", label: `${input.role} · all lines` };
  }

  const viewerHrId = input.viewerHrId?.trim() ?? "";
  const viewerKey = normalizeHrIdForAccess(viewerHrId);
  if (!viewerKey) {
    return { kind: "none", reason: "No HR ID is attached to your session, so no territory can be resolved." };
  }

  if (basis === "self") {
    // Passed through in the session's own casing on purpose: the CRM reads door sprays every
    // casing/alias variant itself (expandHrIdFilterValues), and pre-normalizing here would strip
    // the hyphen out of an id like "B-124" that the mirror actually stores.
    return { kind: "agents", basis: "self", agentHrIds: [viewerHrId], label: `${input.role} · own panel` };
  }

  const viewer = input.employees.find((employee) => normalizeHrIdForAccess(employee.hrId) === viewerKey);
  if (!viewer) {
    return { kind: "none", reason: "Your employee record could not be found, so no territory can be resolved." };
  }

  if (basis === "line") {
    // Line identity comes off the viewer's own employee row here (not the org tree) because these
    // are staff seats with no reports to walk — a Product Manager owns brands, not people. `lineId`
    // is preferred over `lineName` by sameWorkforceLine, so a renamed line cannot silently empty
    // the scope.
    if (viewer.lineId == null && !viewer.lineName?.trim()) {
      return { kind: "none", reason: "No product line is recorded on your employee record, so a whole-line scope cannot be granted." };
    }
    const agentHrIds = input.employees
      .filter((employee) => isActiveLifecycleStatus(employee.employmentStatus))
      .filter((employee) => sameWorkforceLine(viewer, employee))
      .map((employee) => employee.hrId);
    return finalizeAgents(agentHrIds, "line", `${input.role} · ${viewer.lineName?.trim() || "own"} line`);
  }

  // ── team scope (District Manager: own reps; Regional Manager: every rep under the region) ──
  // The lookup map is built from EVERY employee, including inactive ones, while only ACTIVE people
  // are emitted below. That asymmetry is deliberate and load-bearing: isWithinManagerHierarchy
  // climbs `managerHrId` node by node, so if an intermediate manager (say a DM who has just
  // resigned) were missing from the map the climb would break at that node and the RM above would
  // lose every rep beneath them — the exact silent-empty failure PR #1486 was about. Departed reps
  // are still filtered out of the OUTPUT, and the CRM reads door drops their visits independently.
  const byCanonicalHrId = new Map<string, DoctorCoverageScopeEmployee>();
  for (const employee of input.employees) {
    const key = normalizeHrIdForAccess(employee.hrId);
    if (key) byCanonicalHrId.set(key, employee);
  }
  const agentHrIds = input.employees
    .filter((employee) => isActiveLifecycleStatus(employee.employmentStatus))
    .filter((employee) =>
      isWithinManagerHierarchy({
        employee,
        byCanonicalHrId,
        viewerCanonicalHrId: viewerKey,
        canonicalize: normalizeHrIdForAccess,
      }),
    )
    .map((employee) => employee.hrId);
  const label = input.role === "Regional Manager" ? `${input.role} · own region` : `${input.role} · own team`;
  return finalizeAgents(agentHrIds, "team", label);
}

/**
 * An empty agent list must never reach the query. `queryVisits` treats `agentHrIds: []` as "no
 * rows", which would render an innocent-looking empty board — indistinguishable from a rep who
 * genuinely visited nobody. A viewer with no resolvable team gets an explicit explanation instead.
 */
function finalizeAgents(
  agentHrIds: readonly string[],
  basis: Exclude<DoctorCoverageScopeBasis, "company">,
  label: string,
): DoctorCoverageScope {
  const unique = Array.from(new Set(agentHrIds.filter((hrId) => hrId?.trim())));
  if (unique.length === 0) {
    return {
      kind: "none",
      reason:
        basis === "line"
          ? "No active employees are recorded on your product line, so there is no panel to show."
          : "No active reports are attached to your seat in the org tree, so no territory can be resolved.",
    };
  }
  return { kind: "agents", basis, agentHrIds: unique, label };
}

/**
 * IO wrapper: resolve the live directory, then the pure core.
 *
 * `access.role` must come from the live AccessContext, never from client input — the same rule the
 * S1 portal scope enforces. A company-scoped role short-circuits before the directory read, so the
 * CEO command center does not pay for a directory fetch it will not filter on.
 */
export async function getDoctorCoverageScope(access: AccessContext): Promise<DoctorCoverageScope> {
  const basis = doctorCoverageScopeBasisForRole(access.role);
  if (!basis) {
    return { kind: "none", reason: `Doctor coverage is not available to the ${access.role} role.` };
  }
  if (basis === "company") {
    return { kind: "company", basis: "company", label: `${access.role} · all lines` };
  }
  // includeInactive: the hierarchy map needs every node to stay walkable — see the note above.
  const employees = await getEmployeeDirectoryRows({ includeInactive: true });
  return resolveDoctorCoverageScope({ role: access.role, viewerHrId: access.hrId, employees });
}
