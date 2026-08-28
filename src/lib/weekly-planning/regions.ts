/**
 * The planning geography vocabulary, shared by the server plan service and the employee
 * portal's plans workspace.
 *
 * This lives in one file on purpose. The canonicaliser used to be copy-pasted into both
 * `service.ts` and `plans-workspace.tsx`, and the two copies are what made an Upper Egypt
 * line-1 rep unable to plan at all: `employees.region_name` stores "Upper Egypt 1" /
 * "Upper Egypt 2" for line 1 and the plain "Upper Egypt" for lines 2 and 3, but both copies
 * only ever matched the plain spelling. Every line-1 Upper Egypt rep therefore canonicalised
 * to nothing, the Area picker rendered with zero options, and "Single Visit needs an area"
 * became an error the employee had no way to satisfy.
 */

/** The six regions an employee may plan against. Deliberately coarser than `employees.region_name`. */
export const APPROVED_PLANNING_REGIONS = [
  "ALEX-BHR",
  "Cairo",
  "Delta 1",
  "Delta 2",
  "Delta 3",
  "Giza",
  "Upper Egypt",
] as const;

export type ApprovedPlanningRegion = (typeof APPROVED_PLANNING_REGIONS)[number];

const ALEX_BHR_SPELLINGS = ["alex-bhr", "alex bhr", "alex/bhr", "alex", "alexandria", "bhr", "beheira"];

/**
 * Line 1 splits Upper Egypt into districts on the employee row ("Upper Egypt 1",
 * "Upper Egypt 2"); lines 2 and 3 store it unsuffixed. Planning has a single approved Upper
 * Egypt, so every district folds into it. Matching any trailing number — not just 1 and 2 —
 * so a future "Upper Egypt 3" does not silently empty the picker the way this did.
 *
 * Delta is NOT folded the same way: "Delta 1" and "Delta 2" are two separate approved
 * planning regions, so their numbers are meaningful and must survive canonicalisation.
 */
const UPPER_EGYPT_DISTRICT = /^upper egypt(?: \d+)?$/;

/** Lowercase, drop parentheses ("Delta (1)" -> "delta 1"), collapse whitespace. */
function normalizeRegionText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fold any stored region spelling onto one of APPROVED_PLANNING_REGIONS, or null when the
 * value is not a planning region at all (Head office, an empty cell, a typo).
 */
export function canonicalPlanningRegionName(value: unknown): ApprovedPlanningRegion | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const direct = APPROVED_PLANNING_REGIONS.find((region) => region.toLowerCase() === raw.toLowerCase());
  if (direct) return direct;

  const normalized = normalizeRegionText(raw);
  if (ALEX_BHR_SPELLINGS.includes(normalized)) return "ALEX-BHR";
  if (normalized === "cairo") return "Cairo";
  if (normalized === "delta 1" || normalized === "delta-1") return "Delta 1";
  if (normalized === "delta 2" || normalized === "delta-2") return "Delta 2";
  if (normalized === "delta 3" || normalized === "delta-3") return "Delta 3";
  if (normalized === "giza") return "Giza";
  if (UPPER_EGYPT_DISTRICT.test(normalized)) return "Upper Egypt";
  return null;
}

/** Anything carrying an area and the region that area sits in. */
export type PlanningSeat = {
  areaName?: string | null;
  regionName?: string | null;
};

/**
 * Every area a plan owner may pick inside `region`, in display order.
 *
 * Areas are derived from the Medical Rep roster because that roster IS the area map for the
 * owner's line, vacant seats included. `ownSeat` is the plan owner's own area, which is
 * never in that roster: the roster exists to pick a Double Visit partner, and nobody may
 * partner with themselves. Their own area is nonetheless the one a Single Visit almost
 * always needs, so it is added back here as an AREA only — it never becomes a selectable
 * rep, so a Double Visit on one's own area stays rep-less rather than self-assigned.
 */
export function planningAreasForRegion(
  seats: readonly PlanningSeat[],
  region: string | null | undefined,
  ownSeat?: PlanningSeat | null,
): string[] {
  const targetRegion = canonicalPlanningRegionName(region);
  if (!targetRegion) return [];

  const seen = new Set<string>();
  const areas: string[] = [];
  const add = (seat: PlanningSeat | null | undefined) => {
    const areaName = seat?.areaName;
    if (!areaName) return;
    if (canonicalPlanningRegionName(seat?.regionName) !== targetRegion) return;
    const key = areaName.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    areas.push(areaName);
  };

  add(ownSeat);
  for (const seat of seats) add(seat);
  return areas.sort((left, right) => left.localeCompare(right));
}

export type PlanningAreaSeat = {
  areaName: string;
  /** AU operational region code — the DM territory. "UE-1", "UE-2", "UE", "CA", ... */
  regionCode: string;
  /** Display name for that code, e.g. "Upper Egypt 1". Canonicalises to a planning region. */
  regionName: string | null;
};

