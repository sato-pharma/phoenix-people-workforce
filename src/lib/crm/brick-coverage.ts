/**
 * Brick Coverage — "is each rep actually visiting the bricks that carry his sales?"
 *
 * Two halves of Phoenix have never been joined. A rep's SALES are counted by brick
 * (`source_of_sales_fact_rollup`, 99.4% of rows carry a `brick_id`); a rep's VISITS are tagged
 * only with the CRM vendor's own locality id (`ireports360_visits.crm_region_id`). The translation
 * table between the two — `ireports360_crm_region_brick_resolutions` — shipped with an admin UI and
 * was EMPTY in production (0 of 302 regions, checked 2026-08-21), so no visit could be placed on the
 * brick map by its own geography.
 *
 * PARTLY FILLED SINCE — re-measured 2026-09-03 it holds 105 resolutions, covering 105 of the 307
 * regions on visits (34%). That does NOT make this board redundant, and it has deliberately NOT been
 * rewritten to use them: scoring a rep from a third of his territory would understate coverage
 * exactly where the mapping is thinnest, which is the unfair-zero trap rule 2 below exists to
 * prevent. The check-in route stays the measure until region coverage can stand on its own.
 *
 * This board is the interim answer, built on the one CRM record that does carry real coordinates:
 * the GPS CHECK-IN. Each check-in is snapped to the nearest brick centroid through the existing
 * resolver in crm/brick-geo.ts (never a second copy of that maths), and a brick counts as covered
 * when the rep put at least one check-in inside it during the month.
 *
 * ── The two rules that keep this board honest ──────────────────────────────────────────────────
 *
 * 1. WEIGHT BY SALES, NOT BY BRICK COUNT. A territory contains many bricks that sell nothing;
 *    counting them makes a diligent rep look negligent. Measured on July 2026 the same 61 reps
 *    score 59% by brick count and 75% by units — the second is the number that means something,
 *    so it is the headline and the first is shown beside it as context. Bricks with zero sales in
 *    the month are excluded from the denominator entirely.
 *
 * 2. NEVER SCORE A REP WHOSE CHECK-IN FEED IS MISSING. `ireports360_checkins` is a PARTIAL feed:
 *    in July 2026 four reps logged 378, 248, 131 and 119 visits with ZERO check-ins, so a naive
 *    board would have shown the busiest people in the company at 0% coverage and the number would
 *    have read as a finding rather than a bug. Reps with no check-in in the month are pulled OUT of
 *    every total and listed separately as "not measurable this month". This is live HR data about
 *    real people — an unfair zero here is worse than a missing row.
 *
 * Accordingly nothing in here is a verdict. The board labels itself as GPS-derived throughout, and
 * `brickMatchConfidence` distances are kept so a wrong-looking row can be argued with. Once the 302
 * region→brick mappings are filled the visit path replaces this one and GPS becomes the cross-check.
 */

