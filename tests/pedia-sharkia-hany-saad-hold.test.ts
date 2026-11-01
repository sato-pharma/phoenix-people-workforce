import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { districtManagerCount } from "../src/lib/employee-portal/sos-team-performance.ts";
import { foldRepEstablishment } from "../src/lib/employee-portal/rep-establishment.ts";
import { areaCodesForMonth, isRegionalManagerHeldDistrict, isRepSeatHeldOffOrganogram } from "../src/lib/org/sales-only-seats.ts";
import { buildSeatTreeRows, type AuTreeRow } from "../src/lib/reports/organogram-au-source.ts";
import { PERFORMANCE_REVIEW_REGIONS } from "../src/lib/sales/closing-performance-review-regions.ts";
import { MONTHLY_CLOSING_REGION_ORDER } from "../src/lib/sales/monthly-distributor-import.ts";
import { regionName, type AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import { computeSalesAccessScope } from "../src/lib/sales/access-scope.ts";
import { assertTargetsAreaInBound, filterAchievementForScope, targetsBoundFromSalesScope } from "../src/lib/sales/portal-targets.ts";
import { buildRankingBoards, type RankingPerson } from "../src/lib/sales/rankings.ts";
import { computeSeatAreaScope } from "../src/lib/sales/seat-area-scope.ts";
import { filterRowsForBound, vsTargetBoundFromSalesScope } from "../src/lib/sales/vs-target-scope.ts";
import { districtRegionCodesHeldBy, indexSalesSeats } from "../src/lib/sales/seat-hierarchy.ts";
import { facetsFrom } from "../src/lib/spotlight/org.ts";
import { hrKey } from "../src/lib/spotlight/rank.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * Owner, 2026-11-01, Pedia only: "in pedia organogram hide sharkia 1 and 2 we wiull potpond hiring now in
 * them so hide from organogram and in salaes for sahar el galad count what should be countet to her and
 * move the sharkia 1 and 2 to be counted in hany saad totales". Start month, his choice: October 2026.
 *
 * Who an area counts to is its map row's district seat, so Sharkia counts to Hany Saad through a district
 * seat he occupies himself. Five things go wrong silently, and each is pinned below:
 *
 *  1. THE CHART COULD DRAW THE SEATS. The live chart must lose both rep seats and must never draw Hany a
 *     second time; a past picture before October must still draw Sharkia as it stood.
 *  2. "OUT OF N" COULD STAY TWO TOO HIGH. The establishment is the chart's rep seats.
 *  3. HANY COULD STAND ON A DISTRICT MANAGER BOARD. The money is his, the title is not.
 *  4. HIS TOTALS COULD MISS THE REGION. A Regional Manager's regions are read off people's labels, and
 *     nobody under this seat carries one.
 *  5. A PUBLISHED MONTH COULD MOVE. The map move is a dated pair, never an edit of the old row.
 */

const HANY = "PD-0001";
const SAHAR = "PD-0028";
const HELD_DISTRICT = "SEAT-PED-DM-SH";

function seat(partial: Partial<AuTreeRow> & Pick<AuTreeRow, "seat_id" | "seat_tier">): AuTreeRow {
  return {
    parent_seat_id: null,
    line_code: "pedia",
    region_code: null,
    area_code: null,
    is_other_pseudo_dm: false,
    occupant_hr_id: null,
    is_vacant: !partial.occupant_hr_id,
    area_name: null,
    region_name: null,
    line_name: "Pedia",
    line_id: 2,
    ...partial,
  };
}

const TREE: AuTreeRow[] = [
  seat({ seat_id: "SEAT-PED-RSM", seat_tier: "RSM", occupant_hr_id: HANY }),
  seat({ seat_id: "SEAT-PED-DM-D2", seat_tier: "DM", parent_seat_id: "SEAT-PED-RSM", occupant_hr_id: SAHAR, region_code: "D2" }),
  seat({ seat_id: HELD_DISTRICT, seat_tier: "DM", parent_seat_id: "SEAT-PED-RSM", occupant_hr_id: HANY, region_code: "SH" }),
  seat({ seat_id: "SEAT-PED-REP-D21", seat_tier: "REP", parent_seat_id: "SEAT-PED-DM-D2", occupant_hr_id: "PD-0100", area_code: "D21" }),
  seat({ seat_id: "SEAT-PED-REP-D24", seat_tier: "REP", parent_seat_id: "SEAT-PED-DM-D2", area_code: "D24" }),
  seat({ seat_id: "SEAT-PED-REP-D25", seat_tier: "REP", parent_seat_id: "SEAT-PED-DM-D2", area_code: "D25" }),
];

function chartSeats(asOfMonth: string | null): string[] {
  const { rows } = buildSeatTreeRows(TREE, {
    asOfMonth,
    displayNameFor: (hrId) => hrId ?? "Open Vacancy",
    hireDateFor: () => null,
    offerOutBySeat: new Map(),
    workFieldsFor: () => ({}) as ReturnType<Parameters<typeof buildSeatTreeRows>[1]["workFieldsFor"]>,
  });
  return rows.map((row) => String((row as { seatId?: unknown }).seatId));
}

function achievement(partial: { dmSeatId: string; dmHrId: string; areaCode: string; actualValue: number; targetValue: number }): AchievementRow {
  return {
    period: "2026-10",
    lineCode: "pedia",
    regionCode: partial.dmSeatId === HELD_DISTRICT ? "SH" : "D2",
    areaCode: partial.areaCode,
    areaState: "vacant_will_hire",
    isOther: false,
    repSeatId: `SEAT-PED-REP-${partial.areaCode}`,
    repHrId: null,
    dmSeatId: partial.dmSeatId,
    dmHrId: partial.dmHrId,
    productCode: "GU001",
    actualUnits: 1,
    actualValue: partial.actualValue,
    targetUnits: 1,
    targetValue: partial.targetValue,
    achievementValue: partial.actualValue / partial.targetValue,
    achievementUnits: null,
    hasTarget: true,
    hasActual: partial.actualValue > 0,
  };
}

const OCTOBER_ROWS: AchievementRow[] = [
  achievement({ dmSeatId: "SEAT-PED-DM-D2", dmHrId: SAHAR, areaCode: "D21", actualValue: 500, targetValue: 1000 }),
  achievement({ dmSeatId: HELD_DISTRICT, dmHrId: HANY, areaCode: "D24", actualValue: 900, targetValue: 1000 }),
];

function person(hrId: string, name: string): RankingPerson {
  return {
    hrId,
    name,
    title: "District Manager",
    lineName: "Pedia",
    regionName: "Delta",
    areaName: "",
    managerName: "Manager",
    hasPhoto: false,
  };
}

export function runPediaSharkiaHanySaadHoldTests() {
  // ── 1. The chart ──────────────────────────────────────────────────────────────────────────────
  const live = chartSeats(null);
  assert.ok(!live.includes("SEAT-PED-REP-D24"), "Sharkia 1 is off the live chart: its hiring is postponed");
  assert.ok(!live.includes("SEAT-PED-REP-D25"), "Sharkia 2 is off the live chart: its hiring is postponed");
  assert.ok(!live.includes(HELD_DISTRICT), "the sales-only seat would draw Hany Saad a second time");
  assert.ok(live.includes("SEAT-PED-REP-D21"), "Sahar El Gallad's other areas stay on the chart");
  assert.ok(live.includes("SEAT-PED-DM-D2"), "Sahar El Gallad stays on the chart");
  assert.ok(live.includes("SEAT-PED-RSM"), "Hany Saad stays on the chart, once, as the Regional Sales Manager");

  const september = chartSeats("2026-09");
  assert.ok(september.includes("SEAT-PED-REP-D24"), "a past picture before October still draws Sharkia 1 as it stood");
  assert.ok(september.includes("SEAT-PED-REP-D25"), "a past picture before October still draws Sharkia 2 as it stood");
  const october = chartSeats("2026-10");
  assert.ok(!october.includes("SEAT-PED-REP-D24"), "October is the first month the chart stops drawing the seat");

  assert.equal(isRepSeatHeldOffOrganogram("SEAT-CNS-REP-D24"), false, "Pedia only: CNS keeps its own Sharkia seat");
  assert.equal(isRepSeatHeldOffOrganogram(null), false);
  assert.equal(isRegionalManagerHeldDistrict("SEAT-PED-DM-D2"), false, "an ordinary district is still a district");
  assert.equal(isRegionalManagerHeldDistrict(undefined), false);

  // ── 2. The establishment ──────────────────────────────────────────────────────────────────────
  const establishment = foldRepEstablishment([
    { seat_id: "SEAT-PED-REP-D21", seat_tier: "REP", line_code: "pedia", is_vacant: false },
    { seat_id: "SEAT-PED-REP-D24", seat_tier: "REP", line_code: "pedia", is_vacant: true },
    { seat_id: "SEAT-PED-REP-D25", seat_tier: "REP", line_code: "pedia", is_vacant: true },
    { seat_id: "SEAT-CNS-REP-D24", seat_tier: "REP", line_code: "cns", is_vacant: true },
  ]);
  assert.deepEqual(establishment.byLine.get("pedia"), { seats: 1, vacant: 0 }, "a seat off the chart is not one of its rep seats");
  assert.deepEqual(establishment.byLine.get("cns"), { seats: 1, vacant: 1 }, "another line's Sharkia still counts");
  assert.deepEqual(establishment.company, { seats: 2, vacant: 1 });

  // ── 3. A ranking and a head count ─────────────────────────────────────────────────────────────
  const boards = buildRankingBoards({
    rows: OCTOBER_ROWS,
    priorRows: OCTOBER_ROWS,
    publishedKeys: new Set(["pedia|2026-10"]),
    periods: ["2026-10"],
    priorPeriods: [],
    people: new Map([
      ["PD0001", person(HANY, "Hany Saad")],
      ["PD0028", person(SAHAR, "Sahar El Gallad")],
    ]),
    activeKeys: null,
    establishment: null,
    filters: { lines: [], titles: [], regions: [], query: "" },
  });
  assert.deepEqual(
    boards.districtManagers.map((entry) => entry.name),
    ["Sahar El Gallad"],
    "the seat's money is Hany Saad's, but he does not stand on the District Managers board",
  );

  assert.equal(
    districtManagerCount([{ hrId: SAHAR }, { hrId: HANY }], OCTOBER_ROWS),
    1,
    "his row foots the money to the header; it is not one more district manager on the count above it",
  );
  assert.equal(
    districtManagerCount([{ hrId: SAHAR }, { hrId: "PD-0030" }], OCTOBER_ROWS),
    2,
    "a list with nobody holding a district himself is counted as it stands",
  );

  const facets = facetsFrom({
    seats: new Map([
      ["SEAT-PED-RSM", { seatId: "SEAT-PED-RSM", tier: "RSM", occupantHrId: HANY, regionCode: null, areaCode: null, lineCode: "pedia" }],
      [HELD_DISTRICT, { seatId: HELD_DISTRICT, tier: "DM", occupantHrId: HANY, regionCode: "SH", regionName: "Sharkia", areaCode: null, lineCode: "pedia" }],
    ]),
    people: new Map([[hrKey(HANY), { hrId: HANY, fullName: "Hany Saad" }]]),
    lineNames: new Map([["pedia", "Pedia"]]),
  } as unknown as Parameters<typeof facetsFrom>[0]);
  assert.equal(facets.people.length, 1, "the Spotlight picker lists Hany Saad once; the District Manager entry would rank nothing");
  assert.ok(facets.regions.some((region) => region.code === "SH"), "Sharkia is still a region the Spotlight can be filtered by");

  // ── 4. His regions ────────────────────────────────────────────────────────────────────────────
  const seats = indexSalesSeats(
    TREE.map((row) => ({ seat_id: row.seat_id, seat_tier: row.seat_tier, region_code: row.region_code, occupant_hr_id: row.occupant_hr_id })),
  );
  assert.deepEqual(districtRegionCodesHeldBy(HANY, seats), ["SH"], "nobody under this seat carries the label, so the seat itself names it");
  assert.deepEqual(districtRegionCodesHeldBy(SAHAR, seats), ["D2"]);
  assert.deepEqual(districtRegionCodesHeldBy("PD-0100", seats), [], "a rep's seat names no district region");
  assert.deepEqual(districtRegionCodesHeldBy(null, seats), [], "no identity holds nothing, never everything");

  // ── The Delta (2) seat's July to September, published and never changed ──────────────────────
  const scope = computeSeatAreaScope({
    viewerHrId: SAHAR,
    seats: [
      { seatId: "SEAT-PED-RSM", seatTier: "RSM", lineCode: "pedia", path: ["SEAT-PED-RSM"], occupantHrId: HANY },
      { seatId: "SEAT-PED-DM-D2", seatTier: "DM", lineCode: "pedia", path: ["SEAT-PED-RSM", "SEAT-PED-DM-D2"], occupantHrId: SAHAR },
      { seatId: HELD_DISTRICT, seatTier: "DM", lineCode: "pedia", path: ["SEAT-PED-RSM", HELD_DISTRICT], occupantHrId: HANY },
    ],
    lineAreas: [
      { lineCode: "pedia", areaCode: "D21", dmSeatId: "SEAT-PED-DM-D2" },
      { lineCode: "pedia", areaCode: "D24", dmSeatId: HELD_DISTRICT },
      { lineCode: "pedia", areaCode: "D25", dmSeatId: HELD_DISTRICT },
    ],
    factRegionByAreaCode: new Map(),
  });
  assert.deepEqual([...(scope?.areaCodes ?? [])], ["D21"], "from October the seat's bound holds only what is its own");
  assert.deepEqual(scope?.earlierMonthAreas?.get("D24"), "2026-10", "the seat still answers for Sharkia 1 before October");
  const saharSalesScope = computeSalesAccessScope({
    role: "District Manager",
    businessScope: "TEAM",
    viewerLineName: "Pedia",
    viewerRegionName: "Delta (2)",
    includeRestricted: false,
    seatAreaScope: scope,
  });
  assert.equal(
    saharSalesScope.allowedEarlierMonthAreas?.get("D25"),
    "2026-10",
    "the kept areas reach every screen through her sales scope, or none of the month checks below ever run",
  );
  assert.equal(targetsBoundFromSalesScope(saharSalesScope).earlierMonthAreas?.get("D25"), "2026-10");
  const saharVsTarget = vsTargetBoundFromSalesScope(saharSalesScope, { role: "District Manager", scope: "team", hrId: SAHAR });
  assert.equal(saharVsTarget.kind === "areas" ? saharVsTarget.earlierMonthAreas?.get("D25") : null, "2026-10");
  const sahar = {
    kind: "areas" as const,
    areaCodes: scope?.areaCodes ?? new Set<string>(),
    lineCodes: new Set(["pedia"]),
    earlierMonthAreas: scope?.earlierMonthAreas,
  };
  const inMonth = (period: string, areaCode: string) => ({
    ...achievement({ dmSeatId: "SEAT-PED-DM-D2", dmHrId: SAHAR, areaCode, actualValue: 1, targetValue: 1 }),
    period,
  });
  const kept = filterRowsForBound(
    [inMonth("2026-09", "D24"), inMonth("2026-10", "D24"), inMonth("2026-09", "D21"), inMonth("2026-10", "D21"), inMonth("2026-09", "D26")],
    sahar,
  ).map((row) => `${row.period} ${row.areaCode}`);
  assert.deepEqual(
    kept,
    ["2026-09 D24", "2026-09 D21", "2026-10 D21"],
    "September stays as published, Sharkia included; October is not hers; an area she never held stays out",
  );
  assert.equal(
    filterAchievementForScope([inMonth("2026-09", "D24"), inMonth("2026-10", "D24")], {
      canViewAllTargets: false,
      areaCodes: sahar.areaCodes,
      earlierMonthAreas: sahar.earlierMonthAreas,
      lineCodes: sahar.lineCodes,
    }).length,
    1,
    "her Targets screen follows the same month",
  );
  assert.doesNotThrow(() =>
    assertTargetsAreaInBound({ canViewAllTargets: false, ...sahar }, "D24", "Pedia", "2026-09"),
  );
  assert.throws(
    () => assertTargetsAreaInBound({ canViewAllTargets: false, ...sahar }, "D24", "Pedia", "2026-10"),
    /Forbidden/,
    "October's Sharkia detail is Hany Saad's to read, whatever the address says",
  );
  assert.deepEqual(
    [...(areaCodesForMonth(new Set(["D21"]), sahar.earlierMonthAreas, "2026-09") ?? [])].sort(),
    ["D21", "D24", "D25"],
    "a September matrix keeps Sharkia in the seat's closing",
  );
  assert.deepEqual([...(areaCodesForMonth(new Set(["D21"]), sahar.earlierMonthAreas, "2026-10") ?? [])], ["D21"]);
  assert.equal(
    computeSeatAreaScope({
      viewerHrId: "PD-0200",
      seats: [{ seatId: "SEAT-PED-DM-GZ", seatTier: "DM", lineCode: "pedia", path: ["SEAT-PED-DM-GZ"], occupantHrId: "PD-0200" }],
      lineAreas: [{ lineCode: "pedia", areaCode: "GZ1", dmSeatId: "SEAT-PED-DM-GZ" }],
      factRegionByAreaCode: new Map(),
    })?.earlierMonthAreas,
    undefined,
    "another manager's past months are not restated by this ruling",
  );

  // ── The region's name and place ───────────────────────────────────────────────────────────────
  assert.equal(regionName("SH"), "Sharkia", "a manager reads a name, never the code");
  const order: readonly string[] = MONTHLY_CLOSING_REGION_ORDER;
  assert.ok(order.indexOf("SH") >= 0 && order.indexOf("SH") < order.indexOf("OT"), "Sharkia sits among the regions, before Others");
  assert.ok(PERFORMANCE_REVIEW_REGIONS.some((region) => region.regionCode === "SH"), "the Performance Review has to be able to paint it");

  // ── 5. The migration, the only thing that moves the money ─────────────────────────────────────
  const sql = stripSqlComments(
    readFileSync(new URL("../supabase/migrations/20261101190533_pedia_sharkia_to_hany_saad_from_october.sql", import.meta.url), "utf8"),
  );
  assert.match(sql, /v_move_date constant date := date '2026-10-01'/, "he chose October: July to September stay as published");
  assert.match(sql, /set effective_to = v_move_date/, "the old row is CLOSED on the move date, so an earlier month still reaches it");
  assert.doesNotMatch(sql, /set\s+(operational_region_code|dm_seat_id)\s*=/, "an in-place edit would rewrite every published month");
  assert.match(sql, /false, v_move_date, true\)/, "the seat is is_active = false and sales_only = true, so the org tree never shows it");
  assert.match(sql, /'vacant_will_hire', v_seat, 'SEAT-PED-REP-D24'/, "the area keeps its rep seat, so it keeps its target");
  assert.match(sql, /'vacant_will_hire', v_seat, 'SEAT-PED-REP-D25'/, "the area keeps its rep seat, so it keeps its target");
  assert.doesNotMatch(sql, /au_v_org_tree_sales/, "the view goes on before the merge and the move after it, so they are two files");
  const viewSql = stripSqlComments(
    readFileSync(new URL("../supabase/migrations/20261101190532_au_v_org_tree_sales.sql", import.meta.url), "utf8"),
  );
  assert.match(viewSql, /where s\.sales_only/, "the sales tree adds the sales-only seats and nothing else");
  assert.match(
    viewSql,
    /revoke all on public\.au_v_org_tree_sales from public, anon, authenticated/,
    "the seat tree names who holds what: never readable with the key in the browser bundle",
  );
  assert.match(viewSql, /^\s*begin;[\s\S]*commit;\s*$/, "the view must never exist with its default grants");

  // Every read that decides whose money it is follows the sales tree; the chart does not.
  const followsTheMoney = [
    "src/lib/sales/seat-area-scope.ts",
    "src/lib/sales/seat-hierarchy.ts",
    "src/lib/business-review/portal-scope.ts",
    "src/lib/spotlight/org.ts",
    "src/lib/sales/closing-organogram-regions.ts",
    "src/lib/sales/weekly/manager-attribution.ts",
    // A team is one per map row's district seat, so without the seat Sharkia's targets reach nobody.
    "src/lib/sales/targets-uploaded-notification.ts",
  ];
  for (const file of followsTheMoney) {
    const source = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
    assert.match(source, /au_v_org_tree_sales/, `${file} decides whose money it is, so it must see the sales-only seat`);
  }
  const chart = stripComments(readFileSync(new URL("../src/lib/reports/organogram-au-source.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(chart, /au_v_org_tree_sales/, "the chart must never read the tree that carries the sales-only seat");
}
