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
  ownRegionCode: string | null | undefined,
): string[] {
  const targetRegion = canonicalPlanningRegionName(selectedRegion);
  if (!targetRegion) return [];

  const inRegion = seats.filter((seat) => canonicalPlanningRegionName(seat.regionName) === targetRegion);
  const ownCode = normalizeRegionCode(ownRegionCode);
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
