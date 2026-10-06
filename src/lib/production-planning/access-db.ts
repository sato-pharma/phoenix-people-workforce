/**
 * Production Planner — the server half of the access gate.
 *
 * SERVER ONLY: it reads `prodplan_access_grants`, which is why it is a separate file from
 * `access.ts`. That one is client-safe and imports no Supabase, so the client workspace and the page
 * shells can share the same gate without dragging the service-role client into a browser bundle.
 *
 * The five people the owner named on 2026-10-05 live in `access.ts`, because they are the design.
 * This file is only how a SIXTH person is admitted — and specifically the upgrade he has already
 * said is coming for Reham: "later on like I said authority on her". With this table that is a row
 * on the Settings tab rather than a branch, a pull request, a CI run and a deploy.
 */
import { permissionMatrix, type AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  productionPlanningLevel,
  type ProductionPlanningGrant,
  type ProductionPlanningLevel,
} from "./access";

const GRANTS_TABLE = "prodplan_access_grants";
const GRANT_COLUMNS = "hr_id, level";

/**
 * Every stored grant.
 *
 * A read that FAILS returns an empty list, not a throw: the five named people are in code, so an
 * unreadable grants table must degrade to "the people the owner named still get in" rather than
 * locking everybody out of a planner because one small table was unavailable. It can never widen
 * access by failing, because an empty list grants nobody anything.
 */
export async function loadProductionPlanningGrants(): Promise<ProductionPlanningGrant[]> {
  const { data, error } = await getSupabaseAdmin().from(GRANTS_TABLE).select(GRANT_COLUMNS);
  if (error || !data) return [];
  const grants: ProductionPlanningGrant[] = [];
  for (const row of data as { hr_id: unknown; level: unknown }[]) {
    const hrId = typeof row.hr_id === "string" ? row.hr_id.trim() : "";
    if (!hrId) continue;
    if (row.level !== "read" && row.level !== "full") continue;
    grants.push({ hrId, level: row.level });
  }
  return grants;
}

/**
 * This viewer's level, with the stored grants folded in.
 *
 * `roleActions` comes from the matrix here rather than inside `access.ts`, so that file stays free of
 * the matrix import and can be read from a client component.
 */
export async function resolveProductionPlanningLevel(
  context: Pick<AccessContext, "hrId" | "loginId" | "role">,
): Promise<ProductionPlanningLevel> {
  const roleActions = permissionMatrix[context.role]?.production_planning ?? null;

  // Skip the table read entirely for anybody the code already admits — which is everybody today.
  const withoutGrants = productionPlanningLevel(context, { roleActions, grants: null });
  if (withoutGrants === "full") return "full";

  const grants = await loadProductionPlanningGrants();
  const withGrants = productionPlanningLevel(context, { roleActions, grants });
  return withGrants === "none" ? withoutGrants : withGrants;
}

/** The level without touching the database — for a page shell that only needs to decide a redirect. */
export function resolveProductionPlanningLevelFromMatrix(
  context: Pick<AccessContext, "hrId" | "loginId" | "role">,
): ProductionPlanningLevel {
  return productionPlanningLevel(context, {
    roleActions: permissionMatrix[context.role]?.production_planning ?? null,
    grants: null,
  });
}
