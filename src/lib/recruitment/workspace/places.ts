// Recruitment workspace — the regions and areas a role tab is split by, with the vacant seats the
// owner asked to see beside them ("Alex-BHR · 2 vacant seats · 5 CVs", 20 Oct 2026).
//
// THE AREA LIST IS THE BOT'S OWN LIST, GROUPED THE BOT'S WAY. An applicant's area reply is filed
// under the area tab of the same name, so the tabs must be exactly what the WhatsApp bot offers:
// the ACTIVE rows of `au_v_canonical_areas`, in the org's sort order, each under its RECRUITMENT
// region from `recruitmentRegionForArea` — the Delta (3) override included, which is why this never
// reads `code_region_code` raw (whatsapp-classify-session.ts `loadAreasByRegion` and
// candidate-folder-options.ts carry the full account of that trap). The names are the canonical
// `area_name`, verbatim, because that is what the bot showed and what a placement stores.
//
// VACANT SEATS COME FROM THE SEAT MODEL, `au_v_org_tree` — never from the employees table, which
// counts people and cannot see an empty chair (rep-establishment.ts). A REP seat counts against its
// AREA, every product line together (the owner: "all product lines' teams in that area sit
// together"). A district manager seat — `DM`, or an `ACTING_DM`, which is a manager's chair however
// its occupant also sells — counts against its REGION. The per-line "Others" pseudo-DM is a bucket,
// not a chair, and is left out. Pedia's sales sub-regions UE-1/UE-2 count under the one Upper Egypt
// the apply flow offers (the owner's ruling of 2026-09-11, candidate-folder-suggestion.ts).
//
// Medical Rep → regions with areas; District Manager → regions only; every other tab → no places.
//
// Cached five minutes under `sos-reference`, the tag every seat move already revalidates
// (dashboard/invalidation.ts), so a hire shows up on the next read after it. What is cached is plain
// rows: `unstable_cache` serialises, and a Map would come back `{}`.

import { unstable_cache } from "next/cache";

import { candidateRegionCodes, candidateRegionLabels, recruitmentRegionForArea, type CandidateRegionCode } from "@/lib/recruitment/candidate-region";
import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import { fetchAllRows } from "@/lib/supabase/paginated";
import type { WorkspaceTabKey } from "@/lib/recruitment/workspace/role-tabs";
import type { WorkspacePlaces, WorkspaceRegion } from "@/lib/recruitment/workspace/types";

export type PlacesArea = { code: string; name: string; regionCode: string };
export type PlacesSnapshot = {
  /** Active canonical areas in the org's sort order, each with its RECRUITMENT region. */
  areas: PlacesArea[];
  /** Vacant REP seats per AU area code, every line together. */
  repVacantByArea: Record<string, number>;
  /** Vacant district-manager seats per recruitment region code. */
  dmVacantByRegion: Record<string, number>;
};

const DM_TIERS = new Set(["DM", "ACTING_DM"]);

/** A seat's sales region as the apply flow's region: UE-1/UE-2 are halves of the one Upper Egypt. */
export function recruitmentRegionForSeatRegion(raw: string | null | undefined): string | null {
  const code = String(raw ?? "").trim().toUpperCase();
  if (!code) return null;
  if ((candidateRegionCodes as readonly string[]).includes(code)) return code;
  if (code.startsWith("UE-")) return "UE";
  return null;
}

