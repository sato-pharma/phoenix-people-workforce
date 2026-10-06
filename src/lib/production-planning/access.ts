/**
 * Production Planner — who may open it, and at what level.
 *
 * CLIENT-SAFE: no Supabase import, no server-only module, so the page shells, the workspace and the
 * tests all read the same gate.
 *
 * ── Who the owner named (2026-10-05) ────────────────────────────────────────────────────────────
 *
 *   "the main user of this function will be Dr. Sahar Khalil the R&D manager and of course the CEO
 *    and the system administrator as usual … and the R&D supervisor … Reham, let her get access but
 *    read only … and the finance manager, Mr. Ahmed El Maraghi, also open to him, read only, read
 *    only."
 *
 * | Person            | HR id     | App role        | Shell  | Level |
 * | ----------------- | --------- | --------------- | ------ | ----- |
 * | Omar Gawish       | `B-10`    | Super Admin     | admin  | full  |
 * | Anwar Gaweesh     | `AA`      | CEO             | admin  | full  |
 * | Ahmed Al Maraghi  | `B-185`   | Finance Manager | admin  | read  |
 * | Dr. Sahar Khalil  | `AB`      | Manager         | PORTAL | full  |
 * | Reham Elwiy       | `OF-0004` | Employee        | PORTAL | read  |
 *
 * ── Why the gate is a named list and NOT a grant to `Manager` / `Employee` ───────────────────────
 *
 * Dr. Sahar's app role is `Manager`, which has two holders — her and Samaa Mosaad, the QPPV — and
 * Reham's is `Employee`, which is the entire company. Granting `production_planning` to either role
 * would make this list the only thing standing between the company and a screen carrying raw-material
 * prices and order costs. And this list is not read by `canAccess`, the sidebar, the command palette,
 * Modules Control, or anything written next year: every one of those would answer "yes, for the whole
 * company."
 *
 * So the matrix grants those two roles NOTHING and the door is this helper. The failure mode is the
 * one worth having: if the list is wrong, Dr. Sahar gets a 403 — loud, and fixed in one line — rather
 * than the whole company quietly reading his costs.
 *
 * HR ids are compared with `hrIdsMatch`, never `===`: production stores them in mixed case, so `===`
 * matches nobody, with no error, which presents exactly as the change never having shipped.
 */
import type { AccessContext } from "@/lib/auth/permissions";
import { hrIdsMatch } from "@/lib/hr-id";

export type ProductionPlanningLevel = "full" | "read" | "none";

/**
 * Draft and commit a plan, record a run, edit the materials, the formula, the prices and the
 * settings. Omar Gawish (B-10), Anwar Gaweesh (AA) and Dr. Sahar Khalil (AB).
 */
export const PRODUCTION_PLANNING_FULL_CONTROL_HR_IDS: readonly string[] = ["B-10", "AA", "AB"] as const;

/**
 * Read everything and take the workbook; change nothing. Ahmed Al Maraghi (B-185) and Reham Elwiy
 * (OF-0004) — "now only read only access", with her upgrade left to a Settings row rather than a
 * deployment (see `prodplan_access_grants`).
 */
export const PRODUCTION_PLANNING_READ_ONLY_HR_IDS: readonly string[] = ["B-185", "OF-0004"] as const;

/** A row of `prodplan_access_grants`, so a later grant is a click rather than a release. */
export type ProductionPlanningGrant = {
  readonly hrId: string;
  readonly level: Exclude<ProductionPlanningLevel, "none">;
};

function matchesAny(context: Pick<AccessContext, "hrId" | "loginId">, ids: readonly string[]): boolean {
  // Both identifiers: a session carries the HR id, but a dev-auth sweep and some login flows carry
  // only the login id, and a gate that reads one of them is a gate that is open half the time.
  return ids.some((id) => hrIdsMatch(context.hrId, id) || hrIdsMatch(context.loginId ?? null, id));
}

