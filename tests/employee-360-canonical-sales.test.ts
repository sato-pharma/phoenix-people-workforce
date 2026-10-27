import assert from "node:assert/strict";
import {
  aggregateCanonicalEmployee360Rows,
  buildEmployee360TeamSales,
  creditEmployee360RowsByTenure,
  employee360TeamTreeMissing,
  maskRestrictedEmployee360Rows,
  selectEmployee360RowsForFamilies,
  selectEmployee360TeamRows,
  toEmployee360SalesRows,
  unpublishedEmployee360Periods,
  type CanonicalEmployee360SalesRow,
  type Employee360SeatModel,
} from "../src/lib/employee-360/sales-canonical.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import type { SalesSeat, SalesSeatTree } from "../src/lib/sales/seat-hierarchy.ts";
import type { SeatTenure } from "../src/lib/sales/seat-tenure-credit.ts";

// Employee 360 was the last surface answering "how much did this person sell" from the legacy
// sales_records table. It read B-158's H1 as 700,019.87 while the incentive tab, the monthly
// dashboard, the closing view and reconciliation all read 460,228.50 — a 52% overstatement, with
// every month differing. These pin the three decisions in the canonical replacement that, if
// quietly reversed, would put it back out of step with the other four surfaces.

function achievementRow(overrides: Partial<AchievementRow> = {}): AchievementRow {
  return {
    period: "2026-07",
    lineCode: "cns",
    regionCode: "LE-1",
    areaCode: "GZ6",
    areaState: "active",
    isOther: false,
    repSeatId: "seat-1",
    repHrId: "B-158",
    dmSeatId: "seat-dm",
    dmHrId: "A-001",
    productCode: "SA001",
    actualUnits: 10,
    actualValue: 1000,
    targetUnits: 8,
    targetValue: 800,
    achievementValue: 1.25,
    achievementUnits: 1.25,
    hasTarget: true,
    hasActual: true,
    ...overrides,
  };
}

function salesRow(overrides: Partial<CanonicalEmployee360SalesRow> = {}): CanonicalEmployee360SalesRow {
  return {
    employee_hr_id: "B-158",
    managerHrId: "A-001",
    line: "CNS",
    family: "Neuro",
    product: "Sample Product",
    productCode: "SA001",
    month: 7,
    year: 2026,
    sales_value: 1000,
    target_value: 800,
    ...overrides,
  };
}

function seat(seatId: string, tier: string, parentSeatId: string | null, occupantHrId: string | null): SalesSeat {
  return { seatId, parentSeatId, tier, lineCode: "cns", regionName: null, occupantHrId, isOtherPseudoDm: false };
}

const NO_SEATS: Employee360SeatModel = { seats: new Map(), tenure: null };

