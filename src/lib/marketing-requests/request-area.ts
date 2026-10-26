import { areaCodesByIds, sellingTerritoryCodes, type VenueTerritoryClient } from "@/lib/marketing-requests/venue-territory";

// ─────────────────────────────────────────────────────────────────────────────
// A marketing request is filed under a SELLING territory, or under none — never a retired region.
//
// WHAT WAS WRONG. The request form has no area picker. `prepareMarketingRequestDraft` stamped
// `area_id = customer.area_id ?? requester.areaId`, and a District Sales Manager's
// `employees.area_id` is a REGION-level legacy area (see `viewerAreaIdFor`). A customer the manager
// captured himself inherits that same region. So MKT-REQ-20261004-6D1003DC (EGP 3,600, Pedia) was
// filed under the retired "Delta (1)" area id 29, and MKT-REQ-20261015-2309D39C under "Alex-BHR"
// id 23 — buckets no brick belongs to, which no current area filter will ever list.
//
// WHAT THIS DOES. Walks the same candidates in the same order and keeps the first one that is a
// selling territory (an area code present in `source_of_sales_bricks`, the rule
// `isSellingTerritory` already uses). When none is, the request is filed under no area, and every
// report shows it under "Unassigned area" rather than under a region that no longer exists.
// Unknown (the bricks table could not be read) keeps the old behaviour: a failed read is never
// permission to drop an area.
//
// Existing rows are not touched. Re-pointing a filed request is the owner's call in the Marketing
// Requests screen.
// ─────────────────────────────────────────────────────────────────────────────

function areaIdOf(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * The area a new or resubmitted request is filed under.
 *
 * `sellingAreaIds` null means "we could not tell", and keeps the first candidate exactly as the
 * form always did.
 */
export function pickMarketingRequestAreaId(params: {
  explicitAreaId: number | string | null | undefined;
  customerAreaId: number | string | null | undefined;
  requesterAreaId: number | string | null | undefined;
  sellingAreaIds: ReadonlySet<number> | null | undefined;
}): number | null {
  const candidates = [params.explicitAreaId, params.customerAreaId, params.requesterAreaId]
    .map(areaIdOf)
    .filter((id): id is number => id !== null);
  if (candidates.length === 0) return null;
  if (!params.sellingAreaIds) return candidates[0];
  return candidates.find((id) => params.sellingAreaIds?.has(id)) ?? null;
}

/**
 * Which of these area ids are selling territories? Null when either read failed — the caller must
 * treat that as "unknown", never as "none".
 */
export async function sellingAreaIdsAmong(
  supabase: VenueTerritoryClient,
  areaIds: ReadonlyArray<number | string | null | undefined>,
): Promise<Set<number> | null> {
  const ids = Array.from(new Set(areaIds.map(areaIdOf).filter((id): id is number => id !== null)));
  if (ids.length === 0) return new Set<number>();
  const codeByAreaId = await areaCodesByIds(supabase, ids);
  if (codeByAreaId === null) return null;
  const rows = Array.from(codeByAreaId, ([id, code]) => ({ code, id }));
  const selling = await sellingTerritoryCodes(supabase, rows.map((row) => row.code));
  if (selling === null) return null;
  return new Set(rows.filter((row) => selling.has(row.code)).map((row) => row.id));
}
