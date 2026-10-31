import { cache } from "react";

import { resolveEmployeeIdentityId, type AccessContext } from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// WHICH AREAS ARE THIS MEDICAL REP'S OWN — the one resolution every rep-facing sales surface shares.
//
// A rep's sales access scope is SELF, which the sales engine reads at REGION level: their region label,
// so every sibling rep's area in that region. That is wider than their scope. The owner's standing rule
// is that scope runs downward only — never anyone at or above your own rank — and a sibling rep is at
// their rank. So a rep-facing surface narrows them to the areas resolved here: the Territory Drilldown
// and the pharmacy action lists (through territory/root-scope.ts), and the portal Monthly Closing.
//
// The chain, each link failing CLOSED: employees.area_id → public.areas (active) → the
// au.sos_area_crosswalk RPC → only codes the Source of Sales area master actually knows. Kept in
// its own module, rather than inside root-scope.ts, so the closing loaders can use it without
// importing the territory module and the portal SoS dashboard behind it.

export const MEDICAL_REP_AREA_UNRESOLVED_MESSAGE =
  "We don't have your area on file yet. Contact HR/your admin to get your territory assigned.";

/**
 * The Source of Sales NAME masters — `loadSalesReferenceData({ includeCustomerBricks: false })` —
 * read at most ONCE per server-component render.
 *
 * WHY (2026-10-01, "slow to transfer between page and page"): the Territory Drilldown page read the
 * same masters twice in one render — here, to confirm a rep's own area codes, and again in
 * territory/skeleton.ts to list his blocks and bricks — six paged reads each time. React `cache`
 * shares one read across a single request's render and nothing more: it starts fresh for every
 * request, and with no render in progress it calls straight through, exactly as before. Both
 * callers only READ the masters, so sharing one object between them is safe.
 */
export const loadSalesNameMastersOncePerRender = cache(() =>
  loadSalesReferenceData({ includeCustomerBricks: false }),
);

/**
 * The Source of Sales area codes (UPPER-cased) this rep covers, or null when the rep's record holds no
 * area the chain can follow. Null is an access answer — "no area on file" — and callers must show
 * nothing for it, never fall back to the rep's region.
 *
 * A read that FAILS throws instead (31 Oct 2026 System Audit digest): during the 29 Oct 14:04
 * outage a timed-out `areas` read came back as "no area", and a rep whose area (Alex West) was on
 * file was told "We don't have your area on file yet". Data is withheld either way; only the
 * sentence changes — a failure reads as a failure, never as a fact about the rep's record.
 *
 * `references` lets a caller that has already read the sales reference data (the closing details
 * loader) skip a second read of it; only its area master is used.
 */
export async function resolveMedicalRepSosAreaCodes(
  ctx: AccessContext,
  options?: { references?: { areas?: ReadonlyArray<{ areaCode: string }> | null } },
): Promise<string[] | null> {
  const currentHrId = resolveEmployeeIdentityId(ctx);
  if (!currentHrId) return null;

  const viewerKey = canonicalHrIdKey(currentHrId);
  const directory = await getEmployeeDirectory();
  const viewer = directory.employees.find((employee) => canonicalHrIdKey(employee.hrId) === viewerKey);
  const areaId = viewer?.areaId ?? null;
  if (areaId == null) return null;

  const supabase = getSupabaseAdmin();
  const { data: areaRow, error: areaError } = await supabase
    .from("areas")
    .select("code, is_active")
    .eq("id", areaId)
    .maybeSingle();
  if (areaError) throw areaError;
  const typedAreaRow = areaRow as { code?: string | null; is_active?: boolean | null } | null;
  const canonicalAreaCode = typedAreaRow?.is_active ? String(typedAreaRow.code ?? "").trim() : "";
  if (!canonicalAreaCode) return null;

  const { data: crosswalkRows, error: crosswalkError } = await supabase.rpc(
    "phx_territory_resolve_sos_area_codes",
    { p_canonical_area_code: canonicalAreaCode },
  );
  if (crosswalkError) throw crosswalkError;
  const sosAreaCodes = ((crosswalkRows ?? []) as Array<{ sos_area_code: string }>)
    .map((row) => String(row.sos_area_code ?? "").trim().toUpperCase())
    .filter(Boolean);
  if (sosAreaCodes.length === 0) return null;

  const references = options?.references ?? (await loadSalesNameMastersOncePerRender());
  const knownAreaCodes = new Set((references.areas ?? []).map((area) => area.areaCode.toUpperCase()));
  const confirmedAreaCodes = sosAreaCodes.filter((code) => knownAreaCodes.has(code));
  return confirmedAreaCodes.length > 0 ? confirmedAreaCodes : null;
}
