import type { LineOperationalRegionMap, OperationalRegionResolver } from "@/lib/sales/closing-organogram-regions";

// ─────────────────────────────────────────────────────────────────────────────
// WHICH REGION IS "THE" REGION on the Source-of-Sales dashboard.
//
// An area's region is not one fact, it is two, and they legitimately disagree:
//
//   GEOGRAPHIC   `source_of_sales_fact_rollup.region_code` — where the area sits on the map. This
//                is the code the sales rows themselves carry, so it is the only thing the RPCs can
//                filter on, and therefore the only thing an ACCESS bound can be expressed in.
//   ORGANOGRAM   `au.line_area_map.operational_region_code` — which DM territory owned that area,
//                ON THAT LINE, IN THAT MONTH. This is the structure a manager reads a report
//                against, and the one the Monthly Closing publishes.
//
// The dashboard used to group by the geographic one while the Closing relabelled every area through
// the organogram, so the two executive surfaces published different regional splits of the same line
// and month. Measured on production for 2026-07: 23 (line, area) pairs disagree, moving 807,168 EGP
// between regions — CNS Others +335,008 and CNS Delta (1) −213,804 — with an IDENTICAL grand total,
// which is why nothing about it ever looked wrong. Neither screen recorded which rule it had used.
//
// The rule is now one rule: the organogram, for every surface. That is the owner's ruling of
// 2026-08-07 for CNS and Pedia, it is what Anti Infective's UE-1 / UE-2 split has always needed,
// and it is what `seat-area-scope.ts` already treats as authoritative when deciding which areas a
// manager owns.
//
// WHAT THIS MODULE IS FOR: keeping the two apart at the points where confusing them is silent.
// Both are strings, so nothing but care stops one being passed where the other belongs — and the
// failure mode is not an error, it is an EMPTY BOARD, which a user reads as "I sold nothing"
// rather than as a bug (AGENTS.md §4: a picker is never wider than its viewer). Every region
// decision the dashboard makes therefore goes through a named function here, and each one says in
// its name which of the two facts it is entitled to.
// ─────────────────────────────────────────────────────────────────────────────

export type RegionOption = { code: string; label: string };

/**
 * A row carrying BOTH regions. The two tests below take the whole row rather than a bare code on
 * purpose: both codes are plain strings, so a signature taking one string would happily accept the
 * other, and the resulting bug is silent — an empty board, not an error. Passing the row makes each
 * function pick its own dimension, so the call site cannot get the choice wrong at all.
 */
export type RegionBearingRow = { regionCode: string; operationalRegionCode: string };

/**
 * The ACCESS test. GEOGRAPHIC, always.
 *
 * `scopeRegionCodes` is a widener derived from the areas a manager's organogram seat owns, and it is
 * expressed in the codes the RPC push-down filters on — geography. Feeding it an organogram code
 * would compare "UE-1" against a bound built from "UE" and reject every row the viewer owns.
 *
 * It is deliberately NOT a sufficient bound on its own: it necessarily includes regions that also
 * contain a sibling manager's areas, so it is always paired with the tight `areaCodes` filter. See
 * `seat-area-scope.ts`.
 */
export function rowIsInRegionScope(scopeRegionCodes: Set<string> | null, row: RegionBearingRow): boolean {
  if (!scopeRegionCodes) return true;
  return scopeRegionCodes.has(row.regionCode.toUpperCase());
}

/**
 * The USER-FILTER test. ORGANOGRAM, always.
 *
 * A viewer picks from the regions the board SHOWS, and the board shows organogram regions — so
 * picking "Upper Egypt 1" must select the rows the board totalled under Upper Egypt 1. Matching on
 * geography here would silently return a different set of rows than the subtotal the viewer clicked.
 */
export function rowMatchesRegionFilter(regionSet: Set<string> | null, row: RegionBearingRow): boolean {
  if (!regionSet) return true;
  return regionSet.has(row.operationalRegionCode.toUpperCase());
}

/**
 * Which DM territory owned `areaCode` on `officialLine` in `period`.
 *
 * Falls back to the geographic code on every "don't know": a line outside the organogram set (Head
 * Office), an area the org chart does not cover, and an org chart that could not be read at all. A
 * missing mapping must never cost the board a row of sales — the pre-existing geographic grouping
 * is wrong-but-unchanged, which is recoverable; a dropped row is not.
 */
