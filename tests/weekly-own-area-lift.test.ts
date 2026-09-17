import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { AccessContext, PhoenixRole } from "../src/lib/auth/permissions.ts";
import { applyWeeklyAccessScope, liftWeeklyGeography, type WeeklyAccessScope } from "../src/lib/sales/weekly/access.ts";
import { buildWeeklyAreaSplitIndex } from "../src/lib/sales/weekly/branch-area-split.ts";
import { depotWeekGaps } from "../src/lib/sales/weekly/decumulate.ts";
import {
  admitWeeklyStockRows,
  mayLiftWeeklyGeography,
  resolveWeeklyOwnAreaKeys,
  weeklyScopeOwnAreaKeys,
  weeklyStockProductPredicate,
  withExtraWeeklyOptions,
} from "../src/lib/sales/weekly/own-area-scope.ts";
import {
  narrowWeeklyRowsToOwnAreaShare,
  type WeeklyOwnAreaShare,
  type WeeklyOwnAreaShareRow,
} from "../src/lib/sales/weekly/own-area-share.ts";
import {
  buildPortalWeeklyFieldForce,
  fieldForceKey,
  selectFieldForceSeats,
  type FieldForceSeatRow,
  type PortalWeeklyFieldForce,
} from "../src/lib/sales/weekly/portal-weekly-field-force.ts";
import type { WeeklyStockSourceRow } from "../src/lib/sales/weekly/stock-dashboard.ts";
import type { WeeklyFactExportRow } from "../src/lib/sales/weekly/types.ts";

// Weekly rows are depot data, and a depot row keeps the region label it was mapped with. The
// organogram moved on: Anti Infective's Upper Egypt is now Upper Egypt 1 and Upper Egypt 2, and
// Delta (3) was carved out on 2026-09-01, but nearly all of that money still says "UE" and not one row
// says Delta (3). A territory viewer was bounded by his OWN region code, so an Upper Egypt 2 manager
// never even loaded the "UE" rows the owner's depot-split rule shares with his areas: his reps read
// low on the Field Force tab, a rep's month-pace strip read about zero, and Weekly Stock was nearly
// empty (found 2026-09-16, building the medical rep's own Weekly Sales page).
//
// PR 3894 lifted the region bound for the Field Force tab's LOAD and kept a row his own scope admitted
// WHOLE. Measured on production on 17 Sept 2026 that left a manager's screens disagreeing (the Upper
// Egypt 2 manager's Sales Value 5,135 beside 25,694 on his Field Force tab) and put other managers' money
// on his tab (Qalubeya, Delta (3)'s since 1 Sept, still whole on Delta (1)'s). The owner ruled:
//   1. every figure on a manager's screens follows his own areas;
//   2. money the depot split places in ANOTHER manager's area is not his, whatever its region label;
//   3. a depot serving several areas reaches him as his areas' share only.
// Money that reaches no area at all (a warehouse, a tender) stays with the manager whose scope admits it.
// Weekly Stock keeps its own rule: a shelf serving one of his areas stays whole (block 5).

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** The body of one top-level function, so a wiring check cannot be satisfied by a sibling. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

const AI = "Anti Infective";

// Anti Infective's Upper Egypt as production maps it: Assiut is Upper Egypt 2 on this line.
const AREA_ROWS = [
  ["UE1", "Minia 1"], ["UE2", "Minia 2"], ["UE3", "Assuit 1"], ["UE4", "Assuit 2"],
  ["UE5", "Sohag1"], ["UE6", "Sohag2"], ["UE7", "Qena 1"], ["UE8", "Qena 2"], ["UE9", "Beni Suef"],
].map(([area_code, area_name]) => ({ area_code, area_name }));

const MAP_ROWS = [
  ...[["UE1", "UE-1"], ["UE2", "UE-1"], ["UE9", "UE-1"],
      ["UE3", "UE-2"], ["UE4", "UE-2"], ["UE5", "UE-2"], ["UE6", "UE-2"], ["UE7", "UE-2"], ["UE8", "UE-2"]]
    .map(([area_code, operational_region_code]) => ({
      line_code: "anti_infective",
      area_code,
      operational_region_code,
      effective_from: "2026-07-13",
      effective_to: null,
    })),
];

const SPLIT = buildWeeklyAreaSplitIndex(MAP_ROWS, AREA_ROWS, "2026-09-16");

/** "Minia and Assiut": 25% to each of UE1 and UE2 (Upper Egypt 1) and UE3 and UE4 (Upper Egypt 2). */
const MINYA_ASSIUT = "ك.ع.المنيا واسيوط";
/** Sohag: half to UE5, half to UE6, both Upper Egypt 2. */
const SOHAG = "ك.عملاء سوهاج";
/** A warehouse is never spread down to reps. */
const WAREHOUSE = "Assiut 2 Warehouse";

const repSeat = (area: string, region: string, occupant: string | null, extra: Partial<FieldForceSeatRow> = {}) => ({
  seat_id: `SEAT-AI-REP-${area}`,
  seat_tier: "REP",
  line_code: "anti_infective",
  line_name: AI,
  region_code: region,
  region_name: region === "UE-1" ? "Upper Egypt 1" : "Upper Egypt 2",
  area_code: area,
  area_name: AREA_ROWS.find((row) => row.area_code === area)?.area_name ?? area,
  occupant_hr_id: occupant,
  is_vacant: occupant === null,
  parent_seat_id: region === "UE-1" ? "SEAT-AI-DM-UE1" : "SEAT-AI-DM-UE2",
  ...extra,
});

const SEATS: FieldForceSeatRow[] = [
  { seat_id: "SEAT-AI-DM-UE1", seat_tier: "DM", line_code: "anti_infective", line_name: AI, region_code: "UE-1", occupant_hr_id: "A-901", is_vacant: false },
  { seat_id: "SEAT-AI-DM-UE2", seat_tier: "DM", line_code: "anti_infective", line_name: AI, region_code: "UE-2", occupant_hr_id: "A-902", is_vacant: false },
  repSeat("UE1", "UE-1", "A-101"),
  repSeat("UE2", "UE-1", "A-102"),
  repSeat("UE9", "UE-1", null),
  repSeat("UE3", "UE-2", "A-103"),
  repSeat("UE4", "UE-2", "A-104"),
  repSeat("UE5", "UE-2", "A-105"),
  repSeat("UE6", "UE-2", "A-106"),
  // A seat the organogram still spells with the rep's older HR id.
  repSeat("UE8", "UE-2", "LEGACY-105"),
  // Occupied on paper but flagged vacant: nobody may claim it.
  repSeat("UE7", "UE-2", "A-107", { is_vacant: true }),
  // The same person also seated on another line — never his on an Anti Infective screen.
  { ...repSeat("UE5", "UE", "A-105"), seat_id: "SEAT-CNS-REP-UE5", line_code: "cns", line_name: "CNS", parent_seat_id: null },
];

