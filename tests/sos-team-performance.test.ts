import assert from "node:assert/strict";

import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import {
  activePeriodsOf,
  performanceBoundFor,
  regionalManagerMembersFromRows,
  regionWithoutManagerOf,
  repMembersFromRows,
} from "../src/lib/employee-portal/sos-team-performance.ts";
import { chartPersonName } from "../src/lib/format/chart-person-name.ts";
import { buildSalesManagerPerformanceGroups } from "../src/lib/sales/metrics.ts";
import { indexSalesSeats, regionalManagerAbove, vacantDistrictLabel } from "../src/lib/sales/seat-hierarchy.ts";

function row(overrides: Partial<AchievementRow>): AchievementRow {
  return {
    period: "2026-08",
    lineCode: "cns",
    regionCode: "R1",
    areaCode: "AB1",
    areaState: null,
    isOther: false,
    repSeatId: null,
    repHrId: "1001",
    dmSeatId: null,
    dmHrId: "1002",
    productCode: "P1",
    actualUnits: 0,
    actualValue: 0,
    targetUnits: null,
    targetValue: null,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: false,
    hasActual: true,
    ...overrides,
  };
}

export function runSosTeamPerformanceTests() {
  // ── A month with no published Monthly Closing must not activate ──────────────────
  // [Owner ruling, 2026-08-13]: a live dashboard may only count a period once that
  // line's Monthly Closing is PUBLISHED — a later, admin-gated action, not merely a
  // landed distributor upload. `hasActual` alone previously said a month was "in" (the
  // 2026-08-10 stray-Direct-Order regression: 1,309.50 EGP pulled the FULL month's
  // target into every manager's default cumulative keycard denominator against almost
  // no actual, roughly halving every keycard's default achievement %). A period counts
  // as active only when its OWN (lineCode, period) key is in `publishedKeys` — see
  // isRowPublished / loadPublishedPeriodKeys in vs-target.ts.
  const julyPublished = new Set(["cns|2026-07"]);

  const unpublishedAugustOnly = [
    row({ period: "2026-07", actualValue: 91784.8, targetValue: 549702.94, hasTarget: true, hasActual: true }),
    row({ period: "2026-08", actualValue: 1309.5, targetValue: 4738.5, hasTarget: true, hasActual: true }),
  ];
  assert.deepEqual(
    activePeriodsOf(unpublishedAugustOnly, julyPublished),
    ["2026-07"],
    "a month whose Monthly Closing has not been published must not activate — it would pull the full month's target into the default cumulative view against sales nobody has closed yet",
  );

  // ── A month WITH a published Monthly Closing is active once it has actual ────────
  const bothPublished = new Set(["cns|2026-07", "cns|2026-08"]);
  const twoRealMonths = [
    row({ period: "2026-07", actualValue: 91784.8, targetValue: 549702.94, hasTarget: true, hasActual: true }),
    row({ period: "2026-08", actualValue: 60000, targetValue: 549702.94, hasTarget: true, hasActual: true }),
  ];
  assert.deepEqual(
    activePeriodsOf(twoRealMonths, bothPublished),
    ["2026-08", "2026-07"],
    "once a month's Monthly Closing is published, its actual sales activate it normally, newest first",
  );

  // ── A future-target-only month stays excluded even if it is published ────────────
  // Existing behavior (pre-dating this fix) must survive: a month that carries a target
  // but zero actual sales is not a reporting period, regardless of publication status.
  const targetOnlyButPublished = [
    row({ period: "2026-07", actualValue: 91784.8, targetValue: 549702.94, hasTarget: true, hasActual: true }),
    row({ period: "2026-09", actualValue: 0, targetValue: 549702.94, hasTarget: true, hasActual: false }),
  ];
  assert.deepEqual(
    activePeriodsOf(targetOnlyButPublished, new Set(["cns|2026-07", "cns|2026-09"])),
    ["2026-07"],
    "a month with only a future target and zero actual sales stays excluded even though it is in publishedKeys",
  );

  // ── A row's line must match the published key's line, not just the period ────────
  // monthly_closing_publications keys per (line, period): a CNS row in a period where
  // only Pedia published must NOT read as active — the old period-only Set could not
  // express this and would have silently activated every line at once.
  const wrongLinePublished = [
    row({ period: "2026-07", lineCode: "cns", actualValue: 91784.8, targetValue: 549702.94, hasTarget: true, hasActual: true }),
  ];
  assert.deepEqual(
    activePeriodsOf(wrongLinePublished, new Set(["pedia|2026-07"])),
    [],
    "a published key for a different line must not activate this row's line",
  );

  // ── Sorted newest-first and de-duplicated ─────────────────────────────────────────
  const threeMonthsUnordered = [
    row({ period: "2026-08", actualValue: 100, hasActual: true }),
    row({ period: "2026-07", actualValue: 100, hasActual: true }),
    row({ period: "2026-07", productCode: "P2", actualValue: 50, hasActual: true }),
    row({ period: "2026-09", actualValue: 100, hasActual: true }),
  ];
  assert.deepEqual(
    activePeriodsOf(threeMonthsUnordered, new Set(["cns|2026-07", "cns|2026-08", "cns|2026-09"])),
    ["2026-09", "2026-08", "2026-07"],
    "active periods are de-duplicated and sorted newest first",
  );

  runVacantDistrictAndRegionalManagerTests();

  // Chart axis labels are first + last name; a region row's label is not a person and stays whole.
  assert.equal(chartPersonName("Hany Mohamed Ali Saad"), "Hany Saad");
  assert.equal(chartPersonName("  Dina   Delta "), "Dina Delta");
  assert.equal(chartPersonName("Madonna"), "Madonna");
  assert.equal(chartPersonName("Giza — no regional manager"), "Giza — no regional manager");
  assert.equal(chartPersonName(null), "Employee");
}

