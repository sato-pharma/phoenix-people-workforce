import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Seat-derived AREA scope for District / Regional Managers.
//
// WHY THIS EXISTS: a district's areas are NOT always inside its geographic region. The People
// Organogram seat map (au.line_area_map) carries BOTH signals and they legitimately disagree:
//
//   au_v_line_area_map.operational_region_code  = which DM territory actually owns the area
//   au_v_canonical_areas.code_region_code       = where the area sits geographically, and therefore
//                                                 the region_code its SALES rows carry
//
// e.g. CNS "Kafr El-Sheikh 1" (D16) is operationally owned by the CNS Alex-BHR DM (operational
// region AB) while its sales rows carry region D1 / Delta (1). Scoping that DM by his employee
// row's region NAME ("ALEX-BHR" → AB) therefore hid an entire rep's sales from his own manager.
// Six live areas differ this way today (Kafr El-Sheikh 1 under both CNS and Pedia, Helwan-Maadi
// under Pedia/Cairo, Down town under CNS/Giza, plus the Anti Infective UE-1/UE-2 split).
//
// So the authoritative answer to "which areas may this manager see?" is the seat map, never a
// region label. This module resolves that set once per viewer; `factRegionCodes` exists ONLY to
// widen row prefetch / RPC push-down so the out-of-region rows are actually fetched — it is never
// a sufficient authorization bound on its own, because it necessarily includes regions that also
// contain a SIBLING manager's areas. Always pair it with the `areaCodes` row filter.
// ─────────────────────────────────────────────────────────────────────────────

export type SeatAreaScope = {
  /**
   * Area codes (UPPER-cased) the viewer's own organogram seat operationally owns. This is the
   * authoritative bound — filter rows on it.
   */
  areaCodes: Set<string>;
  /**
   * The geographic region codes those areas' sales rows actually carry (UPPER-cased). A prefetch /
   * push-down widener only. NOT an authorization bound: it can include a region whose other areas
   * belong to a different manager, so it must always be combined with the `areaCodes` filter.
   */
  factRegionCodes: Set<string>;
};

/**
 * Roles whose sales visibility is defined by an organogram SEAT rather than a region label. Only
 * these roles get a seat-derived area scope; every other role keeps the existing region-name
 * behaviour byte-for-byte (Medical Reps stay region-scoped as before — narrowing a rep to their own
 * single area would be a separate product decision, not a bug fix).
 */
const SEAT_AREA_SCOPED_ROLES = new Set<PhoenixRole>(["District Manager", "Manager", "Regional Manager"]);

export function isSeatAreaScopedRole(role: PhoenixRole): boolean {
  return SEAT_AREA_SCOPED_ROLES.has(role);
}

type OrgTreeSeat = {
  seatId: string;
  seatTier: string;
  lineCode: string;
  path: string[];
  occupantHrId: string;
};

type LineAreaRow = { lineCode: string; areaCode: string; dmSeatId: string };

