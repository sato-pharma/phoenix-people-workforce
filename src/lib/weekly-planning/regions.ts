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

/**
 * Every region spelling planning recognises.
 *
 * Upper Egypt appears three times on purpose. The organogram does not agree with itself across
 * lines — Anti Infective and Pedia each split Upper Egypt into UE-1 / UE-2 (with DIFFERENT
 * membership), CNS keeps one undivided UE — and the planning picker follows the organogram
 * (owner, 2026-09-12), so all three spellings have to be nameable. Which of them a given person
 * is actually offered is decided per line by `approvedRegionsForSeats`, never by this list.
 */
export const APPROVED_PLANNING_REGIONS = [
  "ALEX-BHR",
  "Cairo",
  "Delta 1",
  "Delta 2",
  "Delta 3",
  "Giza",
  "Upper Egypt",
  "Upper Egypt 1",
  "Upper Egypt 2",
] as const;

/**
 * The list to fall back on when the seat model could not be read at all. Deliberately the
 * pre-split seven: with no seat map there is no way to know whether this line splits Upper
 * Egypt, and offering all three spellings at once would ask the employee a question the app
 * is supposed to answer.
 */
const FALLBACK_PLANNING_REGIONS = [
  "ALEX-BHR",
  "Cairo",
  "Delta 1",
  "Delta 2",
  "Delta 3",
  "Giza",
  "Upper Egypt",
] as const satisfies readonly ApprovedPlanningRegion[];

export type ApprovedPlanningRegion = (typeof APPROVED_PLANNING_REGIONS)[number] | `Upper Egypt ${number}`;

const ALEX_BHR_SPELLINGS = ["alex-bhr", "alex bhr", "alex/bhr", "alex", "alexandria", "bhr", "beheira"];

/**
 * An Upper Egypt district as the organogram spells it: "Upper Egypt 1", "Upper Egypt 2", and
 * whatever number a future split adds. The district SURVIVES canonicalisation — it used to be
 * folded onto the bare "Upper Egypt", which is exactly what made a Pedia District Manager whose
 * own district is Upper Egypt 2 see an undivided "Upper Egypt" in his plan submitter.
 *
 * The bare spelling stays valid: CNS genuinely has one undivided Upper Egypt, and every plan
 * submitted before this change stored the bare name.
 */
const UPPER_EGYPT_DISTRICT = /^upper egypt (\d+)$/;

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
  if (normalized === "upper egypt") return "Upper Egypt";
  const district = UPPER_EGYPT_DISTRICT.exec(normalized);
  if (district) return `Upper Egypt ${Number(district[1])}`;
  return null;
}

/**
 * Whether picking `selected` in the Region box covers an area filed under `seatRegionName`.
 *
 * Exact after canonicalisation, plus ONE legacy direction: a plan submitted before the districts
 * became first-class stored the bare family name ("Upper Egypt"), and must keep reaching the
 * districts it used to fold into, or every one of those rows loses its Area list mid-edit. The
 * reverse never holds — picking "Upper Egypt 2" must never reach an Upper Egypt 1 area, which is
 * the whole point of showing the districts apart.
 */
export function planningRegionCoversSeatRegion(
  selected: string | null | undefined,
  seatRegionName: string | null | undefined,
): boolean {
  const target = canonicalPlanningRegionName(selected);
  const seat = canonicalPlanningRegionName(seatRegionName);
  if (!target || !seat) return false;
  if (target === seat) return true;
  return isDistrictOf(seat, target);
}