/**
 * Owner, 2026-10-20: "when filter by manager u find no manager … every single role that's applicable
 * to appear in a module, find and show it." Reps under a vacant District Manager seat are named by
 * that district, and a Regional Manager gets a roll-up row that is only ever the SUM of the seated
 * district rows under his seat. The seat tree mirrors the live au_v_org_tree shape (one RSM seat
 * under the Pedia NSM over districts; a vacant district straight under the NSM; an "Others" bucket).
 */
function runVacantDistrictAndRegionalManagerTests() {
  const seat = (
    seatId: string,
    parent: string | null,
    tier: string,
    regionName: string | null,
    occupant: string | null,
    isOther = false,
  ) => ({
    seat_id: seatId,
    parent_seat_id: parent,
    seat_tier: tier,
    line_code: "pedia",
    region_name: regionName,
    occupant_hr_id: occupant,
    is_other_pseudo_dm: isOther,
  });
  const seats = indexSalesSeats([
    seat("SEAT-NSM", null, "NSM", null, "N-1"),
    seat("SEAT-RSM", "SEAT-NSM", "RSM", null, "R-1"),
    seat("DM-D1", "SEAT-RSM", "DM", "Delta (1)", "D-1"),
    seat("DM-D2", "SEAT-RSM", "DM", "Delta (2)", "D-2"),
    seat("DM-AB", "SEAT-RSM", "DM", "Alex-BHR", null),
    seat("DM-CA", "SEAT-NSM", "DM", "Cairo", null),
    seat("DM-GZ", "SEAT-NSM", "DM", "Giza", "D-3"),
    seat("DM-OTHERS", "SEAT-NSM", "DM", "Others", null, true),
  ]);
  const names = new Map([
    ["N-1", "Nadia National"],
    ["R-1", "Rami Regional"],
    ["D-1", "Dina Delta One"],
    ["D-2", "Dalia Delta Two"],
    ["D-3", "Ghada Giza"],
    ["M-1", "Mona Rep"],
    ["M-2", "Maged Rep"],
    ["M-3", "Mariam Rep"],
    ["M-4", "Mahmoud Rep"],
    ["M-5", "Magdy Rep"],
    ["M-6", "Marwa Rep"],
  ]);
  const products = new Map<string, string>();

  // ── Seat helpers ──────────────────────────────────────────────────────────────────
  assert.equal(vacantDistrictLabel("DM-AB", seats), "Vacant — Alex-BHR", "a vacant DM seat is named by its own district");
  assert.equal(vacantDistrictLabel("DM-OTHERS", seats), null, "the per-line Others bucket is not a district");
  assert.equal(vacantDistrictLabel("SEAT-RSM", seats), null, "only a DM seat names a district");
  assert.deepEqual(regionalManagerAbove("DM-D1", seats), { seatId: "SEAT-RSM", hrId: "R-1" });
  assert.equal(regionalManagerAbove("DM-GZ", seats), null, "a district straight under the NSM has no Regional Manager");

  const pediaRow = (overrides: Partial<AchievementRow>) => row({ lineCode: "pedia", hasTarget: true, ...overrides });
  const rows: AchievementRow[] = [
    pediaRow({ repHrId: "M-1", dmSeatId: "DM-D1", dmHrId: "D-1", actualValue: 100, targetValue: 200 }),
    pediaRow({ repHrId: "M-2", dmSeatId: "DM-D2", dmHrId: "D-2", actualValue: 300, targetValue: 300 }),
    pediaRow({ repHrId: "M-3", dmSeatId: "DM-AB", dmHrId: null, actualValue: 50, targetValue: 100 }),
    pediaRow({ repHrId: "M-4", dmSeatId: "DM-CA", dmHrId: null, actualValue: 70, targetValue: 100 }),
    pediaRow({ repHrId: "M-5", dmSeatId: "DM-GZ", dmHrId: "D-3", actualValue: 400, targetValue: 500 }),
    pediaRow({ repHrId: "M-6", dmSeatId: "DM-OTHERS", dmHrId: null, actualValue: 10, targetValue: 10 }),
  ];

  // ── A rep under a vacant DM seat is named by that district, never "Unassigned District" ──
  const reps = repMembersFromRows(rows, names, products, seats);
  const repByHrId = new Map(reps.map((rep) => [rep.hrId, rep]));
  assert.equal(repByHrId.get("M-3")?.managerName, "Vacant — Alex-BHR");
  assert.equal(repByHrId.get("M-3")?.vacantManagerSeatId, "DM-AB");
  assert.equal(repByHrId.get("M-4")?.managerName, "Vacant — Cairo");
  assert.equal(repByHrId.get("M-1")?.managerName, "Dina Delta One", "a seated district keeps its manager's name");
  assert.equal(repByHrId.get("M-1")?.vacantManagerSeatId, undefined, "a seated district carries no vacant seat");
  assert.equal(repByHrId.get("M-6")?.managerName, null, "a rep in the Others bucket keeps the unassigned label");

  // Two vacant districts stay two groups — never merged into one "Unassigned District" bucket.
  const groups = buildSalesManagerPerformanceGroups(reps);
  const vacantGroups = groups
    .filter((group) => group.isVacantSeat)
    .map((group) => group.managerName)
    .sort();
  assert.deepEqual(vacantGroups, ["Vacant — Alex-BHR", "Vacant — Cairo"]);
  assert.ok(groups.some((group) => group.managerHrId === "vacant:DM-AB"), "a vacant district groups under its own seat key");
  assert.equal(groups.find((group) => group.managerHrId === "D-1")?.isVacantSeat, false);
  assert.equal(groups.find((group) => group.managerHrId === "unassigned")?.managerName, "Unassigned District");

  // ── The Regional Manager row is the SUM of the seated districts under his seat ──────
  const regionalManagers = regionalManagerMembersFromRows(rows, seats, names, products, {
    hrId: "N-1",
    name: "Nadia National",
  });
  assert.equal(regionalManagers.length, 2, "one occupied RSM seat plus the one region with no Regional Manager");
  const regional = regionalManagers.find((member) => member.hrId === "R-1")!;
  assert.equal(regional.hrId, "R-1");
  assert.equal(regional.isRegionWithoutManager, undefined, "a seated Regional Manager is a person, not a region row");
  assert.equal(regional.name, "Rami Regional");
  assert.equal(regional.managerName, "Nadia National", "a Regional Manager reports to the line's NSM");
  // Delta (1) + Delta (2) only: the vacant Alex-BHR district under him has no DM row and is left out.
  assert.equal(regional.totalSales, 100 + 300);
  assert.equal(regional.totalTarget, 200 + 300);
  assert.equal(regional.achievementPercent, (400 / 500) * 100);

  // Giza reports straight to the NSM: its sales are not dropped, they are a row of their own.
  const giza = regionalManagers.find((member) => member.isRegionWithoutManager)!;
  assert.equal(giza.name, "Giza — no regional manager");
  assert.equal(giza.totalSales, 400);
  assert.equal(giza.totalTarget, 500);
  assert.equal(giza.managerName, "Nadia National");
  // COMPLETENESS: the roll-up rows add up to every seated district (Delta 1 + Delta 2 + Giza), each once.
  const seatedDistrictSales = rows
    .filter((candidate) => candidate.dmHrId)
    .reduce((sum, candidate) => sum + candidate.actualValue, 0);
  assert.equal(
    regionalManagers.reduce((sum, member) => sum + member.totalSales, 0),
    seatedDistrictSales,
    "Regional roll-up rows foot to the seated-district total — no region is left out and none is counted twice",
  );
  assert.equal(
    regionalManagers.reduce((sum, member) => sum + member.totalTarget, 0),
    rows.filter((candidate) => candidate.dmHrId).reduce((sum, candidate) => sum + (candidate.targetValue ?? 0), 0),
  );
  // Two numbered districts of one region are ONE row; the Others bucket and a vacant district are none.
  const upperEgyptSeats = indexSalesSeats([
    seat("SEAT-NSM", null, "NSM", null, "N-1"),
    seat("DM-UE1", "SEAT-NSM", "DM", "Upper Egypt 1", "D-4"),
    seat("DM-UE2", "SEAT-NSM", "DM", "Upper Egypt 2", "D-5"),
    seat("DM-OTHERS", "SEAT-NSM", "DM", "Others", null, true),
  ]);
  const upperEgypt = regionalManagerMembersFromRows(
    [
      pediaRow({ repHrId: "M-1", dmSeatId: "DM-UE1", dmHrId: "D-4", actualValue: 10, targetValue: 20 }),
      pediaRow({ repHrId: "M-2", dmSeatId: "DM-UE2", dmHrId: "D-5", actualValue: 30, targetValue: 40 }),
      pediaRow({ repHrId: "M-3", dmSeatId: "DM-OTHERS", dmHrId: null, actualValue: 99, targetValue: 99 }),
    ],
    upperEgyptSeats,
    names,
    products,
    { hrId: "N-1", name: "Nadia National" },
  );
  assert.equal(upperEgypt.length, 1);
  assert.equal(upperEgypt[0].name, "Upper Egypt — no regional manager");
  assert.equal(upperEgypt[0].totalSales, 40);
  assert.equal(regionWithoutManagerOf("DM-OTHERS", upperEgyptSeats), null, "the Others bucket is not a region");
  assert.equal(regionWithoutManagerOf("DM-UE1", new Map()), null, "an empty seat tree names no region");

  // The viewer's own row is never listed back to him.
  assert.deepEqual(
    regionalManagerMembersFromRows(rows, seats, names, products, { hrId: "R-1", name: "Rami Regional" }, "r-1"),
    [],
    "a Regional Manager reading his own region does not see himself as a roll-up row",
  );
  // A vacant RSM seat names nobody — its seated districts are totalled by region, not under a person.
  const vacantRsmSeats = indexSalesSeats([
    seat("SEAT-RSM", null, "RSM", null, null),
    seat("DM-D1", "SEAT-RSM", "DM", "Delta (1)", "D-1"),
  ]);
  const underVacantRsm = regionalManagerMembersFromRows(rows, vacantRsmSeats, names, products, { hrId: "N-1", name: null });
  assert.deepEqual(
    underVacantRsm.map((member) => [member.name, member.totalSales]),
    [["Delta — no regional manager", 100]],
  );

  // ── A Regional Manager whose seat did not resolve reads nothing, never the whole line ──
  const lineBound = { kind: "line" as const, lineCodes: new Set(["pedia"]) };
  const areasBound = { kind: "areas" as const, areaCodes: new Set(["AB1"]), lineCodes: new Set(["pedia"]) };
  assert.deepEqual(performanceBoundFor("Regional Manager", lineBound), { kind: "none" });
  assert.deepEqual(performanceBoundFor("Regional Manager", { kind: "company" }), { kind: "none" });
  assert.equal(performanceBoundFor("Regional Manager", areasBound), areasBound, "a resolved seat keeps his areas");
  assert.equal(performanceBoundFor("National Sales Manager", lineBound), lineBound, "the NSM keeps his line");
}