/**
 * The level this viewer gets, highest wins.
 *
 * Order, and the reason for it: the named lists first, because the owner named those five people and
 * a stored grant must not be able to demote one of them; then the stored grants, which is how a sixth
 * person is added without a release; then the role matrix, which is what covers a future Super Admin
 * or Finance Manager nobody has listed by name.
 */
export function productionPlanningLevel(
  context: Pick<AccessContext, "hrId" | "loginId" | "role">,
  options: {
    /** `permissionMatrix[role].production_planning`, passed in so this file imports no matrix. */
    readonly roleActions?: readonly string[] | null;
    /** Rows of `prodplan_access_grants`, when the caller is on the server and has read them. */
    readonly grants?: readonly ProductionPlanningGrant[] | null;
  } = {},
): ProductionPlanningLevel {
  if (matchesAny(context, PRODUCTION_PLANNING_FULL_CONTROL_HR_IDS)) return "full";

  const grants = options.grants ?? [];
  if (grants.some((grant) => grant.level === "full" && matchesAny(context, [grant.hrId]))) return "full";

  const roleActions = options.roleActions ?? [];
  if (roleActions.includes("create") || roleActions.includes("update")) return "full";

  if (matchesAny(context, PRODUCTION_PLANNING_READ_ONLY_HR_IDS)) return "read";
  if (grants.some((grant) => grant.level === "read" && matchesAny(context, [grant.hrId]))) return "read";
  if (roleActions.includes("read")) return "read";

  return "none";
}

/**
 * Is this HR id one of the five the owner named?
 *
 * For the SIDEBAR only, which is why it takes an id and not an access context: the portal builds
 * its own navigation from a visibility object that carries the viewer's HR id and a role label, and
 * an entry in system-navigation.ts does not put a link there. A role-driven flag is not usable here
 * — `Employee` is the whole company — so the link follows the named list, exactly like the gate.
 *
 * It cannot see a stored grant, so a sixth person admitted from the Settings tab reaches the module
 * by its URL rather than by a sidebar row. That under-reports, which is the right direction for a
 * door: the page itself asks the database.
 */
export function isNamedProductionPlanningPerson(hrId: string | null | undefined): boolean {
  if (!hrId) return false;
  return [...PRODUCTION_PLANNING_FULL_CONTROL_HR_IDS, ...PRODUCTION_PLANNING_READ_ONLY_HR_IDS].some(
    (named) => hrIdsMatch(named, hrId),
  );
}

export function canReadProductionPlanning(level: ProductionPlanningLevel): boolean {
  return level === "full" || level === "read";
}

export function canWriteProductionPlanning(level: ProductionPlanningLevel): boolean {
  return level === "full";
}

/**
 * Whether this viewer's home is the employee portal rather than the admin shell.
 *
 * Kept here as a DERIVED convenience only — `isPortalShellRole` in src/lib/auth/portal-shell-roles.ts
 * is the authority, and `app/(admin)/layout.tsx` redirects a portal-mode viewer before any page in
 * that group runs. The module is dual-surface precisely because its main user is one of them.
 */
export const PRODUCTION_PLANNING_PORTAL_PEOPLE_HR_IDS: readonly string[] = ["AB", "OF-0004"] as const;

/** The level thrown as a 403 rather than rendered: never a page that returns 200 saying "Forbidden". */
export class ProductionPlanningForbiddenError extends Error {
  constructor(role: string, what = "the Production Planner") {
    super(`Forbidden: ${role} cannot access ${what}.`);
    this.name = "ProductionPlanningForbiddenError";
  }
}

export function assertProductionPlanningRead(
  context: Pick<AccessContext, "hrId" | "loginId" | "role">,
  level: ProductionPlanningLevel,
): void {
  if (!canReadProductionPlanning(level)) throw new ProductionPlanningForbiddenError(context.role);
}

export function assertProductionPlanningWrite(
  context: Pick<AccessContext, "hrId" | "loginId" | "role">,
  level: ProductionPlanningLevel,
): void {
  if (!canWriteProductionPlanning(level)) {
    throw new ProductionPlanningForbiddenError(context.role, "changing the Production Planner");
  }
}