export function operationalRegionFor(
  resolver: OperationalRegionResolver,
  officialLine: string,
  areaCode: string,
  period: string,
  geographicRegionCode: string,
): string {
  const map = resolver.forLinePeriod(officialLine, period);
  if (!map) return geographicRegionCode;
  return map.regionByArea.get(areaCode.toUpperCase())?.regionCode ?? geographicRegionCode;
}

/**
 * The region picker: geography's codes plus every organogram code in force for `period`.
 *
 * Both halves are needed. Without the organogram half, Anti Infective's UE-1 / UE-2 subtotals appear
 * on the board with no way to filter to either of them. Without the geographic half, Head Office —
 * and any future line outside the field structure — loses the only regions it is ever grouped by.
 *
 * Resolved at the SELECTED month, never at today. A territory move dated to the 1st of next month
 * must not add its region to the month it was deliberately dated to spare (AGENTS.md §4, the
 * August / Delta (3) golden rule).
 */
export function buildRegionOptions(
  geographic: Array<{ regionCode: string; regionName: string }>,
  resolver: OperationalRegionResolver,
  officialLines: string[],
  period: string | null,
): RegionOption[] {
  const codes = new Map<string, string>();
  geographic.forEach((region) => {
    const code = region.regionCode.toUpperCase();
    if (code) codes.set(code, region.regionName || region.regionCode);
  });
  officialLines.forEach((line) => {
    resolver.forLinePeriod(line, period)?.regionCodes.forEach((code) => {
      if (!codes.has(code)) codes.set(code, resolver.regionName(code) ?? code);
    });
  });
  return [...codes.entries()]
    .map(([code, label]) => ({ code, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Widen a set of PICKED (organogram) region codes to every GEOGRAPHIC region that could contain one.
 *
 * The RPCs filter on `region_code`, which is geography. Pushing "UE-1" straight down would match no
 * row at all and the board would read as "you sold nothing" — the failure this whole module exists
 * to prevent. So the push-down is widened here and the per-row organogram test above does the tight
 * filtering, exactly the widen-then-tighten pattern `factRegionCodes` + `areaCodes` already uses.
 *
 * A picked code is always kept as itself: it is usually a geographic code too, and it is what Direct
 * rows (area "DIRECT", which the organogram never maps) and non-organogram lines are matched on.
 *
 * Widening is evaluated across EVERY month the request can fetch, because a territory move between
 * the selected month and its year-ago anchor means the two months need different geographic parents.
 * Over-widening is harmless here — it only over-fetches, and the per-row test still decides.
 */
export function widenRegionsToGeography(
  picked: string[],
  resolver: OperationalRegionResolver,
  officialLines: string[],
  periods: Array<string | null>,
  geographicRegionByArea: Map<string, string>,
): string[] {
  const wanted = new Set(picked.map((code) => code.toUpperCase()));
  const widened = new Set(wanted);
  for (const period of periods) {
    for (const line of officialLines) {
      const map: LineOperationalRegionMap | null = resolver.forLinePeriod(line, period);
      if (!map) continue;
      map.regionByArea.forEach((operational, areaCode) => {
        if (!wanted.has(operational.regionCode.toUpperCase())) return;
        const geographic = geographicRegionByArea.get(areaCode.toUpperCase());
        if (geographic) widened.add(geographic.toUpperCase());
      });
    }
  }
  return [...widened];
}

/**
 * Region match for the two panels that carry NO line dimension — Top Bricks and Top Customers.
 *
 * An area's organogram region is a fact about (line, area), so with no line there is no single right
 * answer. Matching on geography alone would drop a brick out of the panel the moment its area was
 * shown under an organogram region on the board directly above it, so the panel would contradict the
 * chart it sits under. An area therefore matches if EITHER its geographic region or any line's
 * organogram region for it was picked.
 *
 * That over-includes when two lines disagree about one area (UE1 is UE-1 on Anti Infective and UE on
 * CNS). It is inherent, not an oversight: these panels already mix every line together, which is why
 * they are shown to company-scope viewers only.
 */
export function areaMatchesRegionFilter(
  regionSet: Set<string> | null,
  resolver: OperationalRegionResolver,
  officialLines: string[],
  period: string | null,
  geographicRegionCode: string,
  areaCode: string,
): boolean {
  if (!regionSet) return true;
  if (regionSet.has(geographicRegionCode.toUpperCase())) return true;
  const area = areaCode.toUpperCase();
  return officialLines.some((line) => {
    const code = resolver.forLinePeriod(line, period)?.regionByArea.get(area)?.regionCode;
    return code !== undefined && regionSet.has(code.toUpperCase());
  });
}
