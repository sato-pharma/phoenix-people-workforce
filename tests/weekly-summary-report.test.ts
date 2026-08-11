import assert from "node:assert/strict";

import {
  compareManagerBuckets,
  managerKey,
  reportingLine,
  resolveWeeklyManager,
  type WeeklyManagerIndex,
} from "../src/lib/sales/weekly/manager-attribution.ts";
import {
  cycleMonthsOfCurrentYear,
  currentCairoCycleMonth,
  groupRowsByManager,
  isActionableLowSalesBucket,
  isLowSalesWithStock,
  latestCycleMonthStockOnly,
  ytdCoverageNote,
} from "../src/lib/sales/weekly/summary-workbook.ts";
import type { WeeklyFactExportRow } from "../src/lib/sales/weekly/types.ts";

const MAY = "2026-05-01";
const JUN = "2026-06-01";
const JUL = "2026-07-01";

function factRow(overrides: Partial<WeeklyFactExportRow> = {}): WeeklyFactExportRow {
  return {
    distributorCode: "IS-S",
    distributorName: "Ibn Sina South",
    productCode: "LA001",
    productName: "Product",
    line: "CNS",
    regionCode: "CA",
    regionName: "Cairo",
    branchCode: "BR1",
    branchName: "Branch One",
    cycleMonth: JUL,
    weekNumber: 1,
    weekStart: "2026-07-04",
    salesValue: 100,
    salesUnits: 10,
    stockUnits: 5,
    ...overrides,
  };
}

// A miniature of the real production seat tree: one CNS DM under the CNS NSM, one Pedia DM that sits
// under the Pedia RSM (which itself sits under the Pedia NSM), and one vacant seat.
function managerIndex(): WeeklyManagerIndex {
  const seat = (
    seatId: string,
    seatTier: string,
    lineCode: string | null,
    regionCode: string | null,
    occupantHrId: string | null,
    parentSeatId: string | null,
  ) => ({ seatId, seatTier, lineCode, regionCode, seatLabel: seatId, occupantHrId, isVacant: occupantHrId === null, parentSeatId });

  const seats = [
    seat("SEAT-ROOT-CEO", "CEO", null, null, "AA", null),
    seat("SEAT-CNS-NSM", "NSM", "cns", null, "B-122", "SEAT-ROOT-CEO"),
    seat("SEAT-PED-NSM", "NSM", "pedia", null, "A-12", "SEAT-ROOT-CEO"),
    seat("SEAT-PED-RSM", "RSM", "pedia", null, "PD-0001", "SEAT-PED-NSM"),
    seat("SEAT-CNS-DM-CA", "DM", "cns", "CA", "B-200", "SEAT-CNS-NSM"),
    seat("SEAT-PED-DM-AB", "DM", "pedia", "AB", "B-201", "SEAT-PED-RSM"),
    seat("SEAT-PED-DM-GZ", "DM", "pedia", "GZ", "B-202", "SEAT-PED-NSM"),
    seat("SEAT-CNS-OTHERS", "DM", "cns", "OT", null, "SEAT-CNS-NSM"),
  ];

  const seatsById = new Map(seats.map((s) => [s.seatId, s]));
  const dmByLineRegion = new Map(
    seats
      .filter((s) => (s.seatTier === "DM" || s.seatTier === "ACTING_DM") && s.lineCode && s.regionCode)
      .map((s) => [managerKey(s.lineCode as string, s.regionCode as string), s]),
  );

  return {
    dmByLineRegion,
    seatsById,
    nameByHrId: new Map([
      ["AA", "Anwar Gaweesh"],
      ["B-122", "Amr Elsabey"],
      ["A-12", "Ali Elsayed"],
      ["PD-0001", "Hany Saad Omar"],
      ["B-200", "Mina Rizkallah"],
      ["B-201", "Ahmed Abdallah"],
      ["B-202", "Taha AboElftouh"],
    ]),
    regionNameByCode: new Map([
      ["CA", "Cairo"],
      ["AB", "Alex-BHR"],
      ["GZ", "Giza"],
      ["OT", "Others"],
    ]),
    ceoName: "Anwar Gaweesh",
  };
}

