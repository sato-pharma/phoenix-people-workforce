import assert from "node:assert/strict";

import {
  buildPortalWeeklyFieldForce,
  fieldForceKey,
  selectFieldForceSeats,
  type FieldForceSeatRow,
} from "../src/lib/sales/weekly/portal-weekly-field-force.ts";
import type { WeeklyFactExportRow } from "../src/lib/sales/weekly/types.ts";

// The Field Force tab turns depot rows into "which of my medical reps sold what, week by week".
// Three things about it are load-bearing and none of them is visible on screen when it breaks:
//
//   1. (line, area) -> rep is keyed WITH the line. The same area is a different person on CNS than
//      on Pedia, so an area-only key silently credits one line's sales to another line's rep.
//   2. Units are never summed across products (owner rule). A rep total is EGP; a unit figure is
//      only ever produced under one product code.
//   3. A number placed by reading a depot NAME is an allocation, not an observation. The exact and
//      allocated halves must stay separable, or the screen presents an estimate as a measurement.

const SEATS: FieldForceSeatRow[] = [
  {
    seat_id: "SEAT-CNS-DM-AB",
    seat_tier: "DM",
    line_code: "cns",
    line_name: "CNS",
    region_code: "AB",
    region_name: "Alex-BHR",
    occupant_hr_id: "b-900",
    is_vacant: false,
  },
  {
    seat_id: "SEAT-CNS-REP-AB1",
    seat_tier: "REP",
    line_code: "cns",
    line_name: "CNS",
    region_code: "AB",
    region_name: "Alex-BHR",
    area_code: "AB1",
    area_name: "Alex East",
    occupant_hr_id: "B-135",
    is_vacant: false,
    parent_seat_id: "SEAT-CNS-DM-AB",
  },
  {
    seat_id: "SEAT-CNS-REP-AB2",
    seat_tier: "REP",
    line_code: "cns",
    line_name: "CNS",
    region_code: "AB",
    region_name: "Alex-BHR",
    area_code: "AB2",
    area_name: "Alex Center",
    occupant_hr_id: null,
    is_vacant: true,
    parent_seat_id: "SEAT-CNS-DM-AB",
  },
  // Same AREA CODE as the CNS rep above, different line and a different person. This row is the
  // whole reason the index is keyed by (line, area) and never by area alone.
  {
    seat_id: "SEAT-PEDIA-REP-AB1",
    seat_tier: "REP",
    line_code: "pedia",
    line_name: "Pedia",
    region_code: "AB",
    region_name: "Alex-BHR",
    area_code: "AB1",
    area_name: "Alex East",
    occupant_hr_id: "P-200",
    is_vacant: false,
  },
  // The per-line "Others" pseudo-DM holds no real people and must never become a rep row.
  {
    seat_id: "SEAT-CNS-REP-OTHER",
    seat_tier: "REP",
    line_code: "cns",
    line_name: "CNS",
    area_code: "OT9",
    area_name: "Others",
    occupant_hr_id: "B-999",
    is_vacant: false,
    is_other_pseudo_dm: true,
  },
];

// Keyed LOWERCASE on purpose. HR ids are mixed case in this database, and every seat row above
// spells one differently from the next ("B-135" vs "b-900") because production does too. The index
// normalizes an occupant id through normalizeHrId before it ever looks a name up, so a directory
// keyed any other way would return null for a rep who plainly exists — which is exactly how a real
// notification once shipped addressed to "Medical rep pd-0005".
const NAMES: Record<string, string> = {
  "b-135": "Mahmoud Fathy",
  "p-200": "Nourhan Adel",
  "b-900": "Karim Selim",
};
const nameOf = (hrId: string | null) => (hrId ? (NAMES[hrId] ?? null) : null);

function factRow(overrides: Partial<WeeklyFactExportRow>): WeeklyFactExportRow {
  return {
    distributorCode: "POS",
    distributorName: "POS",
    productCode: "P1",
    productName: "Tebofortin 40mg",
    line: "CNS",
    regionCode: "AB",
    regionName: "Alex-BHR",
    areaCode: null,
    branchCode: "BR1",
    branchName: "Alex Branch",
    cycleMonth: "2026-08-01",
    weekNumber: 1,
    weekStart: "2026-08-03",
    batchId: "batch-1",
    family: "Tebofortin",
    salesValue: 0,
    salesUnits: 0,
    stockUnits: 0,
    ...overrides,
  };
}