/** Case/whitespace-insensitive HR_ID key. Mirrors the comparison the org tree itself stores. */
function hrKey(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map<string, { scope: SeatAreaScope | null; at: number }>();

/** Test-only: drop the per-viewer cache so a test can control what the next resolution returns. */
export function __resetSeatAreaScopeCacheForTests(): void {
  cache.clear();
}

let seatAreaInputsLoaderForTests: typeof loadSeatAreaInputs | null = null;

/** Test-only: replace the organogram reads (null restores them). */
export function __setSeatAreaInputsLoaderForTests(loader: typeof loadSeatAreaInputs | null): void {
  seatAreaInputsLoaderForTests = loader;
}

/** The three organogram reads behind resolveSeatAreaScope. Throws on any read error. */
async function loadSeatAreaInputs(): Promise<{
  seats: OrgTreeSeat[];
  lineAreas: LineAreaRow[];
  factRegionByAreaCode: Map<string, string>;
}> {
  const supabase = getSupabaseAdmin();
  const [seatRows, areaRows, canonicalRows] = await Promise.all([
    supabase.from("au_v_org_tree").select("seat_id,seat_tier,line_code,path,occupant_hr_id"),
    // Current rows only: superseded (line, area, dm_seat) mappings must not widen or
    // contaminate a manager's area set after a re-map. Matches region-resolver.ts's policy.
    supabase.from("au_v_line_area_map").select("line_code,area_code,dm_seat_id").is("effective_to", null),
    supabase.from("au_v_canonical_areas").select("area_code,code_region_code"),
  ]);
  if (seatRows.error) throw seatRows.error;
  if (areaRows.error) throw areaRows.error;
  if (canonicalRows.error) throw canonicalRows.error;

  const seats: OrgTreeSeat[] = (seatRows.data ?? []).map((row) => {
    const typed = row as {
      seat_id?: string | null;
      seat_tier?: string | null;
      line_code?: string | null;
      path?: string[] | null;
      occupant_hr_id?: string | null;
    };
    return {
      seatId: String(typed.seat_id ?? "").trim(),
      seatTier: String(typed.seat_tier ?? "").trim().toUpperCase(),
      lineCode: String(typed.line_code ?? "").trim(),
      path: Array.isArray(typed.path) ? typed.path.map((value) => String(value ?? "").trim()) : [],
      occupantHrId: String(typed.occupant_hr_id ?? "").trim(),
    };
  });
  const lineAreas: LineAreaRow[] = (areaRows.data ?? []).map((row) => {
    const typed = row as { line_code?: string | null; area_code?: string | null; dm_seat_id?: string | null };
    return {
      lineCode: String(typed.line_code ?? "").trim(),
      areaCode: String(typed.area_code ?? "").trim(),
      dmSeatId: String(typed.dm_seat_id ?? "").trim(),
    };
  });
  const factRegionByAreaCode = new Map<string, string>();
  for (const row of canonicalRows.data ?? []) {
    const typed = row as { area_code?: string | null; code_region_code?: string | null };
    const code = String(typed.area_code ?? "").trim().toUpperCase();
    const region = String(typed.code_region_code ?? "").trim();
    if (code && region) factRegionByAreaCode.set(code, region);
  }
  return { seats, lineAreas, factRegionByAreaCode };
}

/**
 * Pure core: given the org tree, the line→area seat map and the area→fact-region map, resolve the
 * seat area scope for one viewer. Returns null when the viewer occupies no DM/ACTING_DM/RSM seat, which the
 * caller must treat as "no seat scope available" (fall back to the legacy region-name bound) rather
 * than as "sees nothing" — an unseated manager is a data gap, not a permission decision.
 *
 * Unit-tested directly; every DB shape is passed in.
 */
export function computeSeatAreaScope(input: {
  viewerHrId: string;
  seats: OrgTreeSeat[];
  lineAreas: LineAreaRow[];
  factRegionByAreaCode: Map<string, string>;
}): SeatAreaScope | null {
  const viewer = hrKey(input.viewerHrId);
  if (!viewer) return null;

  const ownSeats = input.seats.filter(
    (seat) =>
      hrKey(seat.occupantHrId) === viewer &&
      (seat.seatTier === "DM" || seat.seatTier === "ACTING_DM" || seat.seatTier === "RSM"),
  );
  if (ownSeats.length === 0) return null;

  // A DM owns their own seat's areas. An RSM owns every DM seat in their subtree — resolved from the
  // materialised `path` so an extra tier between RSM and DM would still be covered.
  const ownSeatIds = new Set(ownSeats.map((seat) => seat.seatId));
  const dmSeatIds = new Set<string>();
  const lineCodes = new Set<string>();
  // ACTING_DM is a first-class district seat here: the line-area map's dm_seat_id points at
  // the ACTING_DM seat itself for its areas (verified live: anti_infective UE1/UE2 →
  // SEAT-AIF-ADM-UE-1), so excluding the tier silently dropped the acting manager to the
  // line-blind region-label fallback.
  for (const seat of ownSeats) {
    if (seat.seatTier === "DM" || seat.seatTier === "ACTING_DM") {
      dmSeatIds.add(seat.seatId);
      if (seat.lineCode) lineCodes.add(seat.lineCode);
    }
  }
  for (const seat of input.seats) {
    if (seat.seatTier !== "DM" && seat.seatTier !== "ACTING_DM") continue;
    if (!seat.path.some((ancestor) => ownSeatIds.has(ancestor))) continue;
    dmSeatIds.add(seat.seatId);
    if (seat.lineCode) lineCodes.add(seat.lineCode);
  }
  if (dmSeatIds.size === 0) return null;

  const areaCodes = new Set<string>();
  for (const row of input.lineAreas) {
    if (!dmSeatIds.has(row.dmSeatId)) continue;
    // The seat map is per line, and a DM seat only ever belongs to one line, so the dm_seat_id match
    // above is already line-exact. The explicit line check guards against a future seat id reused
    // across lines silently widening the set.
    if (lineCodes.size > 0 && row.lineCode && !lineCodes.has(row.lineCode)) continue;
    const code = row.areaCode.trim().toUpperCase();
    if (code) areaCodes.add(code);
  }
  // A seated manager with zero mapped areas means the seat map is incomplete for them. Treat it the
  // same as "unseated" (null → legacy region bound) rather than returning an empty set, which would
  // black out their dashboards on a master-data gap.
  if (areaCodes.size === 0) return null;

  const factRegionCodes = new Set<string>();
  for (const code of areaCodes) {
    const region = input.factRegionByAreaCode.get(code);
    if (region) factRegionCodes.add(region.trim().toUpperCase());
  }

  return { areaCodes, factRegionCodes };
}

/**
 * Resolve the viewer's seat area scope from the organogram views. Returns null for a role that is
 * not seat-scoped, for a viewer who occupies no DM/RSM seat, and on ANY read failure — in every one
 * of those cases the caller keeps its existing region-name bound, so a failure here can never widen
 * visibility beyond what the same viewer already sees today. Cached ~60s per viewer.
 */
export async function resolveSeatAreaScope(ctx: AccessContext): Promise<SeatAreaScope | null> {
  if (!isSeatAreaScopedRole(ctx.role)) return null;
  const viewerHrId = hrKey(resolveEmployeeIdentityId(ctx) ?? ctx.hrId);
  if (!viewerHrId) return null;

  const cached = cache.get(viewerHrId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.scope;

  let scope: SeatAreaScope | null = null;
  let readFailed = false;
  try {
    const { seats, lineAreas, factRegionByAreaCode } = await (seatAreaInputsLoaderForTests ?? loadSeatAreaInputs)();
    scope = computeSeatAreaScope({ viewerHrId, seats, lineAreas, factRegionByAreaCode });
  } catch (error) {
    // null = "no seat scope". The callers decide what that means: the closing portal keeps its
    // region-name bound, while the Targets and Sales vs Target bounds fail CLOSED for a District /
    // Regional Manager (an honest "areas not found" message) rather than widening to his whole line.
    // The failure is never cached (below), so the next request reads the organogram again.
    console.log("Seat area scope resolution failed; falling back to region-name scope", {
      level: "warning",
      tags: { component: "sales-seat-area-scope", action: "resolveSeatAreaScope" },
      extra: { message: error instanceof Error ? error.message : String(error) },
    });
    scope = null;
    readFailed = true;
  }

  // A read FAILURE is never cached as "no seat scope": that would pin a District Manager to the
  // no-areas answer for a full minute after the organogram came back. Only a real answer is cached.
  if (!readFailed) cache.set(viewerHrId, { scope, at: Date.now() });
  return scope;
}
