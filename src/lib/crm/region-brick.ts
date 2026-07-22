/**
 * CRM region -> Phoenix brick resolution — the "Region Mapping" admin tab's punch-list + resolver.
 * Mirrors the Unmapped Agents pattern (identity.ts / admin.ts's getUnmappedCrmIdentities /
 * setUnmappedCrmIdentityResolution) exactly, but keyed on iReports360's crm_region_id (a locality,
 * e.g. "Dokki") instead of an agent crm_id, and resolving to a real Phoenix brick
 * (source_of_sales_bricks.brick_id) instead of an employees.hr_id.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isCrmSchemaMissingError } from "@/lib/crm/schema";
import { CRM_REGION_BRICK_RESOLUTIONS_TABLE, CRM_VISITS_TABLE } from "@/lib/crm/tables";

const visitsTable = CRM_VISITS_TABLE;
const resolutionsTable = CRM_REGION_BRICK_RESOLUTIONS_TABLE;

/** Admin resolution for a CRM region that never auto-maps: mapped (a real brick_id was assigned),
 * ignored (an admin decided this region isn't worth mapping — e.g. a CRM geography artifact — hide
 * it without ever assigning a brick), or pending (default, keeps showing on the punch-list). */
export type CrmRegionResolutionAction = "ignored" | "mapped" | "pending";

/** One row on the Region Mapping punch-list: a CRM region with no "mapped" resolution yet. */
export type UnmappedCrmRegionRow = {
  crmRegionId: number;
  crmRegionName: string;
  firstSeen: string;
  lastSeen: string;
  visitCount: number;
};

export type CrmRegionBrickResolutionResult = {
  areaId: string | null;
  brickId: string | null;
  regionId: string | null;
};

type MutableUnmappedRegion = {
  crmRegionId: number;
  crmRegionName: string;
  firstSeen: string;
  lastSeen: string;
  visitCount: number;
};

/**
 * Every distinct crm_region_id that does not yet have a "mapped" resolution — a punch-list for an
 * admin to assign a real Phoenix brick to, ranked by visit volume (highest first) so the busiest
 * localities get attention first. Not date-scoped on purpose, same reasoning as
 * getUnmappedCrmIdentities: the goal is every region that still needs a decision, not just ones
 * active in a chosen window. Keyset-paginated (id > cursor), not OFFSET — same reason as the
 * unmapped-identities scan (a narrow WHERE clause degrades badly under OFFSET pagination).
 */
export async function getUnmappedCrmRegions(): Promise<UnmappedCrmRegionRow[]> {
  const supabase = getSupabaseAdmin();
  const regions = new Map<number, MutableUnmappedRegion>();

  const { data: resolutions, error: resolutionsError } = await supabase
    .from(resolutionsTable)
    .select("crm_region_id, status");
  if (resolutionsError && !isCrmSchemaMissingError(resolutionsError)) throw new Error(resolutionsError.message);
  const resolvedIds = new Set<number>(
    ((resolutions ?? []) as Array<{ crm_region_id: number; status: string }>)
      .filter((r) => r.status === "mapped" || r.status === "ignored")
      .map((r) => r.crm_region_id),
  );

  const pageSize = 1000;
  let cursor: string | null = null;
  for (;;) {
    let query = supabase
      .from(visitsTable)
      .select("id, crm_region_id, crm_region_name, visit_date")
      .not("crm_region_id", "is", null)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) {
      if (isCrmSchemaMissingError(error)) return [];
      throw new Error(error.message);
    }
    const page = (data ?? []) as Array<{ crm_region_id: number; crm_region_name: string | null; id: string; visit_date: string }>;
    for (const row of page) {
      const existing = regions.get(row.crm_region_id);
      if (!existing) {
        regions.set(row.crm_region_id, {
          crmRegionId: row.crm_region_id,
          crmRegionName: row.crm_region_name ?? "(no name on visit)",
          firstSeen: row.visit_date,
          lastSeen: row.visit_date,
          visitCount: 1,
        });
      } else {
        existing.visitCount += 1;
        if (row.visit_date < existing.firstSeen) existing.firstSeen = row.visit_date;
        if (row.visit_date > existing.lastSeen) existing.lastSeen = row.visit_date;
      }
    }
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].id;
  }

  return Array.from(regions.values())
    .filter((region) => !resolvedIds.has(region.crmRegionId))
    .sort((a, b) => b.visitCount - a.visitCount);
}

/**
 * Records an admin's decision for one CRM region:
 * - "ignored": stores the decision only — the region drops out of getUnmappedCrmRegions, on
 *   purpose no visit rows are touched.
 * - "mapped": validates brickId against the real brick master (source_of_sales_bricks, must be
 *   active), upserts the resolution, and returns the brick's resolved area_code/region_code so the
 *   caller can show immediate feedback (the CRM Master Table reads this same resolution via
 *   loadBrickMappingByRegionId in crm/master.ts on its next render).
 * - "pending": explicitly resets to the default, no-decision state.
 */
export async function setCrmRegionBrickResolution(input: {
  action: CrmRegionResolutionAction;
  brickId?: string | null;
  crmRegionId: number;
  crmRegionName?: string | null;
  resolvedByHrId: string | null;
}): Promise<CrmRegionBrickResolutionResult> {
  const supabase = getSupabaseAdmin();

  let resolvedBrickId: string | null = null;
  let resolvedAreaId: string | null = null;
  let resolvedRegionId: string | null = null;
  if (input.action === "mapped") {
    const typed = input.brickId?.trim();
    if (!typed) throw new Error("A brick ID is required to map this region.");
    const { data: brick, error: brickError } = await supabase
      .from("source_of_sales_bricks")
      .select("brick_id, area_code, region_code, active")
      .eq("brick_id", typed)
      .maybeSingle();
    if (brickError) throw new Error(brickError.message);
    if (!brick) throw new Error(`No brick found with ID "${typed}".`);
    if (!brick.active) throw new Error(`Brick "${typed}" exists but is not active.`);
    resolvedBrickId = brick.brick_id as string;
    resolvedAreaId = (brick.area_code as string | null) ?? null;
    resolvedRegionId = (brick.region_code as string | null) ?? null;
  }

  const { error: upsertError } = await supabase.from(resolutionsTable).upsert(
    {
      brick_id: resolvedBrickId,
      crm_region_id: input.crmRegionId,
      crm_region_name: input.crmRegionName ?? null,
      resolved_at: new Date().toISOString(),
      resolved_by_hr_id: input.resolvedByHrId,
      status: input.action,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "crm_region_id" },
  );
  if (upsertError) throw new Error(upsertError.message);

  return { areaId: resolvedAreaId, brickId: resolvedBrickId, regionId: resolvedRegionId };
}