const NAMES: Record<string, string> = {
  "a-101": "Hany Lotfy",
  "a-102": "Mona Saber",
  "a-103": "Tarek Hassan",
  "a-104": "Dina Farouk",
  "a-105": "Samir Nabil",
  "a-106": "Rania Fawzy",
  "legacy-105": "Samir Nabil",
  "a-901": "Adel Mansour",
  "a-902": "Heba Ragab",
};
const INDEX = selectFieldForceSeats(SEATS, (hrId) => (hrId ? (NAMES[hrId] ?? null) : null));

const UE2_DM_SCOPE = {
  tier: "territory" as const,
  allowedLineNames: new Set([AI]),
  allowedRegionCodes: new Set(["UE-2"]),
  allowedAreaCodes: new Set(["UE3", "UE4", "UE5", "UE6", "UE7", "UE8"]),
  canViewHeadOffice: false,
};

/** A medical rep's scope carries his region and no area bound. */
const UE2_REP_SCOPE = {
  tier: "territory" as const,
  allowedLineNames: new Set([AI]),
  allowedRegionCodes: new Set(["UE-2"]),
  allowedAreaCodes: null,
  canViewHeadOffice: false,
};

/** A signed-in viewer. resolveWeeklyOwnAreaKeys reads only his HR id and his role. */
const viewer = (hrId: string, role: PhoenixRole = "Medical Rep"): AccessContext => ({
  hrId,
  role,
  scope: role === "Medical Rep" ? "self" : "team",
  source: "session",
});

/** One de-cumulated row as the weekly loader holds it, before any figure is built. */
type LoadRow = WeeklyOwnAreaShareRow & {
  distributorCode: string;
  distributorName: string;
  productName: string;
  cycleMonth: string;
  weekNumber: number | null;
  weekStart: string;
  batchId: string;
};

function loadRow(overrides: Partial<LoadRow>): LoadRow {
  return {
    distributorCode: "IBS",
    distributorName: "Ibn Sina",
    productCode: "AI01",
    productName: "Royafloxacin 500mg",
    officialLine: AI,
    regionCode: "UE",
    regionName: "Upper Egypt",
    areaCode: null,
    branchCode: "BR",
    branchName: MINYA_ASSIUT,
    cycleMonth: "2026-09-01",
    weekNumber: 1,
    weekStart: "2026-09-01",
    batchId: "batch-1",
    salesValue: 0,
    salesQty: 0,
    netQty: 0,
    stockQty: 0,
    ...overrides,
  };
}

/** The row grain the loader hands the Field Force grid (service.ts factRows). */
const toFactRow = (row: LoadRow): WeeklyFactExportRow => ({
  distributorCode: row.distributorCode,
  distributorName: row.distributorName,
  productCode: row.productCode,
  productName: row.productName,
  line: row.officialLine,
  regionCode: row.regionCode,
  regionName: row.regionName,
  areaCode: row.areaCode,
  branchCode: row.branchCode,
  branchName: row.branchName,
  cycleMonth: row.cycleMonth,
  weekNumber: row.weekNumber,
  weekStart: row.weekStart,
  batchId: row.batchId,
  family: "Royafloxacin",
  salesValue: row.salesValue,
  salesUnits: row.netQty,
  stockUnits: row.stockQty,
  ...(row.areaBasis ? { areaBasis: row.areaBasis } : {}),
});

// One month of Anti Infective depot rows in Upper Egypt, every region label included.
/** Filed under Upper Egypt 2; Sohag splits half to UE5, half to UE6 — both his. */
const OWN_SOHAG = loadRow({ regionCode: "UE-2", regionName: "Upper Egypt 2", branchName: SOHAG, salesValue: 1000, netQty: 10, salesQty: 12, stockQty: 20 });
/** Filed under the old "UE" label; a quarter each to UE1 and UE2 (Upper Egypt 1), UE3 and UE4 (his). */
const UE_MINYA_ASSIUT = loadRow({ salesValue: 4000, netQty: 40, salesQty: 44, stockQty: 80 });
/** THE CASE THE OWNER RULED ON: filed under HIS region, yet half its money is Upper Egypt 1's. */
const OWN_MINYA_ASSIUT = loadRow({ regionCode: "UE-2", regionName: "Upper Egypt 2", branchCode: "BR2", salesValue: 2000, netQty: 20, salesQty: 20, stockQty: 40 });
const UE_PINNED_UE5 = loadRow({ areaCode: "UE5", branchName: "Sohag hand-mapped", weekNumber: 2, salesValue: 700, netQty: 7, salesQty: 7, stockQty: 14 });
const UE_PINNED_UE1 = loadRow({ areaCode: "UE1", branchName: "Minia hand-mapped", weekNumber: 2, salesValue: 300, netQty: 3, salesQty: 3, stockQty: 6 });
/** Filed under HIS region, mapped by hand to another manager's area. */
const OWN_PINNED_UE1 = loadRow({ regionCode: "UE-2", regionName: "Upper Egypt 2", areaCode: "UE1", branchName: "Minia hand-mapped 2", weekNumber: 2, salesValue: 150, netQty: 2, salesQty: 2, stockQty: 4 });
const UE_WAREHOUSE = loadRow({ branchName: WAREHOUSE, weekNumber: 2, salesValue: 900, netQty: 9, salesQty: 9, stockQty: 18 });
const OWN_WAREHOUSE = loadRow({ regionCode: "UE-2", regionName: "Upper Egypt 2", branchName: WAREHOUSE, weekNumber: 2, salesValue: 250, netQty: 2, salesQty: 2, stockQty: 5 });
const UE_WEEK3_OTHER = loadRow({ areaCode: "UE2", branchName: "Minia hand-mapped", weekNumber: 3, salesValue: 50, netQty: 1, salesQty: 1, stockQty: 2 });

const LOADED_ROWS = [
  OWN_SOHAG, UE_MINYA_ASSIUT, OWN_MINYA_ASSIUT, UE_PINNED_UE5, UE_PINNED_UE1, OWN_PINNED_UE1, UE_WAREHOUSE, OWN_WAREHOUSE, UE_WEEK3_OTHER,
];

const share = (ownAreaKeys: ReadonlySet<string>, overrides: Partial<WeeklyOwnAreaShare> = {}): WeeklyOwnAreaShare => ({
  ownAreaKeys,
  areaSplit: SPLIT,
  seatIndex: INDEX,
  ...overrides,
});

const sumValue = (rows: readonly { salesValue: number }[]) => rows.reduce((sum, row) => sum + row.salesValue, 0);

const byArea = (grid: PortalWeeklyFieldForce) =>
  Object.fromEntries(grid.reps.filter((rep) => rep.areaCode).map((rep) => [rep.areaCode as string, rep.value]));
const residue = (grid: PortalWeeklyFieldForce) =>
  grid.reps.filter((rep) => rep.kind === "unattributed").reduce((sum, rep) => sum + rep.value, 0);

