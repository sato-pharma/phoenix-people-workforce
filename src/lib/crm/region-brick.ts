/**
 * CRM region -> Phoenix brick resolution — the "Region Mapping" admin tab's punch-list + resolver.
 * Mirrors the Unmapped Agents pattern (identity.ts / admin.ts's getUnmappedCrmIdentities /
 * setUnmappedCrmIdentityResolution) exactly, but keyed on iReports360's crm_region_id (a locality,
 * e.g. "Dokki") instead of an agent crm_id, and resolving to a real Phoenix brick
 * (source_of_sales_bricks.brick_id) instead of an employees.hr_id.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { isCrmSchemaMissingError } from "@/lib/crm/schema";
import { refreshSharedRegionBrickMap } from "@/lib/crm/shared-windows";
import {
  buildBrickNameIndex,
  suggestBrickForCrmRegion,
  type BrickForSuggestion,
  type CrmRegionBrickSuggestion,
} from "@/lib/crm/region-brick-suggest";
import { CRM_CONTACT_MASTER_TABLE, CRM_REGION_BRICK_RESOLUTIONS_TABLE, CRM_VISITS_TABLE } from "@/lib/crm/tables";

const visitsTable = CRM_VISITS_TABLE;
const resolutionsTable = CRM_REGION_BRICK_RESOLUTIONS_TABLE;

/** Admin resolution for a CRM region that never auto-maps: mapped (a real brick_id was assigned),
 * ignored (an admin decided this region isn't worth mapping — e.g. a CRM geography artifact — hide
 * it without ever assigning a brick), or pending (default, keeps showing on the punch-list). */
export type CrmRegionResolutionAction = "ignored" | "mapped" | "pending";

/** One row on the Region Mapping punch-list: a CRM region with no "mapped" resolution yet. */
export type UnmappedCrmRegionRow = {
  /** The vendor's own id — or, for a PLAN-ONLY locality, the negative stand-in planOnlyCrmRegionId. */
  crmRegionId: number;
  crmRegionName: string;
  /** Visit dates; for a plan-only locality, the contact master's first-seen/last-visit dates of its
   * customers, "" when it has none. */
  firstSeen: string;
  lastSeen: string;
  /**
   * Set only for a PLAN-ONLY locality — one no visit carries, known only from reps' plans and doctor
   * lists (visitCount 0): how many customers sit in it. Null for a visited region.
   */
  planOnlyCustomerCount: number | null;
  visitCount: number;
  /**
   * The brick this region probably IS, from its Arabic name plus the organogram area its visiting
   * reps sit in. A SUGGESTION — never applied, never written, and null when the two signals cannot
   * agree on one brick. See `@/lib/crm/region-brick-suggest`.
   */
  suggestion: CrmRegionBrickSuggestion | null;
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
  planOnlyCustomerCount: number | null;
  visitCount: number;
  /** Visits per organogram area of the rep who logged them — the second, name-blind signal. */
  repAreaCounts: Map<string, number>;
};

type StoredResolution = { brickId: string | null; name: string | null; status: string };

/** Every stored resolution decision, keyed by crm_region_id. Returns an empty map (never throws)
 * before the migration ships, matching the identity-resolutions read pattern. */
async function loadResolutionsByRegionId(): Promise<Map<number, StoredResolution>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from(resolutionsTable).select("crm_region_id, crm_region_name, brick_id, status");
  if (error) {
    if (isCrmSchemaMissingError(error)) return new Map();
    throw new Error(error.message);
  }
  const map = new Map<number, StoredResolution>();
  for (const row of (data ?? []) as Array<{
    brick_id: string | null;
    crm_region_id: number;
    crm_region_name: string | null;
    status: string;
  }>) {
    map.set(row.crm_region_id, { brickId: row.brick_id, name: row.crm_region_name, status: row.status });
  }
  return map;
}

/** How the contact master matches a locality NAME to a resolution row: `lower(btrim(name))` in
 * crm_contact_master_refresh's region-from-name step. The same key here, so what this tab lists is
 * exactly what that step will place. */
function regionNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The stand-in crm_region_id for a PLAN-ONLY locality — a place known only from reps' plans and doctor
 * lists. The vendor sends those two feeds with the locality's NAME and never its id (measured
 * 2026-09-21: no id in either payload), so a locality no visit has reached has no id to key a
 * resolution on. This makes one from the name: FNV-1a over the name key, as a NEGATIVE number, which
 * no vendor id can ever be. Stable forever, so the tab, the template and the resolver always agree.
 *
 * Nothing else has to change for the mapping to work: the contact master's region-from-name step
 * copies a resolution row's id onto every contact with no id whose locality name matches, and every
 * reader then joins on that id (or, on the reps list, on the name itself). When a visit later brings
 * the vendor's real id, that id is a separate region to map; the plan-only contacts keep the stand-in.
 */
export function planOnlyCrmRegionId(crmRegionName: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(regionNameKey(crmRegionName))) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return -((hash % 2147483647) + 1);
}

/** A stand-in id may only ever be written for the name it was made from, so a hand-edited sheet or a
 * crafted request cannot park a decision under an id nothing will ever read. Null when it is fine. */
function standInIdProblem(crmRegionId: number, crmRegionName: string | null | undefined): string | null {
  if (crmRegionId >= 0) return null;
  const name = crmRegionName?.trim();
  if (!name) return "This is a plan-only locality, and it needs its CRM region name to be saved.";
  if (planOnlyCrmRegionId(name) !== crmRegionId) {
    return `The CRM regionID on this row does not belong to the locality "${name}" — download a fresh template and map it there.`;
  }
  return null;
}

/**
 * Every PLAN-ONLY locality: a locality name on a contact-master customer that has no vendor region id
 * (it came from a plan or a doctor list) — or only a stand-in one — and that nothing else already
 * covers. A name is covered when a visited region carries it (that region is on this list, and mapping
 * it names a resolution row the contact master matches by name), or when a real region's resolution
 * row does (the contact master already matches it by name). Read from `crm_contacts`, which holds
 * every plan and list customer with its locality name. Empty (never throws) before that table ships.
 */
async function loadPlanOnlyRegions(
  visited: ReadonlyMap<number, MutableUnmappedRegion>,
  resolutions: ReadonlyMap<number, StoredResolution>,
): Promise<MutableUnmappedRegion[]> {
  const supabase = getSupabaseAdmin();
  const covered = new Set<string>();
  for (const region of visited.values()) covered.add(regionNameKey(region.crmRegionName));
  for (const [crmRegionId, resolution] of resolutions) {
    if (crmRegionId >= 0 && resolution.name) covered.add(regionNameKey(resolution.name));
  }

  const byKey = new Map<string, { contacts: Set<number>; firstSeen: string; lastSeen: string; spellings: Map<string, number> }>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(CRM_CONTACT_MASTER_TABLE)
      .select("contact_crm_id, crm_region_name, first_seen_on, last_visited_on")
      .or("crm_region_id.is.null,crm_region_id.lt.0")
      .not("crm_region_name", "is", null)
      .order("contact_crm_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isCrmSchemaMissingError(error)) return [];
      throw new Error(error.message);
    }
    const rows = (data ?? []) as Array<{
      contact_crm_id: number;
      crm_region_name: string | null;
      first_seen_on: string | null;
      last_visited_on: string | null;
    }>;
    for (const row of rows) {
      const spelling = row.crm_region_name?.trim();
      if (!spelling) continue;
      const key = regionNameKey(spelling);
      if (!key || covered.has(key)) continue;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { contacts: new Set(), firstSeen: "", lastSeen: "", spellings: new Map() };
        byKey.set(key, entry);
      }
      entry.contacts.add(Number(row.contact_crm_id));
      entry.spellings.set(spelling, (entry.spellings.get(spelling) ?? 0) + 1);
      const first = row.first_seen_on ?? "";
      const last = row.last_visited_on ?? row.first_seen_on ?? "";
      if (first && (!entry.firstSeen || first < entry.firstSeen)) entry.firstSeen = first;
      if (last && last > entry.lastSeen) entry.lastSeen = last;
    }
    if (rows.length < PAGE) break;
  }

  const regions: MutableUnmappedRegion[] = [];
  for (const entry of byKey.values()) {
    // The spelling most of its customers carry, so the row reads the way the reps wrote it.
    let name = "";
    let best = 0;
    for (const [spelling, count] of entry.spellings) {
      if (count > best) {
        name = spelling;
        best = count;
      }
    }
    regions.push({
      crmRegionId: planOnlyCrmRegionId(name),
      crmRegionName: name,
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
      planOnlyCustomerCount: entry.contacts.size,
      visitCount: 0,
      repAreaCounts: new Map(),
    });
  }
  return regions;
}