/** Fold the two raw reads into the snapshot. PURE, so the grouping is testable without a database. */
export function foldPlacesSnapshot(
  areaRows: readonly { area_code?: unknown; area_name?: unknown; code_region_code?: unknown; is_active?: unknown }[],
  seatRows: readonly { seat_tier?: unknown; region_code?: unknown; area_code?: unknown; is_vacant?: unknown; is_other_pseudo_dm?: unknown }[],
): PlacesSnapshot {
  const areas: PlacesArea[] = [];
  for (const row of areaRows) {
    if (row.is_active !== true) continue;
    const code = textOrNull(row.area_code);
    const name = textOrNull(row.area_name);
    const salesRegion = textOrNull(row.code_region_code);
    if (!code || !name || !salesRegion) continue;
    areas.push({ code, name, regionCode: recruitmentRegionForArea(name, salesRegion) });
  }

  const repVacantByArea: Record<string, number> = {};
  const dmVacantByRegion: Record<string, number> = {};
  for (const seat of seatRows) {
    if (seat.is_vacant !== true || seat.is_other_pseudo_dm === true) continue;
    const tier = String(seat.seat_tier ?? "").trim().toUpperCase();
    if (tier === "REP") {
      const area = textOrNull(seat.area_code);
      if (area) repVacantByArea[area] = (repVacantByArea[area] ?? 0) + 1;
    } else if (DM_TIERS.has(tier)) {
      const region = recruitmentRegionForSeatRegion(textOrNull(seat.region_code));
      if (region) dmVacantByRegion[region] = (dmVacantByRegion[region] ?? 0) + 1;
    }
  }
  return { areas, dmVacantByRegion, repVacantByArea };
}

const loadPlacesSnapshot = unstable_cache(
  async (): Promise<PlacesSnapshot> => {
    const supabase = recruitmentDb();
    const [areasResult, seats] = await Promise.all([
      supabase
        .from("au_v_canonical_areas")
        .select("area_code,area_name,code_region_code,sort_order,is_active")
        .eq("is_active", true)
        .order("sort_order", { ascending: true }),
      // Every seat, paged to the last row: an unpaged read stops at one response's worth with no error,
      // and half a seat model would count the wrong vacancies. The view holds one row per OCCUPANT (a
      // handover seat has two), so the order is occupant then seat id: together they are unique, which
      // paging needs.
      fetchAllRows<Record<string, unknown>>(
        () =>
          supabase
            .from("au_v_org_tree")
            .select("seat_tier,region_code,area_code,is_vacant,is_other_pseudo_dm")
            .order("occupant_hr_id", { ascending: true }),
        "seat_id",
      ),
    ]);
    if (areasResult.error) throw new Error(areasResult.error.message);
    return foldPlacesSnapshot((areasResult.data ?? []) as Array<Record<string, unknown>>, seats);
  },
  ["recruitment-workspace-places-v1"],
  { revalidate: 300, tags: ["sos-reference"] },
);

function regionName(code: string): string {
  return candidateRegionLabels[code as CandidateRegionCode] ?? code;
}

/** The places of one tab from a snapshot. PURE. Regions keep the apply flow's own order. */
export function buildWorkspacePlaces(tab: WorkspaceTabKey | null, snapshot: PlacesSnapshot): WorkspacePlaces {
  if (tab === "medical_rep") {
    const regions: WorkspaceRegion[] = [];
    for (const code of candidateRegionCodes) {
      const areas = snapshot.areas
        .filter((area) => area.regionCode === code)
        .map((area) => ({ code: area.code, name: area.name, vacantSeats: snapshot.repVacantByArea[area.code] ?? 0 }));
      if (areas.length === 0) continue;
      regions.push({
        areas,
        code,
        name: regionName(code),
        vacantSeats: areas.reduce((sum, area) => sum + area.vacantSeats, 0),
      });
    }
    return { regions };
  }
  if (tab === "district_manager") {
    return {
      regions: candidateRegionCodes.map((code) => ({
        areas: [],
        code,
        name: regionName(code),
        vacantSeats: snapshot.dmVacantByRegion[code] ?? 0,
      })),
    };
  }
  return { regions: [] };
}

export async function loadWorkspacePlaces(tab: WorkspaceTabKey | null): Promise<WorkspacePlaces> {
  if (tab !== "medical_rep" && tab !== "district_manager") return { regions: [] };
  return buildWorkspacePlaces(tab, await loadPlacesSnapshot());
}

/** One active canonical area by code, with its recruitment region — the HR placement's check. */
export async function findWorkspaceArea(areaCode: string): Promise<PlacesArea | null> {
  const wanted = String(areaCode ?? "").trim().toUpperCase();
  if (!wanted) return null;
  const snapshot = await loadPlacesSnapshot();
  return snapshot.areas.find((area) => area.code.toUpperCase() === wanted) ?? null;
}