export function normalizeRegionCode(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

export type PlanningOwner = {
  /**
   * The district the AU seat model states for this employee outright — from the seats they
   * manage, else the seat they occupy. This is the authority: the seat model is the source of
   * truth for org structure, and unlike the two fields below it is not hand-typed. Resolves for
   * 15 employees the other two miss (measured against production 2026-08-22), and disagrees
   * with neither of them anywhere.
   */
  seatRegionCode?: string | null;
  /**
   * The area on the plan owner's employee row, matched against the seat map. Second choice: it
   * is free text, so it misses composite territories ("Fayoum-Beni Suef") and manager rows that
   * carry a region word ("Cairo", "Upper Egypt") instead of an area.
   */
  areaName?: string | null;
  /** Last resort, and often null in practice. Hand-editable, and observed drifting. */
  regionCode?: string | null;
};

/**
 * Which DM district the plan owner sits in.
 *
 * Preference order, most authoritative first: the district the seat model states for them, then
 * the district their employee-row area falls in, then the hand-typed region code. Each step is
 * skipped when it yields nothing, so a blank at one level falls through instead of pinning the
 * answer to "" and silently widening the picker to the whole region.
 *
 * The area step assumes an area name maps to ONE district within a line. That holds because the
 * seat map is restricted to currently-effective rows (see loadPlanningAreaSeats), the same
 * reasoning region-resolver.ts relies on. Rather than trust it blindly, an ambiguous name — one
 * matching seats in two districts — is treated as unresolved and falls through to the region
 * code, so a mid-transition or duplicated seat row can never silently pick a district by
 * whichever row the view happened to return first.
 */
function resolveOwnDistrict(
  seats: readonly PlanningAreaSeat[],
  owner: PlanningOwner | null | undefined,
): string {
  const fromSeatModel = normalizeRegionCode(owner?.seatRegionCode);
  if (fromSeatModel) return fromSeatModel;

  const areaKey = owner?.areaName?.trim().toLowerCase();
  if (areaKey) {
    const codes = new Set(
      seats
        .filter((seat) => seat.areaName.trim().toLowerCase() === areaKey)
        .map((seat) => normalizeRegionCode(seat.regionCode))
        .filter(Boolean),
    );
    if (codes.size === 1) return [...codes][0];
  }

  return normalizeRegionCode(owner?.regionCode);
}

/**
 * The areas offered for `selectedRegion`, in display order.
 *
 * When the rep's own district sits inside the selected region they get their own district and
 * nothing else — an Upper Egypt 1 rep plans Minia 1 / Minia 2 / Beni Suef, never Assuit or
 * Qena. When they pick some other region (a trip outside their territory) the whole of that
 * region's areas for their line are offered, so the picker is never empty.
 */
export function planningAreaOptions(
  seats: readonly PlanningAreaSeat[],
  selectedRegion: string | null | undefined,
  owner: PlanningOwner | null | undefined,
): string[] {
  const targetRegion = canonicalPlanningRegionName(selectedRegion);
  if (!targetRegion) return [];

  const inRegion = seats.filter((seat) => canonicalPlanningRegionName(seat.regionName) === targetRegion);
  const ownCode = resolveOwnDistrict(seats, owner);
  const ownDistrict = ownCode
    ? inRegion.filter((seat) => normalizeRegionCode(seat.regionCode) === ownCode)
    : [];
  const source = ownDistrict.length > 0 ? ownDistrict : inRegion;

  const seen = new Set<string>();
  const areas: string[] = [];
  for (const seat of source) {
    const areaName = seat.areaName?.trim();
    if (!areaName) continue;
    const key = areaName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    areas.push(areaName);
  }
  return areas.sort((left, right) => left.localeCompare(right));
}

/**
 * Whether `area` is a seat area that sits in `region` for this line — the server-side check
 * behind the Area picker.
 *
 * Deliberately answers `true` for an area the seat map has never heard of. 48 of the 325 live
 * plan rows in production carry a legacy spelling ("Gharbia (1)", "Tanta", "Qaluibia") that no
 * longer matches a seat, and rejecting those would block real people mid-plan for a data
 * problem they cannot fix. Only a KNOWN area filed under the WRONG region is a real error, and
 * exactly one live row is in that state.
 */
export function planningAreaBelongsToRegion(
  seats: readonly PlanningAreaSeat[],
  selectedRegion: string | null | undefined,
  area: string | null | undefined,
): boolean {
  const areaKey = area?.trim().toLowerCase();
  if (!areaKey) return true;
  const targetRegion = canonicalPlanningRegionName(selectedRegion);
  if (!targetRegion) return true;

  const matches = seats.filter((seat) => seat.areaName.trim().toLowerCase() === areaKey);
  if (matches.length === 0) return true;
  return matches.some((seat) => canonicalPlanningRegionName(seat.regionName) === targetRegion);
}