/** The one region universe getUnmappedCrmRegions and getAllCrmRegionsForTemplate both build on, so the
 * two can never disagree: every region a visit carries, plus every plan-only locality. */
async function loadRegionUniverse(): Promise<{
  regions: MutableUnmappedRegion[];
  resolutions: Map<number, StoredResolution>;
}> {
  const [visited, resolutions] = await Promise.all([scanAllCrmRegions(), loadResolutionsByRegionId()]);
  const planOnly = await loadPlanOnlyRegions(visited, resolutions);
  const regions = Array.from(visited.values());
  for (const region of planOnly) {
    if (!visited.has(region.crmRegionId)) regions.push(region);
  }
  return { regions, resolutions };
}

/** Busiest first; among plan-only localities, the one holding the most customers first. */
function byVolume(
  a: { planOnlyCustomerCount: number | null; visitCount: number },
  b: { planOnlyCustomerCount: number | null; visitCount: number },
): number {
  return b.visitCount - a.visitCount || (b.planOnlyCustomerCount ?? 0) - (a.planOnlyCustomerCount ?? 0);
}

/** Full keyset scan (id > cursor) of every distinct crm_region_id in ireports360_visits, with its
 * display name, visit count, and first/last-seen dates. Visited regions only — loadRegionUniverse adds
 * the plan-only localities. */
async function scanAllCrmRegions(): Promise<Map<number, MutableUnmappedRegion>> {
  const supabase = getSupabaseAdmin();
  const areaOfRep = await loadAreaByRepHrId();
  const regions = new Map<number, MutableUnmappedRegion>();
  const pageSize = 1000;
  let cursor: string | null = null;
  for (;;) {
    let query = supabase
      .from(visitsTable)
      // agent_hr_id rides along on the SAME scan rather than in a second one: it is what ties a
      // visit to an organogram area, and that area is the only signal that can tell "Dokki" (الدقى,
      // Giza) from "Edku" (إدكو, Beheira) — two different towns with the same consonant skeleton.
      .select("id, crm_region_id, crm_region_name, visit_date, agent_hr_id")
      .not("crm_region_id", "is", null)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) {
      if (isCrmSchemaMissingError(error)) return regions;
      throw new Error(error.message);
    }
    const page = (data ?? []) as Array<{
      agent_hr_id: string | null;
      crm_region_id: number;
      crm_region_name: string | null;
      id: string;
      visit_date: string;
    }>;
    for (const row of page) {
      let existing = regions.get(row.crm_region_id);
      if (!existing) {
        existing = {
          crmRegionId: row.crm_region_id,
          crmRegionName: row.crm_region_name ?? "(no name on visit)",
          firstSeen: row.visit_date,
          lastSeen: row.visit_date,
          planOnlyCustomerCount: null,
          visitCount: 1,
          repAreaCounts: new Map(),
        };
        regions.set(row.crm_region_id, existing);
      } else {
        existing.visitCount += 1;
        if (row.visit_date < existing.firstSeen) existing.firstSeen = row.visit_date;
        if (row.visit_date > existing.lastSeen) existing.lastSeen = row.visit_date;
      }
      const area = row.agent_hr_id ? areaOfRep.get(row.agent_hr_id.toLowerCase()) : undefined;
      if (area) existing.repAreaCounts.set(area, (existing.repAreaCounts.get(area) ?? 0) + 1);
    }
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].id;
  }
  return regions;
}

/** hr_id -> the organogram area of the seat that person holds. Degrades to an empty map rather than
 *  throwing: a missing seat model must cost the suggestion, never the punch-list itself. */
async function loadAreaByRepHrId(): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("au_v_org_tree")
    .select("occupant_hr_id, area_code")
    .not("occupant_hr_id", "is", null)
    .not("area_code", "is", null);
  if (error) return new Map();
  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ area_code: string; occupant_hr_id: string }>) {
    const key = row.occupant_hr_id.toLowerCase();
    if (!map.has(key)) map.set(key, row.area_code);
  }
  return map;
}

/** Every active brick, with the area and region names spelled out — the pool a suggestion is drawn
 *  from. Empty on any error: no bricks simply means no suggestions. */
