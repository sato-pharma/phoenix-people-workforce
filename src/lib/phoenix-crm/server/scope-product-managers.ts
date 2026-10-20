/**
 * Phoenix CRM — the product managers a report names beside the managers who hold a seat (owner, 2026-10-20:
 * "EVERYSINGLE ROLE THATS APLLICABLE TOAPPEAR IN A MODULE FIND ANAD SHOW").
 *
 * A Product Manager or Group Product Manager sits on NO organogram seat, so `managersInScope` — the reach every
 * manager list in this module is built from — can never name him. The visits he rode with a rep therefore stood
 * in no manager pick list, no "per manager" row and no calendar row: they were on the rep's row and nowhere a
 * reader could ask about him. This is the one answer to who those people are for a set of territories: each
 * line's own product managers (`loadLineProductManagers`), the very list a rep of that line picks from when he
 * files the visit — so it is exactly who can stand in `product_manager_hr_id` on those territories.
 *
 * 🔴 WHO IS GIVEN THEM (`readsLineProductManagers`): a viewer who reads the company (the Super Admin, the CEO, the
 *    SFE Manager) and a national sales manager. Scope runs downward only and a product manager holds no seat to
 *    measure "below" against, so a district or regional manager is not handed one as a manager of his own. He
 *    still reads every visit a product manager made with his reps — on the rep's row, and in the Visit report's
 *    "Who visited".
 * 🔴 WHICH ROLES: a company reader gets every role the line offers its reps (on CNS that is the Marketing Manager
 *    too); a national sales manager gets the Product Manager and Group Product Manager roles only — never the
 *    person they report to.
 *
 * It reads no visit and names no table. The list itself is cached five minutes where it is read (`visit-asks.ts`),
 * and that file is reached LAZILY: it imports the insight reports, which import `reports.ts`, which imports this.
 */

import { personKey, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { VISIT_ASK_PRODUCT_MANAGER_ROLES, type VisitAskProductManager } from "@/lib/phoenix-crm/visit-ask-rules";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";

/** A product manager a report may name, with his app role and the lines of the territories he is named for. */
export type ScopeProductManager = { hrId: string; role: string; lineCodes: string[]; lineNames: string[] };

/** One line's own product managers, as `loadLineProductManagers` answers for it. */
export type LineProductManagers = { lineCode: string; lineName: string | null; managers: ReadonlyArray<VisitAskProductManager> };

/** The Product Manager and Group Product Manager roles — what a national sales manager is given. */
const PRODUCT_MANAGER_ROLES: ReadonlySet<string> = new Set<string>(VISIT_ASK_PRODUCT_MANAGER_ROLES);

/** Whether this viewer is given the product managers at all: the company readers and a national sales manager. */
export function readsLineProductManagers(viewer: Pick<PhoenixCrmViewer, "basis" | "managerSeats">): boolean {
  return viewer.basis === "all" || viewer.managerSeats.some((seat) => seat.tier === "NSM");
}

/** The roles this viewer is given: null (every role the line offers) for a company reader. */
export function productManagerRolesFor(viewer: Pick<PhoenixCrmViewer, "basis">): ReadonlySet<string> | null {
  return viewer.basis === "all" ? null : PRODUCT_MANAGER_ROLES;
}

/**
 * Every line's product managers folded into one list — each person once, carrying every line he is named on, in
 * the order the lines were given. Pure, so the folding and the role rule are tested without a database.
 */
export function scopeProductManagersOf(lines: ReadonlyArray<LineProductManagers>, roles: ReadonlySet<string> | null): ScopeProductManager[] {
  const byPerson = new Map<string, ScopeProductManager>();
  for (const line of lines) {
    for (const manager of line.managers) {
      const hrId = personKey(manager.hrId);
      if (!hrId || (roles !== null && !roles.has(manager.role))) continue;
      const known = byPerson.get(hrId) ?? { hrId, role: manager.role, lineCodes: [], lineNames: [] };
      if (!known.lineCodes.includes(line.lineCode)) {
        known.lineCodes.push(line.lineCode);
        known.lineNames.push(line.lineName ?? line.lineCode);
      }
      byPerson.set(hrId, known);
    }
  }
  return [...byPerson.values()];
}

/** The distinct lines of these territories, in the order they first appear. */
function linesOf(seats: ReadonlyArray<Pick<OrgSeat, "lineCode" | "lineName">>): Array<{ lineCode: string; lineName: string | null }> {
  const lines = new Map<string, string | null>();
  for (const seat of seats) {
    if (seat.lineCode && !lines.has(seat.lineCode)) lines.set(seat.lineCode, seat.lineName);
  }
  return [...lines].map(([lineCode, lineName]) => ({ lineCode, lineName }));
}

/**
 * The product managers of the lines these territories are on, as this viewer is given them — nobody for a viewer
 * `readsLineProductManagers` refuses. Never throws: a line whose list cannot be read offers nobody, the safe
 * direction, and `loadLineProductManagers` says so in the log.
 */
export async function loadScopeProductManagers(
  viewer: Pick<PhoenixCrmViewer, "basis" | "managerSeats">,
  seats: ReadonlyArray<Pick<OrgSeat, "lineCode" | "lineName">>,
): Promise<ScopeProductManager[]> {
  if (!readsLineProductManagers(viewer)) return [];
  const lines = linesOf(seats);
  if (lines.length === 0) return [];
  const { loadLineProductManagers } = await import("@/lib/phoenix-crm/server/visit-asks");
  const read = await Promise.all(lines.map(async (line) => ({ ...line, managers: await loadLineProductManagers(line) })));
  return scopeProductManagersOf(read, productManagerRolesFor(viewer));
}
