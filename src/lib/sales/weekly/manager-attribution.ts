// Attribute a weekly sales fact row to the manager who owns it.
//
// AREA FIRST, REGION AS THE FALLBACK
// ──────────────────────────────────
// Phoenix's authoritative manager map is au_v_line_area_map: (line_code, area_code) -> the DM
// territory that owns that area ON THAT LINE. Weekly rows sit at DISTRIBUTOR-BRANCH grain, and a
// branch only carries an area once the owner has mapped it — so the area is present on some rows
// and absent on others. This resolver therefore uses BOTH keys, in strict precedence:
//
//   1. (line_code, area_code)   when the row carries an area. Authoritative, and needs no guessing.
//   2. (line_code, region_code) otherwise. The historical behaviour, unchanged.
//
// Why the precedence matters, measured in production 2026-08-26 on the three lines the owner
// actually tracks weekly (CNS, Anti Infective, Pedia — see isWeeklyTrackedLine):
//
//   • Anti Infective is the ONLY line whose organogram splits Upper Egypt, into UE-1 and UE-2.
//     The branch->region map assigns one plain "UE" per branch regardless of line, so every Anti
//     Infective UE row matched no seat: EGP 10,289,490, 21.3% of the line. Of that, EGP 4,027,715
//     sits on branches that DO carry an area, and rule 1 now resolves it exactly — UE1/UE2 -> UE-1,
//     UE3..UE8 -> UE-2. The EGP 6,261,775 on branches with no area still falls to rule 2 and still
//     buckets as unmapped, because "Upper Egypt" genuinely spans two DMs and guessing between them
//     is worse than saying so. Mapping those branches to areas is what closes the remainder.
//   • 15 line/area pairs where the geographic region and the organogram legitimately disagree —
//     EGP 5,298,449, e.g. Kafr El-Sheikh 1 (D16) sits in Delta (1) geographically but belongs to
//     the Alex-BHR manager on CNS and Pedia. Those were credited to the GEOGRAPHIC manager before;
//     rule 1 now credits the manager who actually owns them.
//
// A row whose area is not on the map keeps its geographic region rather than vanishing — a missing
// mapping must never cost the report a row of sales. Same principle as applyOperationalRegions in
// closing-organogram-regions.ts, which is where Monthly Closing does the equivalent job.
//
// The DM -> RSM -> NSM chain is walked from parent_seat_id, never hard-coded: the Pedia line has a
// real RSM seat (Alex-BHR, Delta (1), Delta (2)) sitting between DM and NSM, while Cairo, Giza, UE
// and Others report straight to the Pedia NSM. Hard-coding that shape would rot the moment a seat moves.