async function loadBricksForSuggestion(): Promise<BrickForSuggestion[]> {
  const supabase = getSupabaseAdmin();
  const [bricks, areas, regions] = await Promise.all([
    supabase.from("source_of_sales_bricks").select("brick_id, brick_name, area_code, region_code").eq("active", true),
    supabase.from("source_of_sales_areas").select("area_code, area_name"),
    supabase.from("source_of_sales_regions").select("region_code, region_name"),
  ]);
  if (bricks.error) return [];
  const areaName = new Map<string, string>(
    ((areas.data ?? []) as Array<{ area_code: string; area_name: string }>).map((a) => [a.area_code, a.area_name]),
  );
  const regionName = new Map<string, string>(
    ((regions.data ?? []) as Array<{ region_code: string; region_name: string }>).map((r) => [r.region_code, r.region_name]),
  );
  return ((bricks.data ?? []) as Array<{
    area_code: string | null;
    brick_id: string;
    brick_name: string;
    region_code: string | null;
  }>).map((brick) => ({
    brickId: brick.brick_id,
    brickName: brick.brick_name,
    areaCode: brick.area_code,
    areaName: brick.area_code ? (areaName.get(brick.area_code) ?? null) : null,
    regionCode: brick.region_code,
    regionName: brick.region_code ? (regionName.get(brick.region_code) ?? null) : null,
  }));
}