function stockRow(overrides: Partial<WeeklyStockSourceRow>): WeeklyStockSourceRow {
  return {
    distributorCode: "IBS",
    distributorName: "Ibn Sina",
    regionCode: "UE",
    regionName: "Upper Egypt",
    areaCode: null,
    branchCode: "BR",
    branchName: MINYA_ASSIUT,
    productCode: "AI01",
    productName: "Royafloxacin 500mg",
    line: AI,
    cycleMonth: "2026-09-01",
    weekNumber: 1,
    weekStart: "2026-09-01",
    netUnits: 12,
    stockUnits: 60,
    factoryPrice: 40,
    ...overrides,
  };
}

export async function runWeeklyOwnAreaLiftTests() {
  // ── 1. an Upper Egypt 2 district manager's rows follow his own areas ───────────────────────
  {
    const ownAreaKeys = weeklyScopeOwnAreaKeys(UE2_DM_SCOPE);
    const snapshot = JSON.stringify(LOADED_ROWS);
    const rows = narrowWeeklyRowsToOwnAreaShare(LOADED_ROWS, UE2_DM_SCOPE, share(ownAreaKeys));
    assert.equal(JSON.stringify(LOADED_ROWS), snapshot, "the loaded rows are never mutated");

    const valueIn = (area: string | null) =>
      sumValue(rows.filter((row) => (row.areaCode ?? null) === area));

    // HEADLINE (owner, 2026-09-17) — a depot filed under HIS region reaches him as his areas' share only.
    const ownMinya = rows.filter((row) => row.branchCode === "BR2");
    assert.deepEqual(
      ownMinya.map((row) => [row.areaCode, row.salesValue, row.areaBasis]),
      [["UE3", 500], ["UE4", 500]].map(([area, value]) => [area, value, "allocated"]),
      "a Minia+Assiut depot labelled Upper Egypt 2 counts only its Assiut quarters, never whole",
    );
    // HEADLINE — money the split places in another manager's area leaves, whatever the depot's label.
    assert.equal(valueIn("UE1"), 0, "no Minia 1 money: not the UE-labelled share, not the UE-2-labelled share, not a hand-mapped row");
    assert.equal(valueIn("UE2"), 0, "no Minia 2 money either");
    assert.ok(!rows.some((row) => row.branchName === "Minia hand-mapped 2"), "a row filed under his region but mapped to Minia 1 is Minia 1's");

    // The "UE" rows his region bound used to hide reach him as his share.
    assert.equal(valueIn("UE3"), 1500, "Assuit 1: a quarter of the UE depot (1,000) and of the UE-2 depot (500)");
    assert.equal(valueIn("UE4"), 1500, "Assuit 2: the same");
    assert.equal(valueIn("UE5"), 1200, "Sohag 1: half the Sohag depot (500) and the row mapped to it by hand (700)");
    assert.equal(valueIn("UE6"), 500, "Sohag 2: the other half");

    // Money no rule places stays with the manager whose scope admits it, and nobody else.
    assert.equal(valueIn(null), 250, "his own region's warehouse stays, whole; the UE warehouse is not his");
    assert.equal(rows.find((row) => row.areaCode === null)?.areaBasis, "whole", "and it is marked whole");
    assert.equal(sumValue(rows), 4950, "his total is exactly his areas' money plus the residue his scope admits");

    // How each row reached him, and where it is filed: under the organogram's region, not the depot label.
    assert.equal(rows.find((row) => row.branchName === "Sohag hand-mapped")?.areaBasis, "mapped", "a hand-mapped row is marked mapped");
    const ueQuarter = rows.find((row) => row.branchCode === "BR" && row.branchName === MINYA_ASSIUT && row.areaCode === "UE3");
    assert.deepEqual(
      [ueQuarter?.regionCode, ueQuarter?.regionName],
      ["UE-2", "Upper Egypt 2"],
      "a UE-labelled share in Assuit 1 is filed under Upper Egypt 2",
    );
    assert.equal(rows.find((row) => row.branchName === "Sohag hand-mapped")?.regionCode, "UE-2", "and so is a UE-labelled row mapped to Sohag 1");
    assert.equal(rows.find((row) => row.areaCode === null)?.regionCode, "UE-2", "residue keeps its own label");

    // Units split with the money and are conserved — net, gross and stock alike.
    const ueParts = rows.filter((row) => row.branchCode === "BR" && row.branchName === MINYA_ASSIUT);
    assert.deepEqual(
      ueParts.map((row) => [row.netQty, row.salesQty, row.stockQty]),
      [[10, 11, 20], [10, 11, 20]],
      "each Assiut quarter carries a quarter of the net units, the gross units and the stock",
    );
    const sohagHalves = rows.filter((row) => row.branchName === SOHAG);
    assert.deepEqual(
      [sohagHalves.reduce((sum, row) => sum + row.netQty, 0), sohagHalves.reduce((sum, row) => sum + row.salesQty, 0)],
      [10, 12],
      "a depot wholly in his areas keeps every unit",
    );

    // In load order, so every list built from these rows reads as it did.
    assert.deepEqual(
      rows.map((row) => row.salesValue),
      [500, 500, 1000, 1000, 500, 500, 700, 250],
      "rows come back in the order they were loaded, each depot's parts in place of the depot",
    );

    // HEADLINE — his Sales Value and his Field Force total are one number.
    const grid = buildPortalWeeklyFieldForce({ rows: rows.map(toFactRow), areaSplit: SPLIT, seatIndex: INDEX });
    assert.equal(grid.totals.value, sumValue(rows), "the Field Force total equals the KPI built from the same rows");
    assert.equal(byArea(grid).UE3, 1500, "the grid files his Assuit 1 share under its rep");
    assert.equal(byArea(grid).UE1, undefined, "and no Upper Egypt 1 rep appears on his grid");
    assert.equal(residue(grid), 250, "the admitted warehouse is reported as not attributed, never dropped");
    const ue5 = grid.reps.find((rep) => rep.areaCode === "UE5");
    assert.deepEqual([ue5?.exactValue, ue5?.allocatedValue], [700, 500], "a hand-mapped row stays EXACT, a split share ALLOCATED");
    assert.deepEqual(
      [grid.reps.find((rep) => rep.areaCode === "UE3")?.exactValue, grid.reps.find((rep) => rep.areaCode === "UE3")?.allocatedValue],
      [0, 1500],
      "a share that already carries its area is still an allocation on the grid",
    );
    assert.deepEqual(grid.weekNumbers, [1, 2], "the column axis is his own rows' weeks, as his week comparison is");

    // Degraded: the depot-split map did not load. Nothing is split; his region's depots stay whole and
    // another region's depots stay out. Hand-mapped rows still follow the area.
    const noSplit = narrowWeeklyRowsToOwnAreaShare(LOADED_ROWS, UE2_DM_SCOPE, share(ownAreaKeys, { areaSplit: null }));
    assert.deepEqual(
      noSplit.map((row) => [row.branchName, row.areaCode, row.salesValue, row.areaBasis]),
      [
        [SOHAG, null, 1000, "whole"],
        [MINYA_ASSIUT, null, 2000, "whole"],
        ["Sohag hand-mapped", "UE5", 700, "mapped"],
        [WAREHOUSE, null, 250, "whole"],
      ],
      "with no split map, only his own region's depots (whole) and rows mapped to his areas remain",
    );
    // Degraded: the organogram did not load. The money is the same; only the region label is the depot's.
    const noSeats = narrowWeeklyRowsToOwnAreaShare(LOADED_ROWS, UE2_DM_SCOPE, share(ownAreaKeys, { seatIndex: null }));
    assert.equal(sumValue(noSeats), 4950, "an unreadable organogram never changes his money");
    assert.equal(noSeats.find((row) => row.branchName === "Sohag hand-mapped")?.regionCode, "UE", "it keeps the depot's own label");
  }

  // ── 1b. money in an area no district manager owns stays with the manager of its region ─────
  // Owner, 2026-09-17: a line's "Others" areas carry no rep, no target and no district manager. Money the
  // split places there, or a branch mapped there by hand, stays with the manager whose own region-bound
  // scope admits the depot row, under "Not attributed to a rep", as a warehouse does. Measured for
  // September, leaving it out took EGP 50,454 off CNS Giza and 23,735 off CNS Upper Egypt. An area with
  // no REP seat is not the same thing: Delta (3) owns Anti Infective's OT9 with no rep in it.
  {
    const OTHERS_SEAT = {
      seat_id: "SEAT-AI-OTHERS",
      seat_tier: "DM",
      line_code: "anti_infective",
      line_name: AI,
      region_code: "OT",
      occupant_hr_id: null,
      is_vacant: true,
      is_other_pseudo_dm: true,
    };
    // Sohag 3 sits under the line's Others pseudo-DM. Minya 3 is Upper Egypt 1's, with no rep seat.
    const LINE_AREAS = [
      ...["UE1", "UE2", "UE9", "OT99"].map((area_code) => ({ line_code: "anti_infective", area_code, dm_seat_id: "SEAT-AI-DM-UE1" })),
      ...["UE3", "UE4", "UE5", "UE6", "UE7", "UE8"].map((area_code) => ({ line_code: "anti_infective", area_code, dm_seat_id: "SEAT-AI-DM-UE2" })),
      { line_code: "anti_infective", area_code: "OT97", dm_seat_id: "SEAT-AI-OTHERS" },
    ];
    const nameOf = (hrId: string | null) => (hrId ? (NAMES[hrId] ?? null) : null);
    const index = selectFieldForceSeats([...SEATS, OTHERS_SEAT], nameOf, LINE_AREAS);
    const split = buildWeeklyAreaSplitIndex(
      [
        ...MAP_ROWS,
        { line_code: "anti_infective", area_code: "OT97", operational_region_code: "OT", effective_from: "2026-07-13", effective_to: null },
        { line_code: "anti_infective", area_code: "OT99", operational_region_code: "UE-1", effective_from: "2026-07-13", effective_to: null },
      ],
      [...AREA_ROWS, { area_code: "OT97", area_name: "Sohag 3" }, { area_code: "OT99", area_name: "Minya 3" }],
      "2026-09-16",
    );

    assert.equal(INDEX.managedAreaKeys, undefined, "fixture: an index built without the area map knows no ownership");
    assert.ok(index.managedAreaKeys?.has(fieldForceKey(AI, "OT99")), "an area with no rep seat is still its manager's");
    assert.ok(index.managedAreaKeys?.has(fieldForceKey(AI, "UE7")), "and so is a vacant rep's area");
    assert.ok(!index.managedAreaKeys?.has(fieldForceKey(AI, "OT97")), "the Others pseudo-DM owns no one's area");

    const UE2 = { regionCode: "UE-2", regionName: "Upper Egypt 2" };
    const rowsLoaded = [
      /** His region's Sohag depot, a third each to Sohag 1, Sohag 2 and Sohag 3 (no manager). */
      loadRow({ ...UE2, branchName: SOHAG, branchCode: "BR3", salesValue: 900, netQty: 9, salesQty: 9, stockQty: 18 }),
      /** The same depot under the old "UE" label, which his own scope does not admit. */
      loadRow({ branchName: SOHAG, branchCode: "BR4", salesValue: 600, netQty: 6, salesQty: 6, stockQty: 12 }),
      /** Mapped by hand to Sohag 3, under his region's label, and under the old label. */
      loadRow({ ...UE2, areaCode: "OT97", branchName: "Sohag 3 hand-mapped", weekNumber: 2, salesValue: 400, netQty: 4, salesQty: 4, stockQty: 8 }),
      loadRow({ areaCode: "OT97", branchName: "Sohag 3 hand-mapped 2", weekNumber: 2, salesValue: 50, netQty: 1, salesQty: 1, stockQty: 2 }),
      /** Mapped by hand to Minya 3: Upper Egypt 1's area, although no rep sits in it. */
      loadRow({ ...UE2, areaCode: "OT99", branchName: "Minya 3 hand-mapped", weekNumber: 2, salesValue: 700, netQty: 7, salesQty: 7, stockQty: 14 }),
      /** His region's Minia+Assiut depot: half over Minia 1, Minia 2 and Minya 3, half over Assuit 1 and 2. */
      loadRow({ ...UE2, branchCode: "BR5", salesValue: 1200, netQty: 12, salesQty: 12, stockQty: 24 }),
    ];
    const withMap = share(weeklyScopeOwnAreaKeys(UE2_DM_SCOPE), { areaSplit: split, seatIndex: index });
    const rows = narrowWeeklyRowsToOwnAreaShare(rowsLoaded, UE2_DM_SCOPE, withMap);
    const valueIn = (kept: readonly WeeklyOwnAreaShareRow[], area: string) =>
      sumValue(kept.filter((row) => row.areaCode === area));

    // HEADLINE — his region's money in an area no manager owns stays on his screens.
    assert.equal(valueIn(rows, "OT97"), 700, "Sohag 3: his region depot's third (300) and his region's hand-mapped row (400)");
    assert.deepEqual(
      rows.filter((row) => row.areaCode === "OT97").map((row) => [row.salesValue, row.areaBasis, row.regionCode]),
      [[300, "allocated", "UE-2"], [400, "mapped", "UE-2"]],
      "a split third stays an allocation and a hand-mapped row stays mapped, each under the depot's own label",
    );
    // HEADLINE — only for a row his own scope admits.
    assert.deepEqual(
      rows.filter((row) => row.branchCode === "BR4").map((row) => [row.areaCode, row.salesValue]),
      [["UE5", 200], ["UE6", 200]],
      "an old-label depot reaches him as his own areas' thirds only, never its Sohag 3 third",
    );
    assert.ok(!rows.some((row) => row.branchName === "Sohag 3 hand-mapped 2"), "and an old-label row mapped to Sohag 3 is not his");
    // HEADLINE — an area with no rep seat is still another manager's.
    assert.equal(valueIn(rows, "OT99"), 0, "Minya 3 is Upper Egypt 1's: neither the hand-mapped row nor the depot's share reaches him");
    assert.deepEqual(
      ["UE1", "UE2", "UE3", "UE4", "UE5", "UE6"].map((area) => valueIn(rows, area)),
      [0, 0, 300, 300, 500, 500],
      "his own areas are exactly as before",
    );
    assert.equal(sumValue(rows), 2300, "his total is his areas' money plus what his scope admits in Sohag 3");

    // On the grid it is money under no rep, never a rep row.
    const grid = buildPortalWeeklyFieldForce({ rows: rows.map(toFactRow), areaSplit: split, seatIndex: index });
    assert.equal(grid.totals.value, sumValue(rows), "the Field Force total still equals the KPI");
    assert.equal(residue(grid), 700, "Sohag 3 is reported as not attributed to a rep");
    assert.ok(!grid.reps.some((rep) => rep.areaCode === "OT97"), "no rep row is invented for it");
    const ownerless = grid.reps.find((rep) => rep.kind === "unattributed");
    assert.deepEqual([ownerless?.exactValue, ownerless?.allocatedValue], [400, 300], "its hand-mapped and allocated parts stay apart");

    // The money reaches one district manager only: Upper Egypt 1's never sees Sohag 3, and keeps Minya 3.
    const UE1_DM_SCOPE = { ...UE2_DM_SCOPE, allowedRegionCodes: new Set(["UE-1"]), allowedAreaCodes: new Set(["UE1", "UE2", "UE9", "OT99"]) };
    const ue1 = narrowWeeklyRowsToOwnAreaShare(rowsLoaded, UE1_DM_SCOPE, share(weeklyScopeOwnAreaKeys(UE1_DM_SCOPE), { areaSplit: split, seatIndex: index }));
    assert.equal(valueIn(ue1, "OT97"), 0, "a depot another region's manager admits never puts Sohag 3 on his screens");
    assert.equal(valueIn(ue1, "OT99"), 900, "Minya 3 is his: the hand-mapped row (700) and its third of the depot's Minia half (200)");

    // Degraded: ownership unknown. No area counts as ownerless, so nothing beyond his own areas is kept.
    const noMap = narrowWeeklyRowsToOwnAreaShare(rowsLoaded, UE2_DM_SCOPE, { ...withMap, seatIndex: INDEX });
    assert.equal(valueIn(noMap, "OT97"), 0, "with no area map, Sohag 3 is not kept");
    assert.equal(sumValue(noMap), 1600, "and his own areas' money is unchanged");
    const emptyMap = narrowWeeklyRowsToOwnAreaShare(rowsLoaded, UE2_DM_SCOPE, {
      ...withMap,
      seatIndex: { ...index, managedAreaKeys: new Set<string>() },
    });
    assert.equal(sumValue(emptyMap), 1600, "an empty map never reads as \"no one owns anything\"");
  }

  // ── 2. a medical rep's own seat (the month-pace strip) and viewers who never follow areas ───
  {
    const repKeys = await resolveWeeklyOwnAreaKeys(viewer("A-105"), UE2_REP_SCOPE, INDEX.seats);
    const rows = narrowWeeklyRowsToOwnAreaShare(LOADED_ROWS, UE2_REP_SCOPE, share(repKeys));
    const grid = buildPortalWeeklyFieldForce({ rows: rows.map(toFactRow), areaSplit: SPLIT, seatIndex: INDEX });
    assert.equal(byArea(grid).UE5, 1200, "the Sohag 1 rep: his half of the Sohag depot and the UE row mapped to his area");
    assert.equal(byArea(grid).UE6, undefined, "never his colleague's half");
    assert.equal(byArea(grid).UE3, undefined, "nor any share of the Minia+Assiut depots");

    // A viewer with no region bound, or no known own areas, reads exactly his own scope.
    const product: WeeklyAccessScope = { tier: "product", productCodes: new Set(["AI01"]), canViewHeadOffice: false };
    const full: WeeklyAccessScope = { tier: "full", canViewRestricted: false, canViewHeadOffice: false };
    for (const [label, scope, keys] of [
      ["a product manager", product, weeklyScopeOwnAreaKeys(UE2_DM_SCOPE)],
      ["a company-wide viewer", full, weeklyScopeOwnAreaKeys(UE2_DM_SCOPE)],
      ["a manager with no region bound", { ...UE2_DM_SCOPE, allowedRegionCodes: null }, weeklyScopeOwnAreaKeys(UE2_DM_SCOPE)],
      ["a rep whose seat is unknown", UE2_REP_SCOPE, new Set<string>()],
    ] as [string, WeeklyAccessScope, Set<string>][]) {
      assert.deepEqual(
        narrowWeeklyRowsToOwnAreaShare(LOADED_ROWS, scope, share(keys)),
        applyWeeklyAccessScope(LOADED_ROWS, scope),
        `${label} reads exactly his own scope`,
      );
    }
  }

  // ── 3. whose areas are whose ───────────────────────────────────────────────────────────────
  {
    const keys = weeklyScopeOwnAreaKeys(UE2_DM_SCOPE);
    assert.deepEqual(
      [...keys].sort(),
      ["UE3", "UE4", "UE5", "UE6", "UE7", "UE8"].map((area) => fieldForceKey(AI, area)),
      "a manager's own keys are his lines × his seat areas, keyed as the grid keys a seat",
    );
    assert.equal(mayLiftWeeklyGeography(UE2_DM_SCOPE, keys), true, "a region-bound manager with known areas lifts");
    assert.equal(
      weeklyScopeOwnAreaKeys({ ...UE2_DM_SCOPE, allowedLineNames: null }).size,
      0,
      "no line bound = no key to narrow by, so the load must not lift",
    );
    assert.equal(
      mayLiftWeeklyGeography({ ...UE2_DM_SCOPE, allowedRegionCodes: null }, keys),
      false,
      "a viewer with no region bound has nothing to lift",
    );
    assert.equal(mayLiftWeeklyGeography(UE2_REP_SCOPE, new Set()), false, "unknown own areas never lift");
    assert.equal(weeklyScopeOwnAreaKeys(UE2_REP_SCOPE).size, 0, "a rep's scope has no area bound — his keys come from his seats");
    const full: WeeklyAccessScope = { tier: "full", canViewRestricted: true, canViewHeadOffice: true };
    const product: WeeklyAccessScope = { tier: "product", productCodes: new Set(["AI01"]), canViewHeadOffice: false };
    assert.equal(mayLiftWeeklyGeography(full, keys), false, "a company-wide viewer never lifts");
    assert.equal(mayLiftWeeklyGeography(product, keys), false, "a product-scoped viewer never lifts");

    // A medical rep's keys are his own filled seats, picked by his own Weekly Sales screen's selector.
    const seats = INDEX.seats;
    assert.deepEqual(
      [...(await resolveWeeklyOwnAreaKeys(viewer("A-105"), UE2_REP_SCOPE, seats))],
      [fieldForceKey(AI, "UE5")],
      "a seat on a line outside his scope is never his — his CNS seat stays off an Anti Infective screen",
    );
    assert.deepEqual(
      [...(await resolveWeeklyOwnAreaKeys(viewer("A-105"), { ...UE2_REP_SCOPE, allowedLineNames: null }, seats))].sort(),
      [fieldForceKey("CNS", "UE5"), fieldForceKey(AI, "UE5")].sort(),
      "with no line bound every line he is seated on counts",
    );
    const [occupied] = selectFieldForceSeats([repSeat("UE7", "UE-2", "A-107")], () => null).seats;
    assert.deepEqual(
      [...(await resolveWeeklyOwnAreaKeys(viewer("A-107"), UE2_REP_SCOPE, [occupied]))],
      [fieldForceKey(AI, "UE7")],
      "an occupied seat is its occupant's",
    );
    assert.equal(
      (await resolveWeeklyOwnAreaKeys(viewer("A-107"), UE2_REP_SCOPE, [{ ...occupied, isVacant: true }])).size,
      0,
      "a seat flagged vacant is nobody's, even while it still names an occupant",
    );
    assert.equal((await resolveWeeklyOwnAreaKeys(viewer("Z-404"), UE2_REP_SCOPE, seats)).size, 0, "an unknown viewer owns nothing");
    assert.equal(
      (await resolveWeeklyOwnAreaKeys(viewer("A-105", "Regional Manager"), UE2_REP_SCOPE, seats)).size,
      0,
      "only a medical rep's own seats stand in for an area bound",
    );
    assert.deepEqual(
      [...(await resolveWeeklyOwnAreaKeys(viewer("A-902", "District Manager"), UE2_DM_SCOPE, seats))].sort(),
      [...keys].sort(),
      "a manager's own keys come from his seat's areas",
    );
    assert.equal(
      (await resolveWeeklyOwnAreaKeys(viewer("A-105"), { ...UE2_REP_SCOPE, allowedRegionCodes: null }, seats)).size,
      0,
      "with no region bound there is nothing to lift, so no own keys are resolved",
    );
    assert.equal((await resolveWeeklyOwnAreaKeys(viewer("A-105"), full, seats)).size, 0, "a company-wide viewer resolves no own keys");
  }

  // ── 4. the lift itself ─────────────────────────────────────────────────────────────────────
  {
    const lifted = liftWeeklyGeography(UE2_DM_SCOPE);
    assert.notEqual(lifted, UE2_DM_SCOPE, "a region-bound territory scope comes back lifted");
    assert.equal(lifted.tier === "territory" ? lifted.allowedRegionCodes : "not territory", null, "the region bound is gone");
    assert.equal(lifted.tier === "territory" ? lifted.allowedAreaCodes : "not territory", null, "the area bound is gone");
    assert.equal(
      lifted.tier === "territory" ? lifted.allowedLineNames : null,
      UE2_DM_SCOPE.allowedLineNames,
      "the LINE bound stays — a lift never reaches another line",
    );
    assert.equal(lifted.canViewHeadOffice, false, "and Head Office stays out");
    assert.equal(UE2_DM_SCOPE.allowedRegionCodes.size, 1, "the viewer's own scope is not mutated");
    const full: WeeklyAccessScope = { tier: "full", canViewRestricted: false, canViewHeadOffice: false };
    assert.equal(liftWeeklyGeography(full), full, "every other tier comes back as the same object");
    const unbound: WeeklyAccessScope = { ...UE2_DM_SCOPE, allowedRegionCodes: null, allowedAreaCodes: null };
    assert.equal(liftWeeklyGeography(unbound), unbound, "a scope with nothing to lift comes back as the same object");
  }

  // ── 5. Weekly Stock keeps a depot WHOLE when it serves one of his areas ────────────────────
  {
    const ownSohag = stockRow({ regionCode: "UE-2", regionName: "Upper Egypt 2", branchName: SOHAG, branchCode: "S1" });
    const ueMinyaAssiut = stockRow({ branchCode: "M1" });
    const ueSohag = stockRow({ branchName: SOHAG, branchCode: "S2" });
    const uePinnedUe1 = stockRow({ areaCode: "UE1", branchName: "Minia hand-mapped", branchCode: "P1" });
    const ueWarehouse = stockRow({ branchName: WAREHOUSE, branchCode: "W1" });
    const rows = [ownSohag, ueMinyaAssiut, ueSohag, uePinnedUe1, ueWarehouse];

    const dm = admitWeeklyStockRows(rows, {
      bound: UE2_DM_SCOPE,
      ownAreaKeys: weeklyScopeOwnAreaKeys(UE2_DM_SCOPE),
      areaSplit: SPLIT,
    });
    // HEADLINE — the depots that stock his areas are on his screen, and no other.
    assert.deepEqual(dm, [ownSohag, ueMinyaAssiut, ueSohag], "his own depot, and the UE depots serving Assiut and Sohag");
    assert.equal(dm[1], ueMinyaAssiut, "the depot row itself, never a share of a shelf");
    assert.equal(dm[1].stockUnits, 60, "a shelf's stock is one stock — never cut by area");
    assert.ok(!dm.includes(uePinnedUe1), "a depot pinned to Upper Egypt 1 stays Upper Egypt 1's");
    assert.ok(!dm.includes(ueWarehouse), "a warehouse is never spread, so it reaches him only through his own scope");

    const rep = admitWeeklyStockRows(rows, {
      bound: UE2_REP_SCOPE,
      ownAreaKeys: await resolveWeeklyOwnAreaKeys(viewer("A-105"), UE2_REP_SCOPE, INDEX.seats),
      areaSplit: SPLIT,
    });
    assert.deepEqual(rep, [ownSohag, ueSohag], "the Sohag 1 rep gains the UE depot serving Sohag, not the Minia+Assiut one");
    assert.deepEqual(
      admitWeeklyStockRows(rows, { bound: UE2_REP_SCOPE, ownAreaKeys: new Set(), areaSplit: SPLIT }),
      [ownSohag],
      "with no own areas nothing beyond his own scope is admitted",
    );
  }

  // ── 5b. a lifted Weekly Stock load filters products after the narrowing ────────────────────
  {
    const rows = [{ productCode: "AI01" }, { productCode: " ai02 " }, { productCode: "AI03" }];
    const keep = (filters: Parameters<typeof weeklyStockProductPredicate>[0]) =>
      rows.filter(weeklyStockProductPredicate(filters)).map((row) => row.productCode.trim().toUpperCase());
    assert.deepEqual(
      keep({ productCodes: [" ai02", "AI03"] }),
      ["AI02", "AI03"],
      "include keeps only the chosen products, codes compared the way the load compares them",
    );
    assert.deepEqual(keep({ productCodes: ["AI02"], productFilterMode: "exclude" }), ["AI01", "AI03"], "exclude drops the chosen products");
    assert.deepEqual(keep({ productCodes: ["  "], productFilterMode: "include" }), ["AI01", "AI02", "AI03"], "no real code keeps everything");
    assert.deepEqual(keep({}), ["AI01", "AI02", "AI03"], "no filter keeps everything");

    const own = [{ code: "IBS", name: "Ibn Sina" }];
    assert.equal(
      withExtraWeeklyOptions(own, [{ code: " ibs ", name: "Ibn Sina Pharma" }]),
      own,
      "nothing new = the same list, untouched",
    );
    assert.deepEqual(
      withExtraWeeklyOptions(own, [
        { code: "ucp", name: "United Company" },
        { code: "UCP", name: "a second spelling" },
        { code: " ", name: "a row with no code" },
        { code: "ALX", name: "Alexandria Pharma" },
      ]),
      [
        { code: "ALX", name: "Alexandria Pharma" },
        { code: "IBS", name: "Ibn Sina" },
        { code: "UCP", name: "United Company" },
      ],
      "every code his narrowed depots carry is offered once, named from its first row, the whole list sorted by name",
    );
  }

  // ── 6. his grid's upload-gap flags are per depot, over the money that counts for him ──────────
  // Measured 2026-09-17 on Delta (3)'s Anti Infective August tab: Ibn Sina-Sato and Overseas sent no
  // week-2 sheet, while a POS return landed in one of her areas in week 2. Pooled over the load, every
  // week looked uploaded, so week 3, which held two weeks of those two depots' sales, had no flag.
  {
    const sheet = (distributorCode: string, weekNumber: number, overrides: Partial<LoadRow> = {}) =>
      loadRow({ distributorCode, weekNumber, weekStart: `2026-09-0${weekNumber}`, ...overrides });
    const ownSohag = { regionCode: "UE-2", regionName: "Upper Egypt 2", branchName: SOHAG };
    const loaded = [
      // Ibn Sina-Sato and Overseas skipped week 2. Their UE Minia+Assiut books give each Assiut area a quarter.
      sheet("IS-S", 1, { salesValue: 4000, netQty: 40 }),
      sheet("IS-S", 3, { salesValue: 8000, netQty: 80 }),
      sheet("IS-S", 4, { salesValue: 4000, netQty: 40 }),
      sheet("PS", 1, { salesValue: 2000, netQty: 20 }),
      sheet("PS", 3, { salesValue: 2000, netQty: 20 }),
      // POS sent weeks 1 to 3. Its week 2 is a return, and a quarter of it lands in each Assiut area.
      sheet("POS", 1, { salesValue: 800, netQty: 8 }),
      sheet("POS", 2, { salesValue: -888, netQty: -8 }),
      sheet("POS", 3, { salesValue: 800, netQty: 8 }),
      // Ibn Sina's Sohag book is his own region's, both halves his, and it skipped nothing.
      sheet("IBS", 1, { ...ownSohag, salesValue: 1000, netQty: 10 }),
      sheet("IBS", 2, { ...ownSohag, salesValue: 1000, netQty: 10 }),
      sheet("IBS", 3, { ...ownSohag, salesValue: 1000, netQty: 10 }),
      // EGD's first sheet of the month is week 5, so it holds weeks 1 to 5, but it reaches Minia 2 alone.
      sheet("EG", 5, { areaCode: "UE2", branchName: "Minia hand-mapped", salesValue: 500, netQty: 5 }),
    ];
    const ownAreaKeys = weeklyScopeOwnAreaKeys(UE2_DM_SCOPE);
    // As the screen builds it: the gaps are read over every loaded row, the grid over his own-area rows.
    const grid = (rows: LoadRow[]) =>
      buildPortalWeeklyFieldForce({
        rows: narrowWeeklyRowsToOwnAreaShare(rows, UE2_DM_SCOPE, share(ownAreaKeys)).map(toFactRow),
        areaSplit: SPLIT,
        seatIndex: INDEX,
        depotWeekGaps: depotWeekGaps(rows),
      });
    const flagsByArea = (built: PortalWeeklyFieldForce) =>
      Object.fromEntries(built.reps.filter((rep) => rep.areaCode).map((rep) => [rep.areaCode as string, rep.gapWeekNumbers]));

    assert.deepEqual(
      depotWeekGaps(loaded).map((gap) => `${gap.distributorCode} week ${gap.weekNumber}`),
      ["EG week 5", "IS-S week 3", "PS week 3"],
      "fixture: three depot weeks span a gap",
    );
    const dm = grid(loaded);

    // HEADLINE: week 3 is flagged, although POS's sheet means some depot sent every week before it.
    assert.deepEqual(dm.gapWeekNumbers, [3], "a week is flagged when a depot whose money counts for him skipped the week before");
    assert.equal(dm.reps.find((rep) => rep.areaCode === "UE3")?.valueByWeek[2], -222, "fixture: POS's return is money in his area in week 2");

    // HEADLINE: each row carries its own depots' flags, never the grid's.
    assert.deepEqual(
      flagsByArea(dm),
      { UE3: [3], UE4: [3], UE5: [], UE6: [] },
      "Assiut's week 3 holds the skipping depots' money; Sohag's depot skipped nothing, so Sohag is not flagged",
    );

    // HEADLINE: a week no counting row carries is not a column, and a gap there is not his.
    assert.deepEqual(dm.weekNumbers, [1, 2, 3, 4], "EGD's week 5 reaches only Minia 2, so it is no column on his grid");

    // A gapped depot row that moves no money cannot make a figure read high.
    const stockOnly = sheet("RM", 4, { ...ownSohag, stockQty: 60 });
    assert.deepEqual(
      depotWeekGaps([...loaded, stockOnly]).filter((gap) => gap.distributorCode === "RM").map((gap) => gap.weekNumber),
      [4],
      "fixture: ramco's first sheet of the month is week 4",
    );
    assert.deepEqual(grid([...loaded, stockOnly]).gapWeekNumbers, [3], "a stock-only row from a gapped depot week flags nothing");

    // The same first sheet with sales in his areas holds weeks 1 to 4, and is flagged where it lands.
    const sold = grid([...loaded, { ...stockOnly, salesValue: 600, netQty: 6 }]);
    assert.deepEqual(sold.gapWeekNumbers, [3, 4], "a depot's first sheet after week 1 is flagged once its money reaches him");
    assert.deepEqual(flagsByArea(sold), { UE3: [3], UE4: [3], UE5: [4], UE6: [4] }, "on the rows it reached, and no others");
  }

  // ── 7. the wiring — every surface reads the same own-area rows before a figure is built ────
  {
    const service = readSource("../src/lib/sales/weekly/service.ts");
    assert.match(
      service,
      /const ownAreaShare = filters\?\.ownAreaShare \? await filters\.ownAreaShare : null;\s+const visibleRows = ownAreaShare\s+\? narrowWeeklyRowsToOwnAreaShare\(realRows, accessScope, ownAreaShare\)\s+: applyWeeklyAccessScope\(realRows, accessScope\);/,
      "the loader chooses a manager's rows ONCE, before every aggregate, option list and row grain",
    );
    assert.match(
      service,
      /const grainScope =\s+filters\?\.liftRowGrainGeography && !ownAreaShare \? liftWeeklyGeography\(accessScope\) : accessScope;/,
      "and never re-reads his rows without the bound when they already follow his areas",
    );
    assert.match(service, /\.\.\.\(row\.areaBasis \? \{ areaBasis: row\.areaBasis \} : \{\}\)/, "each row grain row says how it reached him");
    const seatLoad = functionBody(readSource("../src/lib/sales/weekly/portal-weekly-field-force.ts"), "loadFieldForceSeatIndex");
    assert.match(
      seatLoad,
      /from\("au_v_line_area_map"\)\.select\("line_code,area_code,dm_seat_id"\)\.is\("effective_to", null\)/,
      "the seat index reads which manager owns each area today",
    );
    assert.match(
      seatLoad,
      /lineAreaResult\.error \? undefined : \(\(lineAreaResult\.data \?\? \[\]\) as FieldForceLineAreaRow\[\]\)/,
      "and hands it to the index, leaving ownership unknown when the map cannot be read",
    );

    const portal = readSource("../src/lib/sales/weekly/portal-weekly-dashboard.ts");
    const tab = functionBody(portal, "getPortalWeeklyDashboard");
    assert.match(tab, /const ownAreaKeys = weeklyScopeOwnAreaKeys\(scope\.accessScope\);/, "the manager's screen takes his own areas whether or not the tab is open");
    assert.match(tab, /const followsOwnAreas = mayLiftWeeklyGeography\(scope\.accessScope, ownAreaKeys\);/, "only when there is a region bound and own areas to follow");
    assert.match(
      tab,
      /includeFactRows: includeFieldForce,\s+(?:\/\/[^\n]*\n\s+)*factRowsFullPrecision: includeFieldForce,\s+ownAreaShare,\s+\}\)/,
      "the screen's load follows them, and the tab sums them unrounded, so the KPIs, the export and the tab agree to the pound",
    );
    assert.match(tab, /computeWeeklyComparison\(filters, scope, trimmed, ownAreaShare\)/, "last month's movers follow the same areas");
    assert.match(tab, /trimWeeklyFilterOptions\(data, scope, followsOwnAreas\)/, "his region list names the organogram regions his rows carry");
    assert.doesNotMatch(tab, /liftRowGrainGeography/, "the tab no longer lifts a grain of its own");
    assert.match(
      tab,
      /const \{ factRows: _factRows, factRowDepotWeekGaps: _factRowDepotWeekGaps, \.\.\.clientSafe \} = trimmed;/,
      "neither the row grain nor the depot gap list, which names depots beyond his scope, reaches the browser",
    );
    assert.match(tab, /depotWeekGaps:\s*data\.factRowDepotWeekGaps \?\? \[\],/, "the grid is flagged per depot");
    const comparison = portal.slice(portal.indexOf("async function computeWeeklyComparison("), portal.indexOf("export type PortalWeeklyFilters"));
    assert.match(comparison, /allWeeks: true,\s+ownAreaShare,\s+\}\)/, "the comparison load passes the share on");

    const month = functionBody(portal, "getPortalWeeklyMonthFieldForce");
    assert.match(month, /resolveWeeklyOwnAreaKeys\(/, "the month grid resolves a medical rep's own seats");
    assert.match(month, /includeFactRows: true,\s+ownAreaShare,/, "and follows his own areas");
    assert.doesNotMatch(month, /liftRowGrainGeography/, "with no lifted grain of its own");
    assert.match(month, /depotWeekGaps:\s*data\.factRowDepotWeekGaps \?\? \[\],/, "and flags per depot");
    assert.match(
      readSource("../src/lib/sales/weekly/portal-weekly-rep.ts"),
      /depotWeekGaps:\s*dashboard\.factRowDepotWeekGaps \?\? \[\],/,
      "a medical rep's line-wide grid is flagged per depot too",
    );
    assert.match(month, /excludeUnmapped:\s*true/, "owner rule: every weekly report leaves unmapped products out");

    const exportRoute = readSource("../app/api/employee-portals/weekly-sales/export/route.ts");
    assert.match(exportRoute, /getPortalWeeklyDashboard\(/, "the Distribution export reads the same own-area screen");

    const pace = readSource("../src/lib/sales/sos-month-pace-loader.ts");
    assert.match(pace, /getPortalWeeklyMonthFieldForce\(/, "the month-pace strip reads the own-area month grid");
    assert.doesNotMatch(pace, /getPortalWeeklyDashboard\(/, "never the region-bound dashboard again");

    const stock = readSource("../src/lib/sales/weekly/stock-dashboard-service.ts");
    const stockLoad = functionBody(stock, "loadWeeklyStockDashboard");
    assert.match(stockLoad, /liftRowGrainGeography:\s*liftGrain/, "Weekly Stock loads its depots lifted");
    assert.match(stockLoad, /admitWeeklyStockRows\(/, "and narrows them to the depots serving his own areas");
    assert.match(stockLoad, /buildWeeklyStockView\(stockRows,/, "before the view is built");
    assert.match(
      stockLoad,
      /productCodes:\s*productFilterInLoad \? filters\.productCodes : undefined/,
      "a lifted load does not filter products inside the load",
    );
    assert.match(
      stockLoad,
      /scopedStockRows\.filter\(weeklyStockProductPredicate\(filters\)\)/,
      "it filters them after the narrowing instead",
    );
    assert.match(
      stockLoad,
      /withExtraWeeklyOptions\(\s*scopedProducts,\s*scopedStockRows\.map/,
      "and reads the product list before that filter, so choosing one product never hides the others",
    );

    assert.match(service, /factRows: filters\?\.includeFactRows\s*\?\s*grainWeekRowsAdj\.map/, "factRows come from the grain the caller asked for");
    assert.match(service, /stockRows: filters\?\.includeStockRows\s*\?\s*grainScopedRows\.map/, "and so do stockRows");
    assert.match(
      service,
      /const depotGaps = depotWeekGaps\(allRows\);[\s\S]*factRowDepotWeekGaps: filters\?\.includeFactRows \? depotGaps : undefined,/,
      "depot calendars are read over every loaded row, the set de-cumulation subtracted from, never a scoped grain",
    );
    assert.match(
      service,
      /applyWeeklyAccessScope\(realRows, grainScope\)[\s\S]{0,120}\.filter\(passesRowFilters\)/,
      "a lifted Weekly Stock grain passes exactly the filters the viewer's own rows pass",
    );
  }
}