export function runWeeklySummaryReportTests() {
  const index = managerIndex();

  // 1) HEADLINE — the low-sales predicate, exactly the table the owner specified. Zero-sales branches
  //    are the most serious case on the list, so a truthiness check on salesUnits would be a bug.
  {
    const cases: Array<[number, number, boolean]> = [
      [0, 10, true],
      [1, 20, true],
      [5, 50, true],
      [6, 50, false],
      [0, 0, false],
      [4, 0, false],
    ];
    for (const [sales, stock, expected] of cases) {
      assert.equal(
        isLowSalesWithStock(sales, stock),
        expected,
        `sales ${sales} with stock ${stock} must be ${expected ? "INCLUDED" : "EXCLUDED"}`,
      );
    }
  }

  // 1b) Tab 5 is an ACTION list, so Head Office is excluded from it — nobody can be sent to chase
  //     branches on a line with no field manager, and it is big enough to drown the tab (75% of the
  //     flagged stock in production). Every other bucket, including vacant seats and unmapped rows,
  //     must survive: those still belong to someone, or need someone assigned.
  {
    assert.equal(isActionableLowSalesBucket("ceo"), false, "Head Office / CEO must be excluded from Tab 5");
    for (const kind of ["dm", "vacant", "unmapped"] as const) {
      assert.equal(isActionableLowSalesBucket(kind), true, `${kind} must still appear in Tab 5`);
    }
    // ...but the exclusion is Tab 5 ONLY — Head Office still resolves to a real CEO bucket that the
    // manager / MTD / YTD tabs group on, so the workbook's other totals keep reconciling.
    assert.equal(resolveWeeklyManager(index, "Head Office", "CA").kind, "ceo");
  }

  // 2) THE DANGEROUS ONE — YTD stock must be the latest month's snapshot, never the sum of every
  //    month-end. factRows arrive with stock already kept only on the latest week of each month, so
  //    without this second reduction a 3-month YTD reports ~3x the stock actually on hand.
  {
    const rows = [
      factRow({ cycleMonth: MAY, stockUnits: 100, salesUnits: 10 }),
      factRow({ cycleMonth: JUN, stockUnits: 200, salesUnits: 20 }),
      factRow({ cycleMonth: JUL, stockUnits: 300, salesUnits: 30 }),
    ];
    const reduced = latestCycleMonthStockOnly(rows);
    const stock = reduced.reduce((sum, row) => sum + row.stockUnits, 0);
    const units = reduced.reduce((sum, row) => sum + row.salesUnits, 0);
    assert.equal(stock, 300, "YTD stock must equal ONLY the latest cycle month's snapshot, not 100+200+300");
    assert.equal(units, 60, "sales units must still sum across every month — de-cumulation telescopes");
  }

  // 3) The latest month is resolved PER DISTRIBUTOR. One distributor being a month behind must not
  //    wipe its stock, nor let the other distributor's newer month decide for it.
  {
    const rows = [
      factRow({ distributorCode: "A", cycleMonth: JUN, stockUnits: 40 }),
      factRow({ distributorCode: "A", cycleMonth: JUL, stockUnits: 60 }),
      factRow({ distributorCode: "B", cycleMonth: MAY, stockUnits: 25 }),
      factRow({ distributorCode: "B", cycleMonth: JUN, stockUnits: 35 }),
    ];
    const byDistributor = new Map<string, number>();
    for (const row of latestCycleMonthStockOnly(rows)) {
      byDistributor.set(row.distributorCode, (byDistributor.get(row.distributorCode) ?? 0) + row.stockUnits);
    }
    assert.equal(byDistributor.get("A"), 60, "distributor A keeps only its July snapshot");
    assert.equal(byDistributor.get("B"), 35, "distributor B keeps its own latest month (June), not July");
  }

  // 4) Manager resolution — region + line lands on the right DM, and the reporting chain is walked
  //    from parent_seat_id. Pedia Alex-BHR goes through the RSM; Pedia Giza reports straight to NSM.
  {
    const cairoCns = resolveWeeklyManager(index, "CNS", "CA");
    assert.equal(cairoCns.kind, "dm");
    assert.equal(cairoCns.label, "Mina Rizkallah", "Cairo + CNS must resolve to the Cairo CNS DM");
    assert.equal(cairoCns.rsmName, null, "the CNS line has no RSM seat");
    assert.equal(cairoCns.nsmName, "Amr Elsabey");

    const alexPedia = resolveWeeklyManager(index, "Pedia", "AB");
    assert.equal(alexPedia.label, "Ahmed Abdallah");
    assert.equal(alexPedia.rsmName, "Hany Saad Omar", "Pedia Alex-BHR reports through the Pedia RSM");
    assert.equal(alexPedia.nsmName, "Ali Elsayed", "and the RSM in turn reports to the Pedia NSM");
    assert.equal(reportingLine(alexPedia), "reports to: Hany Saad Omar (RSM) -> Ali Elsayed (NSM)");

    const gizaPedia = resolveWeeklyManager(index, "Pedia", "GZ");
    assert.equal(gizaPedia.rsmName, null, "Pedia Giza sits directly under the NSM, with no RSM in between");
    assert.equal(gizaPedia.nsmName, "Ali Elsayed");
  }

  // 5) Head Office is the largest block by units and has no field seat by design — it belongs to the
  //    CEO, not to an "unmapped" bucket. A blank line, by contrast, IS unmapped and must not be
  //    laundered into the CEO section just because both resolve to a null line code.
  {
    const headOffice = resolveWeeklyManager(index, "Head Office", "CA");
    assert.equal(headOffice.kind, "ceo", "Head Office must land in the CEO bucket");
    assert.equal(headOffice.label, "Anwar Gaweesh");

    for (const blank of ["", "   ", null, undefined]) {
      assert.equal(
        resolveWeeklyManager(index, blank, "CA").kind,
        "unmapped",
        `a blank line (${JSON.stringify(blank)}) must be unmapped, never the CEO bucket`,
      );
    }
    assert.equal(resolveWeeklyManager(index, "CNS", "").kind, "unmapped", "a blank region is unmapped");
    // Anti Infective in Upper Egypt is the live example: the org splits it UE-1/UE-2 while weekly
    // rows carry plain "UE", so nothing matches and guessing between two managers is not allowed.
    assert.equal(resolveWeeklyManager(index, "Anti Infective", "UE").kind, "unmapped");
  }

  // 6) A vacant seat is a distinct state from "no seat". The seat exists and its scope is real, so it
  //    keeps its own labelled section instead of silently merging into unmapped.
  {
    const vacant = resolveWeeklyManager(index, "CNS", "OT");
    assert.equal(vacant.kind, "vacant", "an unoccupied DM seat is vacant, not unmapped");
    assert.equal(vacant.managerName, null);
    assert.ok(vacant.label.startsWith("Vacant —"), `vacant label must say so, got "${vacant.label}"`);
    assert.equal(vacant.nsmName, "Amr Elsabey", "a vacant seat still knows who it reports to");
  }

  // 7) Section ordering: real managers first, then the CEO block, then vacant seats, then unmapped —
  //    so the residue never pushes a real manager down the sheet.
  {
    const buckets = [
      resolveWeeklyManager(index, "CNS", ""),
      resolveWeeklyManager(index, "CNS", "OT"),
      resolveWeeklyManager(index, "Head Office", "CA"),
      resolveWeeklyManager(index, "CNS", "CA"),
    ].sort(compareManagerBuckets);
    assert.deepEqual(
      buckets.map((b) => b.kind),
      ["dm", "ceo", "vacant", "unmapped"],
      "sections must run: managers, CEO, vacant, unmapped",
    );
  }

  // 8) Grouping keeps every row — nothing is silently dropped, per the standing rule that an
  //    unattributable row is counted and flagged, never discarded.
  {
    const rows = [
      factRow({ line: "CNS", regionCode: "CA", salesUnits: 10 }),
      factRow({ line: "Pedia", regionCode: "AB", salesUnits: 20 }),
      factRow({ line: "Head Office", regionCode: "CA", salesUnits: 30 }),
      factRow({ line: "", regionCode: "", salesUnits: 40 }),
    ];
    const groups = groupRowsByManager(rows, index);
    const grouped = groups.reduce((sum, group) => sum + group.rows.length, 0);
    assert.equal(grouped, rows.length, "every fact row must land in exactly one manager group");
    const units = groups.flatMap((g) => g.rows).reduce((sum, row) => sum + row.salesUnits, 0);
    assert.equal(units, 100, "grouping must conserve total units");
  }

  // 9) YTD coverage note — a month with no uploads must be NAMED. Weekly data begins May 2026, so
  //    January-April are legitimately empty and a bare zero would read as a sales collapse.
  {
    const rows = [factRow({ cycleMonth: JUL })];
    const note = ytdCoverageNote(["2026-01-01", "2026-02-01", JUL], rows);
    assert.ok(note.includes("2026-01"), `missing months must be named, got "${note}"`);
    assert.ok(note.includes("2026-02"), `every missing month must be named, got "${note}"`);
    assert.ok(!note.includes("2026-07"), "a month that HAS uploads must not be reported as missing");

    const complete = ytdCoverageNote([JUL], rows);
    assert.ok(complete.includes("All months"), `full coverage must say so, got "${complete}"`);
  }

  // 10) Period helpers are Cairo-based, first-of-month, and the year list stops at the current month
  //     (never running ahead into months that cannot have data yet).
  {
    const march = new Date("2026-03-15T12:00:00Z");
    assert.equal(currentCairoCycleMonth(march), "2026-03-01", "cycle month is the first of the Cairo month");
    assert.deepEqual(
      cycleMonthsOfCurrentYear(march),
      ["2026-01-01", "2026-02-01", "2026-03-01"],
      "the YTD month list runs January to the current month inclusive",
    );

    const january = new Date("2026-01-04T12:00:00Z");
    assert.deepEqual(cycleMonthsOfCurrentYear(january), ["2026-01-01"], "in January the list is just January");
  }
}