export function runWeeklyFieldForceTests() {
  // ── 1. the seat index ──────────────────────────────────────────────────────────────────────
  const index = selectFieldForceSeats(SEATS, nameOf);

  assert.equal(
    index.byLineArea.get(fieldForceKey("CNS", "AB1"))?.repName,
    "Mahmoud Fathy",
    "(line, area) resolves to the rep who covers that area ON THAT LINE",
  );
  assert.equal(
    index.byLineArea.get(fieldForceKey("Pedia", "AB1"))?.repName,
    "Nourhan Adel",
    "the SAME area code on another line is a different person — keying by area alone would cross-credit two lines",
  );
  assert.equal(
    index.byLineArea.get(fieldForceKey("Anti infective", "AB1")),
    undefined,
    "a line with no seat for the area resolves to nothing rather than borrowing another line's rep",
  );
  assert.equal(
    index.byLineArea.get(fieldForceKey("CNS", "AB2"))?.isVacant,
    true,
    "a seat nobody occupies is VACANT, which is different from absent — the area still exists and can still sell",
  );
  assert.equal(
    index.byLineArea.get(fieldForceKey("CNS", "AB2"))?.repName,
    null,
    "a vacant seat has no rep name; the screen shows the area, never an HR id",
  );
  assert.equal(
    index.byLineArea.get(fieldForceKey("CNS", "OT9")),
    undefined,
    "the per-line Others pseudo-DM holds no real people and never becomes a rep row",
  );
  assert.equal(
    index.byLineArea.get(fieldForceKey("CNS", "AB1"))?.managerName,
    "Karim Selim",
    "the DM above the rep is resolved through parent_seat_id, so an NSM can group his reps by district",
  );
  assert.equal(
    index.byLineArea.get(fieldForceKey("CNS", "AB1"))?.repHrId,
    "b-135",
    "the seat's mixed-case 'B-135' is normalized before any name lookup — an un-normalized key silently yields no name at all",
  );

  // The line key must survive every spelling the reference data actually uses. `au.lines` seeds
  // Anti Infective with a lower-case i, and a case-sensitive compare drops that line's reps whole.
  assert.equal(
    fieldForceKey("Anti infective", "UE1"),
    fieldForceKey("anti_infective", "ue1"),
    "line spellings collapse to one key — 'Anti infective', 'anti_infective' and 'Anti-Infective' are one line",
  );
  assert.equal(fieldForceKey("", "AB1"), "", "a blank line yields no key, so it can never match a seat");
  assert.equal(fieldForceKey("CNS", null), "", "a missing area yields no key rather than matching everything");

  // ── 2. attribution, and the exact / allocated split ────────────────────────────────────────
  const built = buildPortalWeeklyFieldForce({
    rows: [
      // Hand-mapped branch: the owner pinned the area, so this credit is EXACT.
      factRow({ areaCode: "AB1", weekNumber: 1, salesValue: 1000, salesUnits: 10 }),
      factRow({ areaCode: "AB1", weekNumber: 2, salesValue: 500, salesUnits: 5 }),
      // A second product for the same rep — the reason a rep-level unit total is meaningless.
      factRow({
        areaCode: "AB1",
        productCode: "P2",
        productName: "Conviban 10mg",
        family: "Conviban",
        weekNumber: 1,
        salesValue: 300,
        salesUnits: 7,
      }),
      // Vacant seat still sells: the area has money and no person in it.
      factRow({ areaCode: "AB2", weekNumber: 1, salesValue: 200, salesUnits: 2 }),
      // An area no line seats. Reaches no rep and must still be reported, never dropped.
      factRow({ areaCode: "ZZ9", weekNumber: 1, salesValue: 90, salesUnits: 1 }),
    ],
    // No split index: nothing is placed by name, so every credit here is a hand mapping.
    areaSplit: null,
    seatIndex: index,
    depotWeekGaps: [],
  });

  const mahmoud = built.reps.find((rep) => rep.repName === "Mahmoud Fathy");
  assert.ok(mahmoud, "the rep who covers AB1 on CNS appears as a row");
  assert.equal(mahmoud.value, 1800, "a rep's total is the EGP of every product he sold");
  assert.equal(mahmoud.valueByWeek[1], 1300, "week 1 sums BOTH products' value — money is addable across products");
  assert.equal(mahmoud.valueByWeek[2], 500, "week 2 carries only what was sold that week");
  assert.equal(mahmoud.exactValue, 1800, "a branch mapped by hand credits the rep exactly");
  assert.equal(mahmoud.allocatedValue, 0, "nothing here was placed by reading a depot name");

  // Rule 2, the one that cannot be recovered once broken: units belong to ONE product code.
  assert.equal(mahmoud.products.length, 2, "each product the rep sold is its own row");
  const tebo = mahmoud.products.find((product) => product.productCode === "P1");
  const conviban = mahmoud.products.find((product) => product.productCode === "P2");
  assert.equal(tebo?.units, 15, "units total WITHIN one product code, which is the only level they mean anything");
  assert.equal(tebo?.unitsByWeek[1], 10, "a product's week cell is that product's units in that week");
  assert.equal(conviban?.units, 7, "the second product keeps its own units, never merged into the first");
  assert.ok(
    !Object.prototype.hasOwnProperty.call(mahmoud, "units"),
    "a rep carries NO unit total — 15 Tebofortin plus 7 Conviban is not 22 of anything (owner rule)",
  );

  const vacant = built.reps.find((rep) => rep.kind === "vacant");
  assert.equal(vacant?.value, 200, "a vacant area's sales are kept and shown against the area");
  assert.ok(
    vacant?.label.includes("Alex Center"),
    "a vacant row is named by its AREA, so the reader sees which territory has no one in it",
  );
  assert.equal(built.totals.vacantAreasWithSales, 1, "vacant areas that sold are counted for the KPI strip");

  const residue = built.reps.find((rep) => rep.kind === "unattributed");
  assert.equal(residue?.value, 90, "money reaching no rep is bucketed and reported, never silently dropped");
  assert.equal(built.totals.unattributedValue, 90, "the residue is stated as its own total");
  assert.equal(
    built.totals.value,
    2090,
    "every row on screen adds to the same total the KPI strip above it shows — 1800 + 200 + 90",
  );
  assert.equal(built.totals.repsWithSales, 1, "only occupied seats with sales count as a rep who sold");

  // The attribution strip draws these three as one stacked bar, so they MUST partition the total.
  // They did not: the residue's money was counted a second time inside exact/allocated, which drew a
  // 108%-wide bar and printed the same quantity twice at two percentages (30.3% beside 27.8%) on the
  // live company-scope screen. Pinned here because nothing else can see it — the bar overflows its
  // own container silently, and both numbers look individually plausible.
  assert.equal(
    built.totals.exactValue + built.totals.allocatedValue + built.totals.unattributedValue,
    built.totals.value,
    "exact + allocated + residue is the whole of value and never more — the strip is one stacked bar",
  );
  assert.equal(
    built.totals.exactValue + built.totals.allocatedValue,
    2000,
    "the residue is excluded from exact/allocated: 1800 mapped + 200 vacant, with its own 90 apart",
  );

  // Real reps first, then vacant seats, then the residue. The residue is never the headline row.
  assert.deepEqual(
    built.reps.map((rep) => rep.kind),
    ["rep", "vacant", "unattributed"],
    "ordering puts people first and the unattributable bucket last",
  );

  // ── 3. an allocated credit is marked as allocated ──────────────────────────────────────────
  // Same rep, but the row carries NO area: it can only be placed by reading the depot name, which
  // is an allocation. splitWeeklyRowsByBranch needs a real index to do that, so the behaviour under
  // test here is the tagging — a row that arrives without an area is never counted as exact.
  const allocated = buildPortalWeeklyFieldForce({
    rows: [
      factRow({ areaCode: "AB1", weekNumber: 1, salesValue: 400, salesUnits: 4 }),
      factRow({ areaCode: null, weekNumber: 1, salesValue: 600, salesUnits: 6 }),
    ],
    areaSplit: null,
    seatIndex: index,
    depotWeekGaps: [],
  });
  const exactRep = allocated.reps.find((rep) => rep.repName === "Mahmoud Fathy");
  assert.equal(exactRep?.exactValue, 400, "only the hand-mapped row counts as exact credit");
  assert.equal(
    allocated.totals.unattributedValue,
    600,
    "with no split index an area-less row reaches no rep at all, rather than being guessed onto one",
  );

  // ── 4. the product axis and the gap flag ───────────────────────────────────────────────────
  const axed = buildPortalWeeklyFieldForce({
    rows: [
      factRow({ areaCode: "AB1", weekNumber: 1, salesValue: 10, salesUnits: 1 }),
      factRow({ areaCode: "AB1", productCode: "P2", productName: "Conviban 10mg", weekNumber: 3, salesValue: 20, salesUnits: 2 }),
    ],
    areaSplit: null,
    seatIndex: index,
    // The supplied universe is wider than what sold; the axis narrows to what is present but keeps
    // the given ORDER, so column N is the same product in every scope.
    productAxis: [
      { code: "P2", name: "Conviban 10mg" },
      { code: "P9", name: "Never sold" },
      { code: "P1", name: "Tebofortin 40mg" },
    ],
    // POS sent no sheet for week 2, so its week-3 figure holds weeks 2 and 3.
    depotWeekGaps: [{ distributorCode: "POS", cycleMonth: "2026-08-01", weekNumber: 3 }],
  });
  assert.deepEqual(
    axed.productAxis.map((product) => product.code),
    ["P2", "P1"],
    "the axis keeps the supplied order and drops products that did not sell — never reorders per view",
  );
  assert.deepEqual(axed.weekNumbers, [1, 3], "week columns are the weeks actually present, ascending");
  assert.deepEqual(
    axed.gapWeekNumbers,
    [3],
    "a week holding money from a depot that skipped the week before is FLAGGED, because its de-cumulated figure spans the gap and reads high",
  );

  // One rule on every Field Force tab (owner, 2026-09-17), including the ones whose load is not lifted:
  // another depot's sheet for the missing week does not clear the flag.
  const pooledWouldHide = buildPortalWeeklyFieldForce({
    rows: [
      factRow({ areaCode: "AB1", weekNumber: 1, salesValue: 10, salesUnits: 1 }),
      factRow({ distributorCode: "IS", distributorName: "Ibn sina", areaCode: "AB1", weekNumber: 2, salesValue: 15, salesUnits: 1 }),
      factRow({ areaCode: "AB1", weekNumber: 3, salesValue: 20, salesUnits: 2 }),
    ],
    areaSplit: null,
    seatIndex: index,
    depotWeekGaps: [{ distributorCode: "POS", cycleMonth: "2026-08-01", weekNumber: 3 }],
  });
  assert.deepEqual(pooledWouldHide.weekNumbers, [1, 2, 3], "fixture: some depot sent every week");
  assert.deepEqual(pooledWouldHide.gapWeekNumbers, [3], "POS skipped week 2, so week 3 is flagged although Ibn sina sent week 2");
  assert.deepEqual(
    buildPortalWeeklyFieldForce({ rows: [factRow({ areaCode: "AB1", weekNumber: 3, salesValue: 20, salesUnits: 2 })], areaSplit: null, seatIndex: index })
      .gapWeekNumbers,
    [],
    "with no depot gaps supplied nothing is flagged, so every loader must pass them",
  );

  // ── 5. failing soft ────────────────────────────────────────────────────────────────────────
  const noSeats = buildPortalWeeklyFieldForce({
    rows: [factRow({ areaCode: "AB1", salesValue: 100, salesUnits: 1 })],
    areaSplit: null,
    seatIndex: { byLineArea: new Map(), seats: [] },
    depotWeekGaps: [],
  });
  assert.equal(
    noSeats.seatIndexUnavailable,
    true,
    "an unreadable org tree is reported as such, so the screen says 'we cannot say who' instead of showing zero reps",
  );
  assert.equal(
    noSeats.totals.unattributedValue,
    100,
    "with no seat model the money is still counted — it is unattributed, not lost",
  );

  // ── 6. an area only a district manager covers is HIS row, never "Not attributed" ─────────────
  // Owner, 2026-10-20, asked and answering "Show under his name": Karim Selim's CNS district owns
  // area AB7 with no rep seat under it. Its sales are his row; a vacant district's area and an area
  // nobody owns stay in the residue; the line total does not move.
  const withManagerArea = selectFieldForceSeats(SEATS, nameOf, [
    { line_code: "cns", area_code: "AB7", dm_seat_id: "SEAT-CNS-DM-AB" },
    { line_code: "cns", area_code: "AB1", dm_seat_id: "SEAT-CNS-DM-AB" },
  ]);
  assert.equal(
    withManagerArea.managerOnlyAreas?.get(fieldForceKey("CNS", "AB7"))?.managerName,
    "Karim Selim",
    "the district manager is named on his rep-less area",
  );
  assert.equal(
    withManagerArea.managerOnlyAreas?.has(fieldForceKey("CNS", "AB1")),
    false,
    "an area with a rep seat stays the rep's",
  );
  const managerGrid = buildPortalWeeklyFieldForce({
    rows: [
      factRow({ areaCode: "AB7", salesValue: 70, salesUnits: 7 }),
      factRow({ areaCode: "ZZ9", salesValue: 30, salesUnits: 3 }),
      factRow({ areaCode: "AB1", salesValue: 50, salesUnits: 5 }),
    ],
    areaSplit: null,
    seatIndex: withManagerArea,
    depotWeekGaps: [],
  });
  const managerRow = managerGrid.reps.find((row) => row.kind === "manager");
  assert.equal(managerRow?.label, "Karim Selim — AB7, no rep seat");
  assert.equal(managerRow?.managerName, "Karim Selim", "it groups under him on a National Sales Manager's screen");
  assert.equal(managerRow?.value, 70);
  assert.equal(managerGrid.totals.unattributedValue, 30, "only the area nobody owns is left unattributed");
  assert.equal(managerGrid.totals.value, 150, "the line total is unchanged");
  assert.equal(
    managerGrid.totals.exactValue + managerGrid.totals.allocatedValue + managerGrid.totals.unattributedValue,
    managerGrid.totals.value,
    "the three attribution buckets still partition the total",
  );
}