/** "Upper Egypt 2" is a district of "Upper Egypt"; "Delta 2" is NOT a district of "Delta". */
function isDistrictOf(candidate: string, family: string): boolean {
  if (!candidate.toLowerCase().startsWith(`${family.toLowerCase()} `)) return false;
  return /^\d+$/.test(candidate.slice(family.length + 1));
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
    if (!planningRegionCoversSeatRegion(targetRegion, seat?.regionName)) return;
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

  const inRegion = seats.filter((seat) => planningRegionCoversSeatRegion(targetRegion, seat.regionName));
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
 * Which of the approved regions a line's AU seat model actually has areas in.
 *
 * Not every line shares the same regions — Anti Infective's Delta 3 split has no CNS or Pedia
 * counterpart (verified live 2026-08-28: `au.line_area_map` carries zero `D3` rows for either
 * line), so `APPROVED_PLANNING_REGIONS` applied unfiltered to every line offers a CNS or Pedia
 * rep a "Delta 3" they can select and then get zero areas for — the same class of dead-end
 * cascading dropdown this module exists to prevent, just one level up. The region list must
 * follow the seat model exactly the way the area list already does, per line, rather than
 * naming a shared vocabulary and hoping every line's organogram happens to agree with it.
 *
 * The list is the seat model's OWN region names, not a fixed menu filtered by them: Upper Egypt
 * reaches this file as three different organogram facts — "Upper Egypt 1" / "Upper Egypt 2" on
 * Anti Infective and Pedia, plain "Upper Egypt" on CNS — and each line must be offered the one
 * its own organogram states. A region the planning vocabulary does not recognise at all is still
 * dropped, which is what keeps "Others" (Main Store, Aswan, …) out of the picker.
 *
 * Falls back to the pre-split seven when the seat model has nothing to offer at all (not loaded,
 * or a genuinely empty line) — an empty region picker is worse than an over-wide one.
 */
export function approvedRegionsForSeats(seats: readonly PlanningAreaSeat[]): ApprovedPlanningRegion[] {
  const present = new Set<ApprovedPlanningRegion>();
  for (const seat of seats) {
    const region = canonicalPlanningRegionName(seat.regionName);
    if (region) present.add(region);
  }
  if (present.size === 0) return [...FALLBACK_PLANNING_REGIONS];
  return [...present].sort(byApprovedRegionOrder);
}

/** Approved-list order, with anything the list has not been told about (a future district) last. */
function byApprovedRegionOrder(left: ApprovedPlanningRegion, right: ApprovedPlanningRegion): number {
  const rank = (region: ApprovedPlanningRegion) => {
    const index = (APPROVED_PLANNING_REGIONS as readonly string[]).indexOf(region);
    return index === -1 ? APPROVED_PLANNING_REGIONS.length : index;
  };
  return rank(left) - rank(right) || left.localeCompare(right);
}

/**
 * The single region a plan owner's own AU district sits in, spelled the way the organogram spells
 * it — "Upper Egypt 2" for a Pedia District Manager of UE-2, "Upper Egypt" for his CNS opposite
 * number whose line never split.
 *
 * Null when the seat model cannot name his district. Never guess one: a wrong hard-coded region
 * is worse than a picker, because he cannot correct it.
 */
export function ownPlanningRegionForOwner(
  seats: readonly PlanningAreaSeat[],
  owner: PlanningOwner | null | undefined,
): ApprovedPlanningRegion | null {
  const ownCode = resolveOwnDistrict(seats, owner);
  if (!ownCode) return null;
  const seat = seats.find((candidate) => normalizeRegionCode(candidate.regionCode) === ownCode);
  return canonicalPlanningRegionName(seat?.regionName ?? null);
}

/**
 * Whether a seat row is in force on `asOfDate`. Both are YYYY-MM-DD, so a plain string compare
 * is a date compare.
 *
 * A blank `effective_from` means "always in force" — most rows carry no start date at all, and
 * reading a blank as a future date would empty the picker for every line at once.
 */
export function isSeatEffectiveOn(effectiveFrom: string | null | undefined, asOfDate: string): boolean {
  const from = String(effectiveFrom ?? "").trim();
  if (!from) return true;
  return from <= asOfDate;
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
  return matches.some((seat) => planningRegionCoversSeatRegion(targetRegion, seat.regionName));
}
