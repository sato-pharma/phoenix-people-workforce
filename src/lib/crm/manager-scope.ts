/**
 * Whose reps a CRM board shows — the shared org-tree walk, with no policy of its own.
 *
 * Both tabs of the District Manager page need the same sentence answered: "which medical reps are
 * mine?" This module answers it once. What it deliberately does NOT hold is WHO may ask — that is a
 * per-board decision (`doctor-list-access.ts`, `plan-verification-access.ts`), and the two boards
 * genuinely differ: reading a rep's doctor list and signing his plan into the customer's CRM are not
 * the same authority. Folding both into one role list would silently grant one by granting the other.
 *
 * So: the WALK is shared, the POLICY is not. That split is the whole point of the file.
 *
 * The walk itself is `isWithinManagerHierarchy` from the workforce hierarchy resolver — the same
 * function Doctor Coverage scopes with, and the security-critical part. It is not reimplemented here.
 *
 * ## Why an empty result is its own case
 *
 * PostgREST reads `.in("agent_hr_id", [])` as "no rows", which renders an empty board — and an empty
 * board is indistinguishable from "my reps have filed nothing", a sentence a manager would believe
 * and act on. A viewer whose seat resolves to nobody therefore gets `kind: "none"` carrying a
 * reason, never an empty allow-list. No caller has to remember this; it cannot be constructed.
 *
 * ## A row whose rep could not be resolved
 *
 * Some mirrored rows carry `agent_hr_id = null` — a CRM account the identity waterfall could not tie
 * to an employee. `scopeAllowsAgent` refuses those for a team-scoped viewer and allows them for a
 * company-scoped one. A manager cannot be shown a row that nobody can prove is his, and a scoped
 * viewer silently inheriting unattributed rows is how a rep from another district reaches a DM's
 * screen.
 */

import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { isWithinManagerHierarchy } from "@/lib/workforce/hierarchy-resolver";
import { normalizeHrIdForAccess } from "@/lib/hr-id";

/** How wide a role's reach is. `company` sees every rep; `team` resolves against the org tree. */
export type CrmScopeBasis = "company" | "team";

export type CrmManagerScope =
  | { kind: "company"; label: string }
  /** Explicit allow-list of `agent_hr_id`s. Never empty — an empty resolution returns `none`. */
  | { kind: "agents"; agentHrIds: string[]; label: string }
  | { kind: "none"; reason: string };

/** Directory fields this module actually reads — keeps the pure core testable without a database. */
export type ManagerScopeEmployee = {
  employmentStatus: string | null;
  hrId: string;
  managerHrId: string | null;
  pendingManagerReplacementForHrId: string | null;
};

function isActive(employee: ManagerScopeEmployee): boolean {
  const status = (employee.employmentStatus ?? "").trim().toLowerCase();
  return status !== "resigned" && status !== "terminated";
}

/** See the header: an empty allow-list must never reach a query. */
function finalize(agentHrIds: readonly string[], label: string): CrmManagerScope {
  const unique = Array.from(new Set(agentHrIds.filter((hrId) => hrId?.trim())));
  if (unique.length === 0) {
    return {
      kind: "none",
      reason: "No active reports are attached to your seat in the org tree, so no reps can be resolved.",
    };
  }
  return { kind: "agents", agentHrIds: unique, label };
}

/**
 * Pure core — fixture-testable, no IO.
 *
 * `employees` must be the FULL directory INCLUDING inactive people. The hierarchy map has to stay
 * walkable through a resigned intermediate manager, or a DM under a manager who has left resolves to
 * nobody. Inactive people are filtered out of the RESULT, not out of the map.
 */
export function resolveTeamScope(input: {
  employees: readonly ManagerScopeEmployee[];
  label: string;
  viewerHrId: string | null;
}): CrmManagerScope {
  const viewerKey = normalizeHrIdForAccess(input.viewerHrId);
  if (!viewerKey) {
    return {
      kind: "none",
      reason: "Your account is not linked to an employee record, so your team cannot be resolved.",
    };
  }

  // Every node, active or not, so the climb never dead-ends on a resigned manager.
  const byCanonicalHrId = new Map<string, ManagerScopeEmployee>();
  for (const employee of input.employees) {
    const key = normalizeHrIdForAccess(employee.hrId);
    if (key) byCanonicalHrId.set(key, employee);
  }

  const agentHrIds = input.employees
    .filter(isActive)
    .filter((employee) =>
      isWithinManagerHierarchy({
        employee,
        byCanonicalHrId,
        viewerCanonicalHrId: viewerKey,
        canonicalize: normalizeHrIdForAccess,
      }),
    )
    .map((employee) => employee.hrId);

  return finalize(agentHrIds, input.label);
}

/**
 * IO wrapper: resolve the live directory, then the pure core.
 *
 * `basis` must be derived from the live AccessContext's role and never from client input — a role
 * read off a query string would let any viewer name himself Super Admin and take the company branch.
 */
export async function getManagerScope(input: {
  basis: CrmScopeBasis;
  label: string;
  viewerHrId: string | null;
}): Promise<CrmManagerScope> {
  if (input.basis === "company") return { kind: "company", label: input.label };
  // includeInactive so the hierarchy stays walkable — see the note on the pure core.
  const employees = await getEmployeeDirectoryRows({ includeInactive: true });
  return resolveTeamScope({ employees, label: input.label, viewerHrId: input.viewerHrId });
}

/**
 * Whether one rep is inside a resolved scope.
 *
 * The single place that answer is computed, so a board's loader and its mutation route cannot drift
 * apart — a board that hides a row while the route still accepts a POST for it is not scoped, it is
 * merely tidy.
 */
export function scopeAllowsAgent(scope: CrmManagerScope, agentHrId: string | null): boolean {
  if (scope.kind === "company") return true;
  if (scope.kind === "none") return false;
  if (!agentHrId?.trim()) return false;
  const wanted = normalizeHrIdForAccess(agentHrId);
  if (!wanted) return false;
  return scope.agentHrIds.some((hrId) => normalizeHrIdForAccess(hrId) === wanted);
}