import { unstable_cache } from "next/cache";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { loadBrickCentroids, resolveBrickForPoint } from "@/lib/crm/brick-geo";
import { queryCheckins } from "@/lib/crm/reads";
import { cairoTodayIso } from "@/lib/crm/dates";
import { canonicalHrIdKey } from "@/lib/hr-id";
import type { DoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";

const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * A check-in this far from every brick centre is not evidence of being in that brick — it is the
 * nearest centroid to somewhere Phoenix has no brick for (desert road, new development), or a
 * mis-geocoded centroid. Matches the "Weak" band in brick-geo.ts, which is where that module stops
 * presenting a match as fact.
 */
const MAX_SNAP_KM = 10;

/** One rep's month. `hasGpsFeed === false` means every number below it is meaningless — see rule 2. */
export type BrickCoverageRepRow = {
  agentHrId: string;
  areaNames: string;
  /** Bricks in his territory that SOLD this month and that he checked into. */
  bricksCovered: number;
  /** Bricks in his territory that SOLD this month. The honest denominator. */
  bricksWithSales: number;
  brickCoveragePct: number;
  checkins: number;
  hasGpsFeed: boolean;
  line: string;
  /** Bricks he checked into that carry none of his sales — spill, not necessarily waste. */
  offTerritoryBricks: number;
  repKey: string;
  repName: string;
  /** THE headline: share of his selling units that sit in bricks he actually stood in. */
  salesCoveragePct: number;
  unitsCovered: number;
  unitsInTerritory: number;
};

/** One brick that sold for a rep who never checked into it, biggest first. */
export type BrickCoverageBlindSpot = {
  areaName: string;
  brickName: string;
  line: string;
  pctOfRepSales: number;
  repKey: string;
  repName: string;
  units: number;
};

/** A rep the board deliberately refuses to score. */
export type BrickCoverageUnmeasured = {
  areaNames: string;
  line: string;
  repKey: string;
  repName: string;
  /** Why we cannot score them — always "no check-in recorded in this month" today. */
  reason: string;
};

export type BrickCoverageBoard = {
  blindSpots: BrickCoverageBlindSpot[];
  isCurrentMonth: boolean;
  month: string;
  monthLabel: string;
  repRows: BrickCoverageRepRow[];
  scopeLabel: string;
  totals: {
    bricksCovered: number;
    bricksWithSales: number;
    brickCoveragePct: number;
    measuredReps: number;
    salesCoveragePct: number;
    unitsCovered: number;
    unitsInTerritory: number;
    unmeasuredReps: number;
  };
  unmeasured: BrickCoverageUnmeasured[];
};

/** Valid `?month=` or this Cairo month. Mirrors resolveCoverageMonth in sfe-doctor-coverage.ts. */
export function resolveBrickCoverageMonth(month: string | undefined): string {
  if (month && MONTH_KEY_PATTERN.test(month)) return month;
  return cairoTodayIso().slice(0, 7);
}

/**
 * Line identity is compared on a FOLDED key, never on the raw string. The seat model writes
 * `anti_infective` and the sales fact writes `Anti Infective` for the same line; matching those
 * literally silently produces an empty territory, which on this board renders as a rep with no
 * sales rather than as an error.
 */
function lineKey(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

function monthBounds(month: string): { from: string; to: string } {
  const [year, mon] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

function monthLabelOf(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  const name = new Date(Date.UTC(year, mon - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return `${name} ${year}`;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** One rep seat's territory: which areas carry his target, on which line. */
type RepTerritory = {
  areaCodes: string[];
  areaNames: string[];
  hrId: string;
  line: string;
  repKey: string;
  repName: string;
};

/**
 * REP seats joined to the areas that carry their target.
 *
 * Both reads go through PUBLIC VIEWS (`au_v_employee_seat_drift`, `au_v_line_area_map`) rather than
 * the `au` schema they wrap, because PostgREST only exposes `public` — querying `au.line_area_map`
 * directly returns a schema error, not rows. `carries_target` is the whole point of the join: an
 * area a rep merely operates in but does not carry the number for is not something he can be judged
 * on. `effective_to is null` keeps this to today's org, which matches the owner's standing rule that
 * geography is always read as-is-today.
 */
const loadRepTerritoriesCached = unstable_cache(
  async (): Promise<RepTerritory[]> => {
    const supabase = getSupabaseAdmin();
    const [seatsRes, mapRes] = await Promise.all([
      supabase.from("au_v_employee_seat_drift").select("hr_id, full_name, seat_id, seat_tier"),
      supabase
        .from("au_v_line_area_map")
        .select("line_code, area_code, area_name, rep_seat_id, carries_target, effective_to")
        .is("effective_to", null)
        .eq("carries_target", true),
    ]);
    if (seatsRes.error) throw new Error(seatsRes.error.message);
    if (mapRes.error) throw new Error(mapRes.error.message);

    const areasBySeat = new Map<string, Array<{ areaCode: string; areaName: string; lineCode: string }>>();
    for (const row of (mapRes.data ?? []) as Array<{
      area_code: string | null;
      area_name: string | null;
      line_code: string | null;
      rep_seat_id: string | null;
    }>) {
      if (!row.rep_seat_id || !row.area_code) continue;
      const list = areasBySeat.get(row.rep_seat_id) ?? [];
      list.push({ areaCode: row.area_code, areaName: row.area_name ?? row.area_code, lineCode: row.line_code ?? "" });
      areasBySeat.set(row.rep_seat_id, list);
    }

    const territories: RepTerritory[] = [];
    for (const seat of (seatsRes.data ?? []) as Array<{
      full_name: string | null;
      hr_id: string | null;
      seat_id: string | null;
      seat_tier: string | null;
    }>) {
      if (seat.seat_tier !== "REP" || !seat.hr_id || !seat.seat_id) continue;
      const areas = areasBySeat.get(seat.seat_id);
      if (!areas || areas.length === 0) continue;
      territories.push({
        areaCodes: areas.map((a) => a.areaCode),
        areaNames: Array.from(new Set(areas.map((a) => a.areaName))),
        hrId: seat.hr_id,
        line: areas[0].lineCode,
        repKey: canonicalHrIdKey(seat.hr_id) ?? seat.hr_id,
        repName: seat.full_name?.trim() || seat.hr_id,
      });
    }
    return territories;
  },
  ["crm-brick-coverage-territories"],
  { revalidate: 300, tags: ["sos-reference"] },
);

/** Units sold per (brick, area, line) in one month. */
type SalesCell = { areaCode: string; brickId: string; lineFolded: string; units: number };

/**
 * One month of the Source-of-Sales fact, aggregated to (brick, area, line).
 *
 * `effective_units` is the measure, NOT `direct_value`: value is populated on direct orders only
 * (43 of 31,934 July 2026 rows), so weighting by it would score the whole field force on a handful
 * of direct deals. The board therefore says "units" everywhere and never implies money.
 *
 * `sales_ops_rollup_by_brick` looks like the natural source for this and is EMPTY in production —
 * do not switch to it without checking it has rows.
 */
async function loadMonthSales(month: string): Promise<SalesCell[]> {
  const supabase = getSupabaseAdmin();
  const rows = await fetchAllRows<{
    area_code: string | null;
    brick_id: string | null;
    effective_units: number | string | null;
    official_line: string | null;
  }>(
    () =>
      supabase
        .from("source_of_sales_fact_rollup")
        .select("id, brick_id, area_code, official_line, effective_units")
        .eq("period", month)
        .not("brick_id", "is", null),
    // Tiebreak on the PRIMARY KEY, never on `brick_id`. This month is ~32k rows = 32 offset pages,
    // and `brick_id` is nowhere near unique — one brick carries up to 520 rows in July 2026. Paging
    // an offset walk on a column with 520 ties silently duplicates and drops rows across page
    // boundaries (the failure paginated.ts's own header documents, which cost #1446 1,262 of 49,713
    // rows). Caught here by the board reporting 82,624 units against a SQL ground truth of 81,494.
    "id",
  );

  const byCell = new Map<string, SalesCell>();
  for (const row of rows) {
    if (!row.brick_id || !row.area_code) continue;
    const lineFolded = lineKey(row.official_line);
    // "Head Office" is the Office bucket, not a field line — no rep carries it, so including it
    // would inflate every denominator with units nobody is expected to visit.
    if (!lineFolded || lineFolded === "headoffice") continue;
    const units = Number(row.effective_units ?? 0);
    if (!Number.isFinite(units) || units === 0) continue;
    const key = `${row.brick_id}|${row.area_code}|${lineFolded}`;
    const cell = byCell.get(key);
    if (cell) cell.units += units;
    else byCell.set(key, { areaCode: row.area_code, brickId: row.brick_id, lineFolded, units });
  }
  return Array.from(byCell.values());
}

/**
 * Which bricks each rep physically stood in during the month, from GPS check-ins.
 *
 * Coordinates are rounded to 3 decimals (~110m) and de-duplicated BEFORE the nearest-centroid
 * search: a rep checks into the same clinic repeatedly, so this turns tens of thousands of
 * distance searches into a few thousand with no effect on the answer at brick resolution.
 */
async function loadVisitedBricks(
  month: string,
  agentHrIds: readonly string[] | null,
): Promise<{ byRep: Map<string, Map<string, number>>; checkinsByRep: Map<string, number> }> {
  const { from, to } = monthBounds(month);
  const [centroids, checkins] = await Promise.all([
    loadBrickCentroids(),
    queryCheckins<{ agent_hr_id: string | null; lat: number | null; lon: number | null }>({
      columns: "agent_hr_id, lat, lon",
      dateFrom: from,
      dateTo: to,
      // GPS brick coverage is an admin-shell board (Super Admin, CEO, SFE Manager) — no rep reaches it, so
      // a started Phoenix CRM team's visits count as its check-ins here (owner, 2026-10-02;
      // src/lib/crm/phoenix-team-starts.ts lists every reader that asks).
      includePhoenixVisits: true,
      // A display board: the company-wide month may come from the shared copy up to a minute old
      // (crm/reads.ts, "A dashboard may reuse a company window"). A scope of named reps reads live.
      reuseRecentWindow: true,
      ...(agentHrIds ? { agentHrIds } : {}),
    }),
  ]);

  const byRep = new Map<string, Map<string, number>>();
  const checkinsByRep = new Map<string, number>();
  if (centroids.length === 0) return { byRep, checkinsByRep };

  const snapCache = new Map<string, string | null>();
  for (const row of checkins) {
    const repKey = canonicalHrIdKey(row.agent_hr_id ?? "");
    if (!repKey) continue;
    checkinsByRep.set(repKey, (checkinsByRep.get(repKey) ?? 0) + 1);
    if (row.lat == null || row.lon == null) continue;

    const cacheKey = `${row.lat.toFixed(3)},${row.lon.toFixed(3)}`;
    let brickId = snapCache.get(cacheKey);
    if (brickId === undefined) {
      const match = resolveBrickForPoint(row.lat, row.lon, centroids);
      brickId = match && match.distanceKm <= MAX_SNAP_KM ? match.brickId : null;
      snapCache.set(cacheKey, brickId);
    }
    if (!brickId) continue;

    const bricks = byRep.get(repKey) ?? new Map<string, number>();
    bricks.set(brickId, (bricks.get(brickId) ?? 0) + 1);
    byRep.set(repKey, bricks);
  }
  return { byRep, checkinsByRep };
}

/**
 * PURE CORE — fixture-testable, no IO. Everything above this point fetches; everything below
 * decides. Split the same way as resolveDoctorCoverageScope in crm/doctor-coverage-scope.ts, and
 * for the same reason: the two rules in this file's header are business rules about how people are
 * judged, and a rule nobody can write a fixture for is a rule nobody can prove still holds.
 */
export function computeBrickCoverage(input: {
  brickNames: ReadonlyMap<string, { areaName: string; brickName: string }>;
  checkinsByRep: ReadonlyMap<string, number>;
  month: string;
  sales: readonly SalesCell[];
  scopeLabel: string;
  territories: readonly RepTerritory[];
  /** rep key → brick id → check-ins landed in that brick. */
  visitedByRep: ReadonlyMap<string, ReadonlyMap<string, number>>;
}): BrickCoverageBoard {
  const { brickNames: brickNameById, checkinsByRep, month, sales, scopeLabel, territories: inScope, visitedByRep } = input;

  // Sales indexed by (areaCode, foldedLine) — the grain a rep's territory selects on.
  const salesByAreaLine = new Map<string, SalesCell[]>();
  for (const cell of sales) {
    const key = `${cell.areaCode}|${cell.lineFolded}`;
    const list = salesByAreaLine.get(key) ?? [];
    list.push(cell);
    salesByAreaLine.set(key, list);
  }

  const repRows: BrickCoverageRepRow[] = [];
  const unmeasured: BrickCoverageUnmeasured[] = [];
  const blindSpots: BrickCoverageBlindSpot[] = [];

  for (const territory of inScope) {
    const visitedBricks = visitedByRep.get(territory.repKey) ?? new Map<string, number>();
    const checkins = checkinsByRep.get(territory.repKey) ?? 0;

    // Rule 2: no feed, no score. Listed, never zeroed.
    if (checkins === 0) {
      unmeasured.push({
        areaNames: territory.areaNames.join(", "),
        line: territory.line,
        reason: "No GPS check-in recorded in this month",
        repKey: territory.repKey,
        repName: territory.repName,
      });
      continue;
    }

    const lineFolded = lineKey(territory.line);
    const cells: SalesCell[] = [];
    for (const areaCode of territory.areaCodes) {
      cells.push(...(salesByAreaLine.get(`${areaCode}|${lineFolded}`) ?? []));
    }

    // Collapse to one row per brick: a brick can appear once per area/line pair a rep holds.
    const unitsByBrick = new Map<string, number>();
    for (const cell of cells) unitsByBrick.set(cell.brickId, (unitsByBrick.get(cell.brickId) ?? 0) + cell.units);

    let unitsInTerritory = 0;
    let unitsCovered = 0;
    let bricksCovered = 0;
    for (const [brickId, units] of unitsByBrick) {
      unitsInTerritory += units;
      if (visitedBricks.has(brickId)) {
        unitsCovered += units;
        bricksCovered += 1;
      }
    }

    for (const [brickId, units] of unitsByBrick) {
      if (visitedBricks.has(brickId) || units <= 0) continue;
      const named = brickNameById.get(brickId);
      blindSpots.push({
        areaName: named?.areaName ?? "",
        brickName: named?.brickName ?? brickId,
        line: territory.line,
        pctOfRepSales: pct(units, unitsInTerritory),
        repKey: territory.repKey,
        repName: territory.repName,
        units: Math.round(units),
      });
    }

    let offTerritoryBricks = 0;
    for (const brickId of visitedBricks.keys()) if (!unitsByBrick.has(brickId)) offTerritoryBricks += 1;

    repRows.push({
      agentHrId: territory.hrId,
      areaNames: territory.areaNames.join(", "),
      bricksCovered,
      bricksWithSales: unitsByBrick.size,
      brickCoveragePct: pct(bricksCovered, unitsByBrick.size),
      checkins,
      hasGpsFeed: true,
      line: territory.line,
      offTerritoryBricks,
      repKey: territory.repKey,
      repName: territory.repName,
      salesCoveragePct: pct(unitsCovered, unitsInTerritory),
      unitsCovered: Math.round(unitsCovered),
      unitsInTerritory: Math.round(unitsInTerritory),
    });
  }

  const totalUnits = repRows.reduce((sum, row) => sum + row.unitsInTerritory, 0);
  const totalCovered = repRows.reduce((sum, row) => sum + row.unitsCovered, 0);
  const totalBricks = repRows.reduce((sum, row) => sum + row.bricksWithSales, 0);
  const totalBricksCovered = repRows.reduce((sum, row) => sum + row.bricksCovered, 0);

  repRows.sort((a, b) => a.salesCoveragePct - b.salesCoveragePct || b.unitsInTerritory - a.unitsInTerritory);
  blindSpots.sort((a, b) => b.units - a.units);
  unmeasured.sort((a, b) => a.repName.localeCompare(b.repName));

  return {
    blindSpots: blindSpots.slice(0, 100),
    isCurrentMonth: month === cairoTodayIso().slice(0, 7),
    month,
    monthLabel: monthLabelOf(month),
    repRows,
    scopeLabel,
    totals: {
      bricksCovered: totalBricksCovered,
      bricksWithSales: totalBricks,
      brickCoveragePct: pct(totalBricksCovered, totalBricks),
      measuredReps: repRows.length,
      salesCoveragePct: pct(totalCovered, totalUnits),
      unitsCovered: totalCovered,
      unitsInTerritory: totalUnits,
      unmeasuredReps: unmeasured.length,
    },
    unmeasured,
  };
}

/**
 * IO wrapper: resolve everything the pure core needs, then run it.
 *
 * `scope` is the SAME resolver the Doctor Coverage board uses (crm/doctor-coverage-scope.ts) so
 * the two boards can never disagree about who may see whose reps — this module adds no new security
 * surface of its own. A `none` scope never reaches here because the page redirects first; it is
 * still handled defensively rather than widened, matching that module's "every failure path returns
 * NO access" rule.
 */
export async function getBrickCoverage({
  month,
  scope,
  territoryRepKeys,
}: {
  month: string;
  scope: DoctorCoverageScope;
  /**
   * Region → Line → Area → Rep filter, already resolved to THIS module's rep-key convention
   * (`canonicalHrIdKey`, no `hr:` prefix — see `loadRepTerritories`). Absent/null = no territory
   * filter. An EMPTY array keeps nobody, never everybody: it means the chosen territory resolved to
   * no seated rep, and widening back to the whole company there would silently contradict the
   * filter the viewer can see on screen.
   *
   * Applied on top of the access scope, so it can only ever narrow what the viewer may already see.
   */
  territoryRepKeys?: string[] | null;
}): Promise<BrickCoverageBoard> {
  if (scope.kind === "none") {
    return computeBrickCoverage({
      brickNames: new Map(),
      checkinsByRep: new Map(),
      month,
      sales: [],
      scopeLabel: "",
      territories: [],
      visitedByRep: new Map(),
    });
  }

  const agentHrIds = scope.kind === "agents" ? scope.agentHrIds : null;
  const allowed = agentHrIds ? new Set(agentHrIds.map((id) => canonicalHrIdKey(id) ?? "").filter(Boolean)) : null;
  const territory = territoryRepKeys ? new Set(territoryRepKeys) : null;

  const [territories, sales, visited, centroids] = await Promise.all([
    loadRepTerritoriesCached(),
    loadMonthSales(month),
    loadVisitedBricks(month, agentHrIds),
    loadBrickCentroids(),
  ]);

  const brickNames = new Map<string, { areaName: string; brickName: string }>();
  for (const centroid of centroids) {
    brickNames.set(centroid.brickId, {
      areaName: centroid.areaName ?? centroid.areaCode ?? "",
      brickName: centroid.brickName ?? centroid.brickId,
    });
  }

  return computeBrickCoverage({
    brickNames,
    checkinsByRep: visited.checkinsByRep,
    month,
    sales,
    scopeLabel: scope.label,
    territories: territories.filter(
      (row) => (!allowed || allowed.has(row.repKey)) && (!territory || territory.has(row.repKey)),
    ),
    visitedByRep: visited.byRep,
  });
}
