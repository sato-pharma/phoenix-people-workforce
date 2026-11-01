// ─────────────────────────────────────────────────────────────────────────────
// Two narrow exceptions to the seat tree, both from one owner ruling (2026-11-01, Pedia):
// "hide sharkia 1 and 2 we wiull potpond hiring now in them so hide from organogram and in salaes for
// sahar el galad count what should be countet to her and move the sharkia 1 and 2 to be counted in
// hany saad totales".
//
// A district a Regional Manager holds himself. Who an area counts to is its map row's district seat, so
// Sharkia counts to Hany Saad through a district seat he occupies. That seat is `sales_only` and
// is_active = false, so `au_v_org_tree` never shows it: every reader of the tree still sees him as one
// regional seat. The sales reads that must follow the money read `au_v_org_tree_sales` instead. The rows
// a seat like this carries are money he really holds, so they stay in his totals and in the closing's
// region table; what they are NOT is a district manager's result, so a ranking leaves them out.
//
// Rep seats held off the organogram. The seat stays: it keeps its map row, its target and its place in
// recruitment and Phoenix CRM, none of which he asked to change. Only the chart stops drawing it.
// ─────────────────────────────────────────────────────────────────────────────

const REGIONAL_MANAGER_HELD_DISTRICTS: ReadonlySet<string> = new Set(["SEAT-PED-DM-SH"]);

/** True for a district seat a Regional Manager holds himself. Its rows are his, never a DM's result. */
export function isRegionalManagerHeldDistrict(seatId: string | null | undefined): boolean {
  return REGIONAL_MANAGER_HELD_DISTRICTS.has(String(seatId ?? "").trim());
}

/**
 * Areas a district still answers for in the months before they left it. A manager's area bound is read
 * from the CURRENT map, so without this Sahar El Gallad's July to September, her semester figure among
 * them, would lose Sharkia against his ruling that those months stay as published. Named by seat rather
 * than read from every closed map row because earlier moves have always read this way, and changing that
 * would restate other managers' figures, which nobody asked for.
 */
const AREAS_KEPT_FOR_EARLIER_MONTHS: ReadonlyArray<{ dmSeatId: string; areaCodes: readonly string[]; beforeMonth: string }> = [
  { dmSeatId: "SEAT-PED-DM-D2", areaCodes: ["D24", "D25"], beforeMonth: "2026-10" },
];

/** Area code -> the first month it no longer counts, for the areas these district seats keep. */
export function areasKeptForEarlierMonths(dmSeatIds: Iterable<string>): Map<string, string> {
  const wanted = new Set(dmSeatIds);
  const kept = new Map<string, string>();
  for (const entry of AREAS_KEPT_FOR_EARLIER_MONTHS) {
    if (!wanted.has(entry.dmSeatId)) continue;
    for (const areaCode of entry.areaCodes) kept.set(areaCode, entry.beforeMonth);
  }
  return kept;
}

/** Is this area inside the bound for this month (`YYYY-MM`)? `areaCode` is already upper-cased. */
export function areaInBoundForMonth(
  areaCode: string,
  period: string | null | undefined,
  areaCodes: ReadonlySet<string>,
  earlierMonthAreas: ReadonlyMap<string, string> | null | undefined,
): boolean {
  if (areaCodes.has(areaCode)) return true;
  const beforeMonth = earlierMonthAreas?.get(areaCode);
  return Boolean(beforeMonth && period && period < beforeMonth);
}

/** The bound as it stood in one month, for a reader that filters a single month by a set of codes. */
export function areaCodesForMonth(
  areaCodes: Set<string> | null,
  earlierMonthAreas: ReadonlyMap<string, string> | null | undefined,
  period: string | null | undefined,
): Set<string> | null {
  if (!areaCodes || !earlierMonthAreas || earlierMonthAreas.size === 0 || !period) return areaCodes;
  const widened = new Set(areaCodes);
  for (const [areaCode, beforeMonth] of earlierMonthAreas) if (period < beforeMonth) widened.add(areaCode);
  return widened;
}

/** Rep seats whose hiring is postponed, with the first month the chart stops drawing them. */
const REP_SEATS_HELD_OFF_THE_ORGANOGRAM: ReadonlyMap<string, string> = new Map([
  ["SEAT-PED-REP-D24", "2026-10"],
  ["SEAT-PED-REP-D25", "2026-10"],
]);

/**
 * Is this rep seat off the organogram? `asOfMonth` (`YYYY-MM`) is a past picture of the chart, which
 * still draws the seat for a month before the hold; null is the live chart.
 */
export function isRepSeatHeldOffOrganogram(seatId: string | null | undefined, asOfMonth?: string | null): boolean {
  const heldFrom = REP_SEATS_HELD_OFF_THE_ORGANOGRAM.get(String(seatId ?? "").trim());
  if (!heldFrom) return false;
  return !asOfMonth || asOfMonth >= heldFrom;
}