/** The organogram area holding most of a region's visits, or null when no visiting rep has a seat. */
function dominantAreaCode(counts: ReadonlyMap<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [area, count] of counts) {
    if (count > bestCount) {
      best = area;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Every distinct CRM region — visited, or a plan-only locality (loadPlanOnlyRegions) — that does not
 * yet have a "mapped" or "ignored" resolution: a punch-list for an admin to assign a real Phoenix
 * brick to, ranked by visit volume (highest first) so the busiest localities get attention first;
 * plan-only localities follow. Not date-scoped on purpose, same reasoning as
 * getUnmappedCrmIdentities: the goal is every region that still needs a decision, not just ones
 * active in a chosen window.
 */
export async function getUnmappedCrmRegions(): Promise<UnmappedCrmRegionRow[]> {
  const [{ regions, resolutions }, bricks] = await Promise.all([loadRegionUniverse(), loadBricksForSuggestion()]);
  const index = buildBrickNameIndex(bricks);
  return regions
    .filter((region) => {
      const status = resolutions.get(region.crmRegionId)?.status;
      return status !== "mapped" && status !== "ignored";
    })
    .map(({ repAreaCounts, ...region }) => ({
      ...region,
      suggestion: suggestBrickForCrmRegion(region.crmRegionName, dominantAreaCode(repAreaCounts), index),
    }))
    .sort(byVolume);
}

/** One row of the full download template: every CRM region ever seen, with its current
 * resolution (if any) — used by the Region Mapping tab's "Download Template" export so an admin
 * can bulk-edit/correct every region (not just unmapped ones) in one spreadsheet. */
export type CrmRegionTemplateRow = {
  brickId: string | null;
  crmRegionId: number;
  crmRegionName: string;
  planOnlyCustomerCount: number | null;
  status: string;
  visitCount: number;
};

/** Every distinct CRM region ever seen — visited, or a plan-only locality (visit count 0, stand-in
 * id) — each annotated with its current resolution status/brick_id (or "pending"/null when never
 * resolved): the full punch-list for the downloadable template, unlike getUnmappedCrmRegions which
 * only lists the ones still needing a decision. Sorted by visit volume (highest first), same ranking
 * rationale. */
export async function getAllCrmRegionsForTemplate(): Promise<CrmRegionTemplateRow[]> {
  const { regions, resolutions } = await loadRegionUniverse();
  return regions
    .map((region) => {
      const resolution = resolutions.get(region.crmRegionId);
      return {
        brickId: resolution?.brickId ?? null,
        crmRegionId: region.crmRegionId,
        crmRegionName: region.crmRegionName,
        planOnlyCustomerCount: region.planOnlyCustomerCount,
        status: resolution?.status ?? "pending",
        visitCount: region.visitCount,
      };
    })
    .sort(byVolume);
}

/** One active Phoenix brick, pre-joined up its full geography chain (block -> area -> region) with
 * both codes AND names — the reference list embedded in the Region Mapping template so that typing a
 * Brick ID auto-fills every geography column via an in-sheet VLOOKUP. The geography is deliberately
 * line-independent: every area serves all product lines (verified — each of the 42 areas maps to all
 * lines), so a brick alone fully determines block/area/region; there is no per-line rollup to pick. */
export type CrmBrickReferenceRow = {
  areaCode: string;
  areaName: string;
  blockCode: string;
  blockName: string;
  brickId: string;
  brickName: string;
  regionCode: string;
  regionName: string;
};

/**
 * Bulk source_file values known to be the pre-rebuild legacy master, never a valid signal that a
 * brick is current. Everything else — including a brand-new one-off `source_file` that never
 * stamped `effective_from` (e.g. a same-day correction dropped straight into prod) — counts as
 * current. See isCurrentlyTaggedBrick's doc comment for why this is safer than trusting
 * `effective_from` alone.
 */
const LEGACY_SOURCE_FILES = new Set<string>(["Vlookup-Masterrr.xlsx"]);

/**
 * True if this brick carries a positive "this is current geography" signal, independent of the
 * per-area fallback below. Two signals, either one suffices:
 *  - `effective_from` is stamped — the 2026-07-23/24/27 rebuild imports all set this.
 *  - its `source_file` is anything other than the known legacy bulk master — catches a one-off
 *    row added straight to prod (a manual fix, a same-day patch) that never stamped
 *    `effective_from`. Verified 2026-07-28: every distinct source_file besides
 *    `Vlookup-Masterrr.xlsx` is either effective_from-tagged already, or a small (1-2 row)
 *    legitimate one-off addition — never a bulk legacy re-import.
 * Relying on `effective_from` alone silently hid a brand-new brick the moment its area had
 * already been rebuilt once before (the new row and the old legacy rows became indistinguishable
 * — both lacked effective_from). This is the bug the 2026-07-28 "new bricks missing from the
 * template" report traced to.
 */
function isCurrentlyTaggedBrick(b: { effective_from: string | null; source_file: string | null }): boolean {
  if (b.effective_from != null) return true;
  return b.source_file != null && !LEGACY_SOURCE_FILES.has(b.source_file);
}

/**
 * The bricks an admin may map a CRM region TO — i.e. the CURRENT geography, joined to the
 * block/area/region masters for their display names.
 *
 * "Active" alone is NOT the right filter here. The owner's standing rule is ADD+UPDATE only, never
 * retire a brick (retiring orphans historical customer/sales rows), so superseded bricks from the
 * pre-rebuild era stay `active = true` forever. Offering those as mapping targets is wrong — a new
 * mapping must never point at a replaced brick ("no old brick is ever a target").
 *
 * The rule is applied PER AREA via isCurrentlyTaggedBrick: an area that was rebuilt offers only
 * its currently-tagged bricks, while an area the rebuild never touched (the Others/OT areas —
 * North & South Sinai, New Valley, Hurgada, Luxor, Aswan, Ismailia) keeps its existing bricks,
 * since those are the only bricks it has. A blanket "must be tagged current" filter would silently
 * drop those areas entirely.
 * Verified against production 2026-07-28: 912 active → 751 offered, still covering all 48 areas
 * (includes the 2 brand-new same-day bricks that effective_from alone would have hidden).
 *
 * Small masters (bricks ~1k, blocks/areas/regions ≤ a few hundred), joined in memory. Name lookups
 * degrade to "" on a missing/failed master read (names are cosmetic); a bricks read error throws
 * (the reference would otherwise be silently empty). Sorted region → area → block → brick so the
 * reference sheet reads as a clean geography tree.
 */
export async function getActiveBricksForTemplateReference(): Promise<CrmBrickReferenceRow[]> {
  const supabase = getSupabaseAdmin();
  // Paginated: source_of_sales_bricks is 1,142 rows, so a single unpaginated read silently
  // truncated the reference sheet at PostgREST's 1,000-row cap.
  const [bricks, blocksRes, areasRes, regionsRes] = await Promise.all([
    fetchAllRows<Record<string, unknown>>(
      () =>
        supabase
          .from("source_of_sales_bricks")
          .select("brick_id, brick_name, block_code, area_code, region_code, active, effective_from, source_file"),
      "brick_id",
    ),
    supabase.from("source_of_sales_blocks").select("block_code, description"),
    supabase.from("source_of_sales_areas").select("area_code, area_name"),
    supabase.from("source_of_sales_regions").select("region_code, region_name"),
  ]);
  // fetchAllRows throws on error, so there is no error branch to check here.

  const blockName = new Map<string, string>();
  for (const b of (blocksRes.data ?? []) as Array<{ block_code: string | null; description: string | null }>) {
    if (b.block_code) blockName.set(b.block_code, b.description ?? "");
  }
  const areaName = new Map<string, string>();
  for (const a of (areasRes.data ?? []) as Array<{ area_code: string | null; area_name: string | null }>) {
    if (a.area_code) areaName.set(a.area_code, a.area_name ?? "");
  }
  const regionName = new Map<string, string>();
  for (const r of (regionsRes.data ?? []) as Array<{ region_code: string | null; region_name: string | null }>) {
    if (r.region_code) regionName.set(r.region_code, r.region_name ?? "");
  }

  const allBricks = (bricks ?? []) as Array<{
    active: boolean | null;
    area_code: string | null;
    block_code: string | null;
    brick_id: string | null;
    brick_name: string | null;
    effective_from: string | null;
    region_code: string | null;
    source_file: string | null;
  }>;

  // Areas the geography rebuild actually touched (any active brick with a positive current-tag
  // signal). Only those areas drop their pre-rebuild bricks; an untouched area keeps everything.
  const rebuiltAreas = new Set<string>();
  for (const b of allBricks) {
    if (b.area_code && (b.active ?? true) && isCurrentlyTaggedBrick(b)) rebuiltAreas.add(b.area_code);
  }

  const rows: CrmBrickReferenceRow[] = allBricks
    .filter((b) => {
      if (!b.brick_id || !(b.active ?? true)) return false;
      const areaCode = b.area_code ?? "";
      return isCurrentlyTaggedBrick(b) || !rebuiltAreas.has(areaCode);
    })
    .map((b) => {
      const blockCode = b.block_code ?? "";
      const areaCode = b.area_code ?? "";
      const regionCode = b.region_code ?? "";
      return {
        areaCode,
        areaName: areaName.get(areaCode) ?? "",
        blockCode,
        blockName: blockName.get(blockCode) ?? "",
        brickId: b.brick_id as string,
        brickName: b.brick_name ?? "",
        regionCode,
        regionName: regionName.get(regionCode) ?? "",
      };
    });

  // Explicit "en" locale on every key. These are human-readable names, so localeCompare IS right
  // here (unlike the ISO-date sorts in master.ts) — but passing no locale means the ordering follows
  // whatever the runtime default is, which differs between a developer's machine and the Cloud Run
  // container. The list is exported and compared against, so it has to sort identically everywhere.
  const collator = new Intl.Collator("en");
  const numericCollator = new Intl.Collator("en", { numeric: true });
  rows.sort(
    (a, b) =>
      collator.compare(a.regionName, b.regionName) ||
      collator.compare(a.areaName, b.areaName) ||
      collator.compare(a.blockCode, b.blockCode) ||
      numericCollator.compare(a.brickId, b.brickId),
  );
  return rows;
}

export type CurrentBrickInfo = { areaCode: string | null; regionCode: string | null };

/**
 * Lightweight validation index for "is this brick ID a valid target for a NEW mapping right now" —
 * used by both the Region Mapping and Customer Mapping resolvers (single-row resolve + bulk import)
 * so a superseded pre-rebuild brick can never be accepted just because it was typed/pasted correctly
 * (see getActiveBricksForTemplateReference's doc comment for why "active" alone is the wrong test).
 * Mirrors that function's exact per-area "current bricks" rule, but as an INDEPENDENT query rather
 * than a refactor of it — so the already-shipped template/reference behavior can never be put at
 * risk by a later change here.
 */
export async function getCurrentBrickIndex(): Promise<{ allKnown: Set<string>; current: Map<string, CurrentBrickInfo> }> {
  const supabase = getSupabaseAdmin();
  // Paginated: this index is the VALIDATION set for both the region and customer resolvers, so a
  // silent 1,000-row truncation (the table is 1,142 rows) made legitimate brick ids fail the
  // `allKnown` check and surfaced the flatly false 'no brick exists with that ID' error, blocking
  // real mapping imports.
  const data = await fetchAllRows<Record<string, unknown>>(
    () =>
      supabase
        .from("source_of_sales_bricks")
        .select("brick_id, area_code, region_code, active, effective_from, source_file"),
    "brick_id",
  );

  const allBricks = (data ?? []) as Array<{
    active: boolean | null;
    area_code: string | null;
    brick_id: string | null;
    effective_from: string | null;
    region_code: string | null;
    source_file: string | null;
  }>;

  const allKnown = new Set<string>();
  const rebuiltAreas = new Set<string>();
  for (const b of allBricks) {
    if (b.brick_id) allKnown.add(b.brick_id);
    if (b.area_code && (b.active ?? true) && isCurrentlyTaggedBrick(b)) rebuiltAreas.add(b.area_code);
  }

  const current = new Map<string, CurrentBrickInfo>();
  for (const b of allBricks) {
    if (!b.brick_id || !(b.active ?? true)) continue;
    const areaCode = b.area_code ?? "";
    const isCurrent = isCurrentlyTaggedBrick(b) || !rebuiltAreas.has(areaCode);
    if (isCurrent) current.set(b.brick_id, { areaCode: b.area_code, regionCode: b.region_code });
  }

  return { allKnown, current };
}

/**
 * Records an admin's decision for one CRM region:
 * - "ignored": stores the decision only — the region drops out of getUnmappedCrmRegions, on
 *   purpose no visit rows are touched.
 * - "mapped": validates brickId against the CURRENT brick index (getCurrentBrickIndex — active AND
 *   not superseded by the geography rebuild), upserts the resolution, and returns the brick's
 *   resolved area_code/region_code so the caller can show immediate feedback (the CRM Master Table
 *   reads this same resolution via loadBrickMappingByRegionId in crm/master.ts on its next render).
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
  const standInProblem = standInIdProblem(input.crmRegionId, input.crmRegionName);
  if (standInProblem) throw new Error(standInProblem);

  let resolvedBrickId: string | null = null;
  let resolvedAreaId: string | null = null;
  let resolvedRegionId: string | null = null;
  if (input.action === "mapped") {
    const typed = input.brickId?.trim();
    if (!typed) throw new Error("A brick ID is required to map this region.");
    // Validated through getCurrentBrickIndex, the same gate the customer resolver uses (and this
    // module's own bulk import). It used to check `active` alone against a direct row lookup, which
    // is a WEAKER test: a pre-rebuild brick superseded by the geography rebuild can still be
    // active=true, so the two mapping surfaces disagreed — customer mapping rejected the exact brick
    // id region mapping accepted, and the region resolution then pointed visits at stale geography.
    const { allKnown, current } = await getCurrentBrickIndex();
    const brick = current.get(typed);
    if (!brick) {
      const reason = allKnown.has(typed)
        ? "it exists but is inactive, or has been superseded by the geography rebuild"
        : "no brick exists with that ID";
      throw new Error(`Brick "${typed}" cannot be used — ${reason}.`);
    }
    resolvedBrickId = typed;
    resolvedAreaId = brick.areaCode;
    resolvedRegionId = brick.regionCode;
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
  // The Reps List groups by this map from a shared copy (src/lib/crm/reps-list.ts); the next open sees the mapping.
  refreshSharedRegionBrickMap("crm region mapping saved");

  return { areaId: resolvedAreaId, brickId: resolvedBrickId, regionId: resolvedRegionId };
}

/** One parsed row from an uploaded region-mapping spreadsheet, before validation. Column-parsing
 * (locating headers, reading cell text) lives in the API route; this service only deals in plain
 * values so it stays testable without ExcelJS/File in scope. */
export type CrmRegionBulkImportInputRow = {
  brickId: string;
  crmRegionId: number;
  crmRegionName: string;
  row: number;
  statusText: string;
};

export type CrmRegionBulkImportBlockedRow = { crmRegionId: number; reason: string; row: number };

export type CrmRegionBulkImportResult = {
  blockedRows: CrmRegionBulkImportBlockedRow[];
  ignored: number;
  mapped: number;
  skipped: number;
  totalRead: number;
};

const BULK_IMPORT_CHUNK = 500;

/** True for status text that means "mark this region ignored" (case/whitespace-insensitive). */
function isIgnoredStatusText(statusText: string): boolean {
  const normalized = statusText.trim().toLowerCase();
  return normalized === "ignore" || normalized === "ignored";
}

/**
 * Bulk-applies a whole parsed spreadsheet of CRM-region -> brick decisions in one call — the
 * "Upload Mapping" counterpart to the Region Mapping tab's one-row-at-a-time resolver. Each row:
 *   - Brick ID present -> validated against the real brick master (source_of_sales_bricks, must be
 *     active); invalid/unknown/inactive brick ids are rejected into blockedRows rather than
 *     silently skipped, so a typo is visible in the summary instead of quietly doing nothing.
 *   - Brick ID blank + Status says ignore/ignored -> resolved as "ignored".
 *   - Brick ID blank + no ignore status -> skipped (no change) — a blank row never resets an
 *     existing decision back to pending; use the single-row "Keep Pending" action for that.
 * Validates every brick_id against ONE batch-fetched CURRENT-brick index (getCurrentBrickIndex, not
 * one query per row) — the same gate the single-row resolver and the customer-mapping surface use,
 * so all three agree on what a usable brick is. The brick master is ~1,150 rows (it outgrew the
 * "~400" this comment used to claim, which is why the fetch is paginated) and this can process
 * hundreds of regions per upload.
 */
export async function bulkImportCrmRegionBrickMappings(input: {
  resolvedByHrId: string | null;
  rows: CrmRegionBulkImportInputRow[];
}): Promise<CrmRegionBulkImportResult> {
  const supabase = getSupabaseAdmin();

  // ONE batch-fetched validation index for the whole upload, and the SAME one the single-row
  // resolver and the customer-mapping surface use. It replaces a local active-only set: "active" is
  // a weaker test than "current", so a brick superseded by the geography rebuild used to pass here
  // and fail on the customer side. (It is internally paginated — truncation once made a valid brick
  // id look unknown and produced the false 'does not exist in the brick master' blocked-row reason
  // on a legitimate upload.)
  const { allKnown, current } = await getCurrentBrickIndex();

  const blockedRows: CrmRegionBulkImportBlockedRow[] = [];
  const upserts: Record<string, unknown>[] = [];
  let skipped = 0;
  let ignored = 0;
  const stamp = new Date().toISOString();

  for (const row of input.rows) {
    const brickId = row.brickId.trim();
    // Only a row that WRITES is checked: a blank row is skipped whatever its id says.
    const standInProblem =
      brickId || isIgnoredStatusText(row.statusText) ? standInIdProblem(row.crmRegionId, row.crmRegionName) : null;
    if (standInProblem) {
      blockedRows.push({ crmRegionId: row.crmRegionId, reason: standInProblem, row: row.row });
      continue;
    }
    if (!brickId) {
      if (isIgnoredStatusText(row.statusText)) {
        ignored += 1;
        upserts.push({
          brick_id: null,
          crm_region_id: row.crmRegionId,
          crm_region_name: row.crmRegionName || null,
          resolved_at: stamp,
          resolved_by_hr_id: input.resolvedByHrId,
          status: "ignored",
          updated_at: stamp,
        });
      } else {
        skipped += 1;
      }
      continue;
    }
    if (!allKnown.has(brickId)) {
      blockedRows.push({ crmRegionId: row.crmRegionId, reason: `Brick ID "${brickId}" does not exist in the brick master.`, row: row.row });
      continue;
    }
    if (!current.has(brickId)) {
      blockedRows.push({
        crmRegionId: row.crmRegionId,
        reason: `Brick ID "${brickId}" cannot be used — it exists but is inactive, or has been superseded by the geography rebuild.`,
        row: row.row,
      });
      continue;
    }
    upserts.push({
      brick_id: brickId,
      crm_region_id: row.crmRegionId,
      crm_region_name: row.crmRegionName || null,
      resolved_at: stamp,
      resolved_by_hr_id: input.resolvedByHrId,
      status: "mapped",
      updated_at: stamp,
    });
  }

  let mapped = 0;
  for (let index = 0; index < upserts.length; index += BULK_IMPORT_CHUNK) {
    const chunk = upserts.slice(index, index + BULK_IMPORT_CHUNK);
    const { error } = await supabase.from(resolutionsTable).upsert(chunk, { onConflict: "crm_region_id" });
    if (error) throw new Error(error.message);
    mapped += chunk.filter((c) => c.status === "mapped").length;
  }

  if (upserts.length > 0) refreshSharedRegionBrickMap("crm region mappings imported");

  return { blockedRows, ignored, mapped, skipped, totalRead: input.rows.length };
}