import { todayInCairo } from "@/lib/date-only";
import { resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Printed on every manager-grouped sheet. See the header comment for why it exists. */
export const ATTRIBUTION_CAVEAT =
  "Managers are attributed by line + area. A branch mapped to an area by hand uses that area; " +
  "otherwise the branch NAME is read, and a depot serving several territories divides its value " +
  "evenly between them and then evenly again inside each — so \"Minia and Assiut\" pays all four " +
  "Upper Egypt areas a quarter each. Warehouses, private hospitals and tenders are not territories " +
  "and stay at region level; a name that states no place stays with its region's manager.";

/** How a bucket was resolved. Drives section ordering: real managers first, residue last. */
export type WeeklyManagerKind = "dm" | "ceo" | "vacant" | "unmapped";

export type WeeklyManagerBucket = {
  /** Stable grouping key; also the de-dupe key across fact rows. */
  key: string;
  kind: WeeklyManagerKind;
  /** Human-readable section heading. Never a seat id or an HR ID — owner rule: names, not codes. */
  label: string;
  /** Manager's own name, or null when the seat is vacant / there is no manager. */
  managerName: string | null;
  /** "Pedia · Alex-BHR" — the scope this manager owns, for the section sub-heading. */
  scopeLabel: string;
  /** Regional Sales Manager above this DM, when the line has one (Pedia only, today). */
  rsmName: string | null;
  /** National Sales Manager above this DM / RSM. */
  nsmName: string | null;
  /** Ascending sort: dm(0) -> ceo(1) -> vacant(2) -> unmapped(3). */
  sortOrder: number;
};

type SeatNode = {
  seatId: string;
  seatTier: string;
  lineCode: string | null;
  regionCode: string | null;
  seatLabel: string | null;
  occupantHrId: string | null;
  isVacant: boolean;
  parentSeatId: string | null;
};

export type WeeklyManagerIndex = {
  /** `${lineCode}||${regionCode}` -> the DM/ACTING_DM seat that owns it. */
  dmByLineRegion: Map<string, SeatNode>;
  /**
   * `${lineCode}||${areaCode}` -> the operational region that owns that area ON THAT LINE.
   * Rule 1 of the precedence described at the top of this file. Empty when au_v_line_area_map
   * cannot be read, which simply leaves every row on the region fallback.
   */
  operationalRegionByLineArea: Map<string, string>;
  seatsById: Map<string, SeatNode>;
  /** hr_id -> display name. */
  nameByHrId: Map<string, string>;
  /** Region code -> region name, so sections read "Alex-BHR" not "AB". */
  regionNameByCode: Map<string, string>;
  ceoName: string | null;
};

const KIND_ORDER: Record<WeeklyManagerKind, number> = { dm: 0, ceo: 1, vacant: 2, unmapped: 3 };

const norm = (value: string | null | undefined) => (value ?? "").trim();
const normUpper = (value: string | null | undefined) => norm(value).toUpperCase();

/** Composite key for the DM lookup. Line codes are lower-case in au.seats, regions upper-case. */
export function managerKey(lineCode: string, regionCode: string): string {
  return `${lineCode.trim().toLowerCase()}||${normUpper(regionCode)}`;
}

/**
 * Load the seat tree + names once per export. Small: ~133 seats, ~1 employee-name query.
 *
 * Reads au_v_org_tree (the public wrapper over au.seats) rather than au.seats directly, because the
 * view already resolves occupant_hr_id and is_vacant from the open occupancy span — resolving those
 * by hand invites the "newest occupancy row wins" bug the AU resolvers exist to prevent.
 */
export async function loadWeeklyManagerIndex(): Promise<WeeklyManagerIndex> {
  const supabase = getSupabaseAdmin();

  const [treeResult, regionsResult, employeesResult, areaMapResult] = await Promise.all([
    supabase
      .from("au_v_org_tree")
      .select("seat_id, seat_tier, line_code, region_code, seat_label, occupant_hr_id, is_vacant, parent_seat_id"),
    supabase.from("au_v_regions").select("region_code, region_name"),
    supabase.from("employees").select("hr_id, full_name, nickname"),
    supabase
      .from("au_v_line_area_map")
      .select("line_code, area_code, operational_region_code, effective_from, effective_to"),
  ]);

  if (treeResult.error) throw treeResult.error;
  if (regionsResult.error) throw regionsResult.error;
  if (employeesResult.error) throw employeesResult.error;
  // The area map fails SOFT on purpose: without it every row simply falls to the region fallback,
  // which is exactly the behaviour that shipped before area precedence existed. Losing the whole
  // export because one supporting view is unreadable would be a far worse trade.

  const nameByHrId = new Map<string, string>();
  for (const row of employeesResult.data ?? []) {
    const record = row as Record<string, unknown>;
    const hrId = norm(String(record.hr_id ?? ""));
    if (!hrId) continue;
    const name = norm(String(record.full_name ?? "")) || norm(String(record.nickname ?? ""));
    if (name) nameByHrId.set(hrId, name);
  }

  const regionNameByCode = new Map<string, string>();
  for (const row of regionsResult.data ?? []) {
    const record = row as Record<string, unknown>;
    const code = normUpper(String(record.region_code ?? ""));
    if (!code) continue;
    regionNameByCode.set(code, norm(String(record.region_name ?? "")) || code);
  }

  // (line, area) -> operational region. Effective-dated exactly as loadLineOperationalRegions does,
  // so an area that has moved territory resolves to whoever owns it TODAY — Cairo's today. The UTC
  // date is still yesterday from 00:00 to 03:00 Cairo, so on the day an area changed hands both its
  // old row (ended yesterday) and its new one (starting today) failed the window and the area showed
  // no manager for those three hours (audit 2026-10-23, Pass 4).
  const today = todayInCairo();
  const operationalRegionByLineArea = new Map<string, string>();
  for (const row of areaMapResult.error ? [] : (areaMapResult.data ?? [])) {
    const record = row as Record<string, unknown>;
    const lineCode = norm(String(record.line_code ?? ""));
    const areaCode = normUpper(String(record.area_code ?? ""));
    const regionCode = normUpper(String(record.operational_region_code ?? ""));
    if (!lineCode || !areaCode || !regionCode) continue;
    const from = String(record.effective_from ?? "");
    const to = String(record.effective_to ?? "");
    if (from && from > today) continue;
    if (to && to < today) continue;
    operationalRegionByLineArea.set(managerKey(lineCode, areaCode), regionCode);
  }

  const seatsById = new Map<string, SeatNode>();
  const dmByLineRegion = new Map<string, SeatNode>();
  let ceoName: string | null = null;

  for (const row of treeResult.data ?? []) {
    const record = row as Record<string, unknown>;
    const seat: SeatNode = {
      seatId: norm(String(record.seat_id ?? "")),
      seatTier: normUpper(String(record.seat_tier ?? "")),
      lineCode: norm(String(record.line_code ?? "")) || null,
      regionCode: normUpper(String(record.region_code ?? "")) || null,
      seatLabel: norm(String(record.seat_label ?? "")) || null,
      occupantHrId: norm(String(record.occupant_hr_id ?? "")) || null,
      isVacant: record.is_vacant === true,
      parentSeatId: norm(String(record.parent_seat_id ?? "")) || null,
    };
    if (!seat.seatId) continue;
    seatsById.set(seat.seatId, seat);

    if (seat.seatTier === "CEO" && seat.occupantHrId) {
      ceoName = nameByHrId.get(seat.occupantHrId) ?? ceoName;
    }
    // ACTING_DM is a real DM for attribution purposes — it is a seat someone is covering, not a gap.
    if ((seat.seatTier === "DM" || seat.seatTier === "ACTING_DM") && seat.lineCode && seat.regionCode) {
      dmByLineRegion.set(managerKey(seat.lineCode, seat.regionCode), seat);
    }
  }

  return { dmByLineRegion, operationalRegionByLineArea, seatsById, nameByHrId, regionNameByCode, ceoName };
}

/** Climb parent_seat_id looking for a tier. Bounded so a cyclic parent chain can never hang an export. */
function findAncestorName(index: WeeklyManagerIndex, seat: SeatNode, tier: string): string | null {
  let current: SeatNode | null = seat.parentSeatId ? (index.seatsById.get(seat.parentSeatId) ?? null) : null;
  for (let hops = 0; current && hops < 10; hops += 1) {
    if (current.seatTier === tier) {
      return current.occupantHrId ? (index.nameByHrId.get(current.occupantHrId) ?? null) : null;
    }
    current = current.parentSeatId ? (index.seatsById.get(current.parentSeatId) ?? null) : null;
  }
  return null;
}

const UNMAPPED_BUCKET: WeeklyManagerBucket = {
  key: "unmapped",
  kind: "unmapped",
  label: "Unmapped — no manager seat for this region + line",
  managerName: null,
  scopeLabel: "",
  rsmName: null,
  nsmName: null,
  sortOrder: KIND_ORDER.unmapped,
};

/**
 * Resolve one fact row's manager. Pure — takes the loaded index, touches no I/O, so the whole
 * attribution table is unit-testable without a database.
 *
 * Head Office is deliberately NOT an error case: it is a real line carrying the largest unit volume
 * in the file (~1.17M units), it has no field seat by design, and the owner's ruling on 2026-08-11
 * was to show it under the CEO rather than drop or hide it.
 */
export function resolveWeeklyManager(
  index: WeeklyManagerIndex,
  officialLine: string | null | undefined,
  regionCode: string | null | undefined,
  areaCode?: string | null | undefined,
): WeeklyManagerBucket {
  const lineLabel = norm(officialLine);
  const lineCode = resolveTargetLineCode(lineLabel);

  // resolveTargetLineCode returns null for Head Office AND for an unrecognised/blank line. Only the
  // former is a CEO bucket; a blank line is genuinely unmapped and must not be laundered into one.
  if (!lineCode) {
    if (lineLabel.toLowerCase() === "head office") {
      return {
        key: "ceo||head-office",
        kind: "ceo",
        label: index.ceoName ?? "Head Office",
        managerName: index.ceoName,
        scopeLabel: "Head Office — no field manager",
        rsmName: null,
        nsmName: null,
        sortOrder: KIND_ORDER.ceo,
      };
    }
    return UNMAPPED_BUCKET;
  }

  // Rule 1: the branch is mapped to an area, so the organogram answers exactly who owns it on this
  // line. Rule 2: it is not, so fall back to the geographic region the row carries. An area the map
  // does not cover falls back too, rather than costing the report a row.
  const area = normUpper(areaCode);
  const operationalRegion = area ? index.operationalRegionByLineArea.get(managerKey(lineCode, area)) : undefined;
  const region = operationalRegion ?? normUpper(regionCode);
  if (!region) return UNMAPPED_BUCKET;

  const seat = index.dmByLineRegion.get(managerKey(lineCode, region));
  // No seat for this pair. Still real today for Anti Infective in Upper Egypt on branches carrying
  // NO area: that line's org splits UE into UE-1/UE-2 while the row carries plain "UE", so nothing
  // matches. Bucket it visibly rather than guessing between two managers — mapping the branch to an
  // area is what resolves it, via rule 1 above.
  if (!seat) return UNMAPPED_BUCKET;

  const regionName = index.regionNameByCode.get(region) ?? region;
  const scopeLabel = `${lineLabel || lineCode} · ${regionName}`;
  const managerName = seat.occupantHrId ? (index.nameByHrId.get(seat.occupantHrId) ?? null) : null;

  if (seat.isVacant || !managerName) {
    return {
      key: `vacant||${seat.seatId}`,
      kind: "vacant",
      label: `Vacant — ${scopeLabel}`,
      managerName: null,
      scopeLabel,
      rsmName: findAncestorName(index, seat, "RSM"),
      nsmName: findAncestorName(index, seat, "NSM"),
      sortOrder: KIND_ORDER.vacant,
    };
  }

  return {
    key: `dm||${seat.seatId}`,
    kind: "dm",
    label: managerName,
    managerName,
    scopeLabel,
    rsmName: findAncestorName(index, seat, "RSM"),
    nsmName: findAncestorName(index, seat, "NSM"),
    sortOrder: KIND_ORDER.dm,
  };
}

/** "reports to: Hany Saad Omar (RSM) -> Ali Elsayed (NSM)" for the section sub-heading. */
export function reportingLine(bucket: WeeklyManagerBucket): string {
  const parts: string[] = [];
  if (bucket.rsmName) parts.push(`${bucket.rsmName} (RSM)`);
  if (bucket.nsmName) parts.push(`${bucket.nsmName} (NSM)`);
  return parts.length > 0 ? `reports to: ${parts.join(" -> ")}` : "";
}

/** Section order: real managers alphabetically, then CEO, then vacant seats, then unmapped. */
export function compareManagerBuckets(a: WeeklyManagerBucket, z: WeeklyManagerBucket): number {
  if (a.sortOrder !== z.sortOrder) return a.sortOrder - z.sortOrder;
  return a.label.localeCompare(z.label) || a.scopeLabel.localeCompare(z.scopeLabel);
}