export function runEmployee360CanonicalSalesTests() {
  // Published (line, month) keys, the shape `loadPublishedPeriodKeys` returns.
  const published = new Set(["cns|2026-07"]);

  // ── 1. The PUBLICATION gate (owner, 2026-10-27) ───────────────────────────
  // Employee 360 shows the published closing and nothing else. An unpublished month is not a
  // figure and not a zero: it is dropped here and named "Not published yet" on the page. The gate
  // is per LINE as well as per month, as on Sales vs Target.
  const acrossMonths = aggregateCanonicalEmployee360Rows(
    [
      achievementRow({ period: "2026-07" }),
      achievementRow({ period: "2026-08", actualValue: 1309.5 }),
      achievementRow({ period: "2026-07", lineCode: "pedia" }),
    ],
    published,
  );
  assert.equal(acrossMonths.length, 1, "an unpublished month, or an unpublished line in a published month, is dropped");
  assert.equal(acrossMonths[0].period, "2026-07", "the surviving row is the published one");
  assert.equal(acrossMonths[0].lineCode, "cns", "the surviving line is the published one");

  // ── 2. A vacant seat's month is KEPT, with no rep ─────────────────────────
  // The closing counts a vacant area's sales in its district's and region's totals; dropping the
  // row here is how a manager's Employee 360 total came out below his closing total.
  const vacant = toEmployee360SalesRows(
    aggregateCanonicalEmployee360Rows([achievementRow({ repHrId: null })], published),
    new Map(),
    new Map(),
  );
  assert.equal(vacant.length, 1, "a row with no rep survives the aggregation");
  assert.equal(vacant[0].employee_hr_id, null, "and is credited to nobody, never to whoever is nearby");

  // ── 3. One aggregate per (rep, period, product) ───────────────────────────
  // The engine emits a row per (rep, AREA, product), so a rep working two areas emits the same
  // product twice in one month. Summing here keeps the row count honest for `hasData`.
  const twoAreas = aggregateCanonicalEmployee360Rows(
    [achievementRow({ areaCode: "GZ6" }), achievementRow({ areaCode: "UE9" })],
    published,
  );
  assert.equal(twoAreas.length, 1, "the same product in the same month collapses to one row across areas");
  assert.equal(twoAreas[0].salesValue, 2000, "…and its value is the SUM of both areas, never one of them");
  assert.equal(twoAreas[0].targetValue, 1600, "…targets sum the same way");

  // ── 4. A person with no manager seat is scoped by REP only ────────────────
  // A rep's figure is his own rows, never his district's. Casing is folded because the engine's
  // casing is not the repo's.
  const repRows = [achievementRow({ repHrId: "B-158" }), achievementRow({ repHrId: "C-999", dmHrId: "A-001" })];
  const selected = selectEmployee360TeamRows(repRows, "b-158", [], NO_SEATS);
  assert.equal(selected.length, 1, "a team-mate's row in the same district is NOT selected for a rep");
  assert.equal(selected[0].repHrId, "B-158", "HR ids match case-insensitively in both directions");
  assert.equal(selectEmployee360TeamRows(repRows, "", [], NO_SEATS).length, 0, "no subject selects nothing, never everything");

  // ── 5. The PM path selects by family ──────────────────────────────────────
  const byFamily = selectEmployee360RowsForFamilies(
    [salesRow({ family: "Neuro" }), salesRow({ family: "Pedia" })],
    ["neuro"],
  );
  assert.equal(byFamily.length, 1, "a PM owns brands, so their sales are their families' sales");
  assert.equal(byFamily[0].family, "Neuro", "family matching is case-insensitive");

  // ── 6. Confidential products are masked by CODE ───────────────────────────
  // LA003/LA004/SS001 are the whole Head Office line. The legacy table had no product code, so it
  // matched by NAME and inherited every rename; canonical rows carry the code, so the strip is exact.
  const confidential = [
    salesRow({ productCode: "LA003", product: "Lacto Basic 1" }),
    salesRow({ productCode: "SS001", product: "Satoslim" }),
    salesRow({ productCode: "SA001", product: "Normal Product" }),
  ];
  assert.equal(
    maskRestrictedEmployee360Rows(confidential, "District Manager").length,
    1,
    "a District Manager sees only the non-confidential product",
  );
  assert.equal(
    maskRestrictedEmployee360Rows(confidential, "CEO").length,
    3,
    "the CEO sees all three — the mask is a role gate, not a blanket exclusion",
  );
  assert.deepEqual(
    maskRestrictedEmployee360Rows(confidential, "Medical Rep").map((r) => r.productCode),
    ["SA001"],
    "no confidential CODE survives for a rep, whatever the product happens to be named",
  );

  // ── 7. An unmapped SKU keeps its code, never a placeholder ────────────────
  // Collapsing unmapped products into one "—" bucket is how a real seller vanishes from Top Products.
  const named = toEmployee360SalesRows(
    aggregateCanonicalEmployee360Rows([achievementRow({ productCode: "ZZ999" })], published),
    new Map(),
    new Map(),
  );
  assert.equal(named[0].product, "ZZ999", "an unmapped product falls back to its CODE so it stays countable");
  assert.equal(named[0].line, "CNS", "line codes are resolved to the official name — a user never sees a code");
  assert.equal(named[0].year, 2026, "the period is split into the year/month the aggregator groups on");
  assert.equal(named[0].month, 7, "…and the month survives as a number, not a string");

  // ── 8. A vacant seat counts in its manager's team total ───────────────────
  // A manager's team is his node on Sales vs Target: the district by `dmHrId` (rollupByDm), the
  // region by the seat above it (rollupByRegionalManager), the line (rollupByTeam). A vacant REP
  // seat in a district is its District Manager's. A district with NO manager that month is not in
  // the Regional Manager's total (owner, 2026-10-27) — but it is in the line's.
  const seats: SalesSeatTree = new Map(
    [
      seat("seat-nsm", "NSM", null, "N-001"),
      seat("seat-rsm", "RSM", "seat-nsm", "R-001"),
      seat("seat-rsm2", "RSM", "seat-nsm", "R-002"),
      seat("seat-dm", "DM", "seat-rsm", "A-001"),
      seat("seat-dm2", "DM", "seat-rsm", null),
      seat("seat-dm3", "DM", "seat-rsm2", "A-003"),
      seat("seat-1", "REP", "seat-dm", "B-158"),
      seat("seat-2", "REP", "seat-dm", null),
    ].map((entry) => [entry.seatId, entry]),
  );
  const managerModel: Employee360SeatModel = { seats, tenure: null };
  const teamRows = [
    achievementRow({ repSeatId: "seat-1", repHrId: "B-158", actualValue: 1000 }),
    achievementRow({ repSeatId: "seat-2", repHrId: null, actualValue: 400 }),
    achievementRow({ repSeatId: "seat-x", repHrId: null, dmSeatId: "seat-dm2", dmHrId: null, actualValue: 300 }),
    achievementRow({ repSeatId: "seat-y", repHrId: "B-900", dmSeatId: "seat-dm3", dmHrId: "A-003", actualValue: 50 }),
  ];
  const sum = (rows: readonly AchievementRow[]) => rows.reduce((total, row) => total + row.actualValue, 0);
  assert.equal(
    sum(selectEmployee360TeamRows(teamRows, "A-001", ["A-001", "B-158"], managerModel)),
    1400,
    "a District Manager's team total carries his vacant rep seat's 400 beside his rep's 1,000",
  );
  assert.equal(
    sum(selectEmployee360TeamRows(teamRows, "R-001", ["R-001", "A-001", "B-158"], managerModel)),
    1400,
    "a Regional Manager's total leaves out his district with no manager (300) and the sibling region's 50",
  );
  assert.equal(
    sum(selectEmployee360TeamRows(teamRows, "N-001", ["N-001"], managerModel)),
    1750,
    "the National Manager's total is the whole line",
  );

  // ── 9. Seat tenure splits a mid-month joiner's seat by month ──────────────
  // B-158 took seat-1 on 15 August. July's rows are the previous holder's; August (held on the
  // month's last day) and September are his. Today's occupant never inherits a month before his seat.
  const tenure: SeatTenure = {
    stretches: [
      { seatId: "seat-1", occupantHrId: "B-100", effectiveFrom: "2026-01-01", effectiveTo: "2026-08-15" },
      { seatId: "seat-1", occupantHrId: "B-158", effectiveFrom: "2026-08-15", effectiveTo: null },
      { seatId: "seat-dm", occupantHrId: "A-001", effectiveFrom: "2026-01-01", effectiveTo: null },
    ],
    employment: new Map([
      ["b-158", { hireDate: "2026-08-15", lastWorkingDate: null }],
      ["b-100", { hireDate: "2024-01-01", lastWorkingDate: "2026-08-14" }],
    ]),
  };
  const credited = creditEmployee360RowsByTenure(
    ["2026-07", "2026-08", "2026-09"].map((period) => achievementRow({ period, repSeatId: "seat-1", repHrId: "B-158" })),
    tenure,
  );
  assert.deepEqual(
    credited.map((row) => `${row.period}:${row.repHrId}`),
    ["2026-07:B-100", "2026-08:B-158", "2026-09:B-158"],
    "each month goes to the person who held the seat on its last day",
  );
  assert.deepEqual(
    selectEmployee360TeamRows(credited, "B-158", [], { seats, tenure }).map((row) => row.period),
    ["2026-08", "2026-09"],
    "the joiner's own figure starts at the month he held the seat",
  );
  assert.deepEqual(
    selectEmployee360TeamRows(credited, "B-100", [], { seats, tenure }).map((row) => row.period),
    ["2026-07"],
    "and the leaver keeps the month he sold",
  );

  // ── 10. An unpublished month is excluded AND named, never a zero ──────────
  const pendingRows = [
    achievementRow({ period: "2026-07" }),
    achievementRow({ period: "2026-10" }),
    achievementRow({ period: "2026-11", hasActual: false, actualValue: 0 }),
  ];
  assert.deepEqual(
    aggregateCanonicalEmployee360Rows(pendingRows, published).map((row) => row.period),
    ["2026-07"],
    "October has sales but no published closing, so no October figure reaches a total",
  );
  assert.deepEqual(
    unpublishedEmployee360Periods(pendingRows, published),
    ["2026-10"],
    "October is named as not published yet; a month with no sales at all is not named",
  );
  assert.deepEqual(
    unpublishedEmployee360Periods(
      [achievementRow({ period: "2026-07", lineCode: "pedia" }), achievementRow({ period: "2026-07" })],
      published,
    ),
    [],
    "a month with a published line is not called unpublished; it shows the published line alone",
  );

  // ── 11. A month under a RETIRED district seat stays with its managers ─────
  // The single Pedia "Upper Egypt" seat was split in two; months earned under it name a seat
  // today's tree no longer holds. Its District Manager (by tenure, or the engine's name when the
  // seat has no recorded history) keeps the month, and so does the Regional Manager above the live
  // district of the same region.
  const retiredRow = achievementRow({ period: "2026-06", repSeatId: "seat-old-rep", repHrId: null, dmSeatId: "seat-dm-old", dmHrId: "A-001", actualValue: 700 });
  assert.equal(seats.has("seat-dm-old"), false, "the fixture's retired seat is absent from today's tree");
  const retiredTenure: SeatTenure = {
    stretches: [
      { seatId: "seat-dm-old", occupantHrId: "A-001", effectiveFrom: "2026-01-01", effectiveTo: "2026-07-01" },
      { seatId: "seat-dm", occupantHrId: "A-001", effectiveFrom: "2026-07-01", effectiveTo: null },
      { seatId: "seat-rsm", occupantHrId: "R-001", effectiveFrom: "2026-01-01", effectiveTo: null },
    ],
    employment: new Map(),
  };
  const retiredWindow = creditEmployee360RowsByTenure([...teamRows, retiredRow], retiredTenure);
  assert.equal(
    sum(selectEmployee360TeamRows(retiredWindow, "A-001", ["A-001"], { seats, tenure: retiredTenure })),
    2100,
    "the District Manager who held the retired seat keeps its 700 beside his live district's 1,400",
  );
  assert.equal(
    sum(selectEmployee360TeamRows(retiredWindow, "R-001", ["R-001"], { seats, tenure: retiredTenure })),
    2100,
    "the Regional Manager above that region keeps it too, read through the region's live district",
  );
  const noHistory = creditEmployee360RowsByTenure([retiredRow], { stretches: [], employment: new Map() });
  assert.equal(noHistory[0].dmHrId, "A-001", "a retired seat with no recorded history keeps the manager the engine named");

  // ── 12. An unread seat map never prints a smaller team total ──────────────
  // The seat tree comes back EMPTY on a failed read. For a manager, the rep-only fallback would show
  // his own sales as his team's; the section says the team total could not be read instead.
  assert.equal(employee360TeamTreeMissing(teamRows, "R-001", ["R-001", "A-001"], NO_SEATS), true, "a manager with no seat map is flagged");
  assert.equal(employee360TeamTreeMissing(teamRows, "B-158", ["B-158"], NO_SEATS), false, "a rep's own figure needs no seat map");
  assert.equal(employee360TeamTreeMissing(teamRows, "R-001", ["R-001", "A-001"], managerModel), false, "a loaded seat map is never flagged");
  const unreadable = buildEmployee360TeamSales(
    { rows: teamRows, publishedKeys: published, productNames: new Map(), productFamilies: new Map(), seats: new Map(), tenure: null },
    "R-001",
    ["R-001", "A-001"],
    "CEO",
  );
  assert.equal(unreadable.teamUnreadable, true, "the team build reports the unread seat map");
  assert.equal(unreadable.rows.length, 0, "and carries no figure at all, never a partial total");
}
