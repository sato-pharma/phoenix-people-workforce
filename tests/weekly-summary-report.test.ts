import assert from "node:assert/strict";

import JSZip from "jszip";

import {
  compareManagerBuckets,
  managerKey,
  reportingLine,
  resolveWeeklyManager,
  type WeeklyManagerIndex,
} from "../src/lib/sales/weekly/manager-attribution.ts";
import { latestUploadedPeriod } from "../src/lib/sales/weekly/batch-scope.ts";
import {
  buildVsTargetModel,
  buildWeeklySummaryWorkbook,
  cycleMonthsOfCurrentYear,
  currentCairoCycleMonth,
  groupRowsByManager,
  isActionableLowSalesBucket,
  isLowSalesWithStock,
  latestCycleMonthStockOnly,
  resolveLineTabs,
  spanPlan,
  splitLineIntoFamilyBlocks,
  ytdCoverageNote,
  type VsTargetTabInput,
} from "../src/lib/sales/weekly/summary-workbook.ts";
import type { WeeklyDashboard, WeeklyFactExportRow } from "../src/lib/sales/weekly/types.ts";

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
    areaCode: "CA1",
    branchCode: "BR1",
    branchName: "Branch One",
    cycleMonth: JUL,
    weekNumber: 1,
    weekStart: "2026-07-04",
    batchId: "batch-1",
    family: "Royafloxacin",
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
    // Anti Infective is the one line whose organogram splits Upper Egypt — mirrors production, where
    // there is no plain "UE" seat on this line at all, only UE-1 and UE-2.
    seat("SEAT-AI-NSM", "NSM", "anti_infective", null, "B-122", "SEAT-ROOT-CEO"),
    seat("SEAT-AI-DM-UE1", "DM", "anti_infective", "UE-1", "B-203", "SEAT-AI-NSM"),
    seat("SEAT-AI-DM-UE2", "DM", "anti_infective", "UE-2", "B-204", "SEAT-AI-NSM"),
    seat("SEAT-CNS-DM-AB", "DM", "cns", "AB", "B-205", "SEAT-CNS-NSM"),
    seat("SEAT-CNS-DM-D1", "DM", "cns", "D1", "B-206", "SEAT-CNS-NSM"),
  ];

  const seatsById = new Map(seats.map((s) => [s.seatId, s]));
  const dmByLineRegion = new Map(
    seats
      .filter((s) => (s.seatTier === "DM" || s.seatTier === "ACTING_DM") && s.lineCode && s.regionCode)
      .map((s) => [managerKey(s.lineCode as string, s.regionCode as string), s]),
  );

  // (line, area) -> operational region, mirroring au_v_line_area_map. Two shapes matter here:
  // Anti Infective splitting Upper Egypt across two DMs, and CNS's Kafr El-Sheikh 1 (D16) sitting in
  // Delta (1) geographically while the organogram gives it to Alex-BHR.
  const operationalRegionByLineArea = new Map([
    [managerKey("anti_infective", "UE1"), "UE-1"],
    [managerKey("anti_infective", "UE2"), "UE-1"],
    [managerKey("anti_infective", "UE3"), "UE-2"],
    [managerKey("anti_infective", "UE5"), "UE-2"],
    [managerKey("cns", "D16"), "AB"],
    [managerKey("cns", "CA1"), "CA"],
  ]);

  return {
    dmByLineRegion,
    operationalRegionByLineArea,
    seatsById,
    nameByHrId: new Map([
      ["AA", "Anwar Gaweesh"],
      ["B-122", "Amr Elsabey"],
      ["A-12", "Ali Elsayed"],
      ["PD-0001", "Hany Saad Omar"],
      ["B-200", "Mina Rizkallah"],
      ["B-201", "Ahmed Abdallah"],
      ["B-202", "Taha AboElftouh"],
      ["B-203", "Sherif Kamal"],
      ["B-204", "Mostafa Zaki"],
      ["B-205", "Nader Fouad"],
      ["B-206", "Wael Ibrahim"],
    ]),
    regionNameByCode: new Map([
      ["CA", "Cairo"],
      ["AB", "Alex-BHR"],
      ["GZ", "Giza"],
      ["OT", "Others"],
      ["D1", "Delta (1)"],
      ["UE-1", "Upper Egypt 1"],
      ["UE-2", "Upper Egypt 2"],
    ]),
    ceoName: "Anwar Gaweesh",
  };
}

export async function runWeeklySummaryReportTests() {
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
    // Anti Infective in Upper Egypt, ON A BRANCH CARRYING NO AREA: the org splits it UE-1/UE-2 while
    // the weekly row carries plain "UE", so nothing matches and guessing between two managers is not
    // allowed. Block 5b below is the same line WITH an area, which does resolve.
    assert.equal(resolveWeeklyManager(index, "Anti Infective", "UE").kind, "unmapped");
  }

  // 5b) AREA BEATS REGION. Measured in production 2026-08-26: EGP 10,289,490 of Anti Infective (21.3%
  //     of the line) reached no manager because every branch is tagged with one geographic "UE" while
  //     that line's organogram has only UE-1 and UE-2 — and a further EGP 5,298,449 across 15 line/area
  //     pairs was credited to the geographic manager instead of the one who owns it. Both are the same
  //     defect: the row's own area was never consulted. Precedence is area first, region as fallback.
  {
    // The UE split, resolved exactly — no pro-rata, no guessing between the two DMs.
    const ue1 = resolveWeeklyManager(index, "Anti Infective", "UE", "UE1");
    assert.equal(ue1.kind, "dm", "an Anti Infective row with a mapped area must reach a real manager");
    assert.equal(ue1.managerName, "Sherif Kamal", "UE1 belongs to the Upper Egypt 1 manager");
    const ue2 = resolveWeeklyManager(index, "Anti Infective", "UE", "UE3");
    assert.equal(ue2.managerName, "Mostafa Zaki", "UE3 belongs to the Upper Egypt 2 manager — a DIFFERENT DM");
    assert.notEqual(ue1.key, ue2.key, "the two Upper Egypt districts must not collapse into one bucket");

    // The organogram overrides a geographic region that disagrees with it: Kafr El-Sheikh 1 sits in
    // Delta (1) on the map but belongs to the Alex-BHR manager on CNS.
    const kafr = resolveWeeklyManager(index, "CNS", "D1", "D16");
    assert.equal(kafr.managerName, "Nader Fouad", "D16 must follow the organogram to Alex-BHR, not geography to Delta (1)");
    assert.ok(kafr.scopeLabel.includes("Alex-BHR"), `the section must name the owning region, got "${kafr.scopeLabel}"`);
    assert.equal(
      resolveWeeklyManager(index, "CNS", "D1").managerName,
      "Wael Ibrahim",
      "without an area the same row still falls back to its geographic Delta (1) manager",
    );

    // An area the map does not cover must fall back, never vanish — a missing mapping cannot cost the
    // report a row of sales.
    const unknownArea = resolveWeeklyManager(index, "CNS", "CA", "ZZ99");
    assert.equal(unknownArea.managerName, "Mina Rizkallah", "an unmapped area falls back to the geographic region");
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

  // 9b) HEADLINE — the default period is the LATEST (cycle month, week), not the whole history.
  //     An empty filter means "everything" to the loader, and that is what put dates from May in
  //     front of the owner when he asked for the sheet he had just uploaded.
  {
    const batches = [
      { cycleMonth: "2026-07-01", weekNumber: 4 },
      { cycleMonth: "2026-08-01", weekNumber: 1 },
      { cycleMonth: "2026-08-01", weekNumber: 2 },
      { cycleMonth: "2026-06-01", weekNumber: 3 },
    ];
    assert.deepEqual(
      latestUploadedPeriod(batches),
      { cycleMonth: "2026-08-01", weekNumber: 2 },
      "the newest month AND the newest week within it",
    );
    // A later week number in an OLDER month must never beat a newer month.
    assert.deepEqual(
      latestUploadedPeriod([
        { cycleMonth: "2026-07-01", weekNumber: 4 },
        { cycleMonth: "2026-08-01", weekNumber: 1 },
      ]),
      { cycleMonth: "2026-08-01", weekNumber: 1 },
      "August W1 is newer than July W4 — month wins over week number",
    );
    assert.equal(latestUploadedPeriod([]), null, "no batches means no default period, not a guess");
    assert.equal(
      latestUploadedPeriod([{ cycleMonth: null, weekNumber: 2 }, { cycleMonth: "2026-08-01", weekNumber: null }]),
      null,
      "an untagged batch cannot define the period",
    );
  }

  // 9d) Line splitting is NOT the default. His rule: one combined tab set unless he deliberately
  //     picks more than one line — "dont make all line like this one sheet per line".
  {
    assert.deepEqual(resolveLineTabs([]), [], "no line picked -> one combined tab set");
    assert.deepEqual(resolveLineTabs(["Pedia"]), [], "one line picked -> still ONE tab set, that line only");
    assert.deepEqual(
      resolveLineTabs(["Pedia", "CNS"]),
      ["Pedia", "CNS"],
      "two or more lines picked -> a tab set per line, in the order he picked them",
    );
    assert.deepEqual(resolveLineTabs(["Pedia", "Pedia", " CNS "]), ["Pedia", "CNS"], "de-duped and trimmed");
    assert.deepEqual(resolveLineTabs(["", "  "]), [], "blank picks are not lines");
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

  // ── Page geometry: a value cell must never collapse onto its neighbour ──────
  //
  // spanPlan used to return floor(cols / cells), which is ZERO once a table carries more products
  // than the page can hold. Two cells then resolved to the SAME column, so the later product
  // silently overwrote the earlier one and the last pair landed on the trend column. Reachable in
  // production: Tebofortin has SEVEN concentrations in the master, and 7 products = 14 value cells
  // across 10 available columns.
  {
    for (const cells of [2, 4, 6, 8, 10, 12, 14, 20]) {
      const plan = spanPlan(cells, 10);
      assert.equal(plan.length, cells, `spanPlan must return one span per cell (${cells})`);
      assert.ok(
        plan.every((span) => span >= 1),
        `spanPlan(${cells}, 10) returned a zero-width span: ${JSON.stringify(plan)}`,
      );
      // No two cells may start on the same column — that collision IS the bug.
      const starts: number[] = [];
      let cursor = 2;
      for (const span of plan) {
        starts.push(cursor);
        cursor += span;
      }
      assert.equal(new Set(starts).size, starts.length, `two cells collide on one column at ${cells} cells`);
    }
    assert.deepEqual(spanPlan(4, 10), [3, 3, 2, 2], "spare columns go to the leftmost cells so the table still ends flush");
    assert.deepEqual(spanPlan(0, 10), [], "no cells, no spans");
  }

  // ── A family wider than the page is CHUNKED, never rendered as one wide table ──
  {
    const tebofortin = Array.from({ length: 7 }, (_, i) =>
      factRow({ productCode: `TEB${i}`, productName: `Tebofortin ${i}`, family: "Tebofortin", line: "CNS" }),
    );
    const conviban = Array.from({ length: 4 }, (_, i) =>
      factRow({ productCode: `CON${i}`, productName: `Conviban ${i}`, family: "Conviban", line: "CNS" }),
    );
    const blocks = splitLineIntoFamilyBlocks([...tebofortin, ...conviban]);
    for (const block of blocks) {
      const products = new Set(block.rows.map((row) => row.productCode)).size;
      assert.ok(products <= 5, `a block carries ${products} products — the page holds 5: "${block.label}"`);
    }
    assert.ok(
      blocks.some((block) => /\(1 of 2\)/.test(block.label)),
      `a 7-product family must be split into numbered parts, got: ${blocks.map((b) => b.label).join(" | ")}`,
    );
    // Nothing may be dropped on the way.
    assert.equal(
      new Set(blocks.flatMap((b) => b.rows.map((r) => r.productCode))).size,
      11,
      "every product must survive the split — 7 Tebofortin + 4 Conviban",
    );
  }

  // A line that fits the page stays ONE table, plainly named.
  {
    const antiInfective = ["Saginko", "Royafloxacin"].map((family, i) =>
      factRow({ productCode: `AI${i}`, productName: family, family, line: "Anti Infective" }),
    );
    const blocks = splitLineIntoFamilyBlocks(antiInfective);
    assert.equal(blocks.length, 1, "two products is one table");
    assert.equal(blocks[0].label, "Anti Infective", "and it carries the plain line name, not a family list");
  }

  // ── The workbook must OPEN. Excel's "we found a problem" prompt is a shipped defect ──
  //
  // Tab 2's rows are grouped so a manager collapses to one line. ExcelJS derives each row's
  // `collapsed` flag as `outlineLevel >= properties.outlineLevelRow` and offers no setter, so the
  // default outlineLevelRow of 0 stamps collapsed="1" onto every level-1 row while leaving them
  // visible. Excel reads that as a collapsed group whose rows are not hidden and offers to repair
  // the file. Caught on a real preview 2026-08-12.
  {
    const rows = [
      factRow({ productCode: "P1", productName: "Alpha", family: "Alpha", areaCode: "CA1", regionCode: "CA" }),
      factRow({ productCode: "P2", productName: "Beta", family: "Beta", areaCode: "CA2", regionCode: "CA" }),
      // A row with NO area still has to appear, in its own bucket.
      factRow({ productCode: "P1", productName: "Alpha", family: "Alpha", areaCode: null, regionCode: "CA" }),
    ];
    const dash = (factRows: WeeklyFactExportRow[]) =>
      ({
        weekStart: null, priorWeekStart: null, availableWeeks: [], weekGroupMembers: {},
        availableLines: ["CNS"], availableRegions: [], availableProducts: [], availableMonths: [],
        availableWeekNumbers: [], availableUploads: [], distributors: [],
        appliedFilters: {
          weekStart: null, weekStarts: [], allWeeks: true, distributorCode: null, regionCode: null,
          productCode: null, lineCode: null, productCodes: [], productFilterMode: "include",
          distributorCodes: [], distributorFilterMode: "include", regionCodes: [], regionFilterMode: "include",
          lineCodes: [], lineFilterMode: "include", cycleMonths: [], cycleMonthMode: "include",
          weekNumbers: [], weekNumberMode: "include",
        },
        kpis: { salesValue: 0, salesUnits: 0, stockUnits: 0, branchCount: 0, regionCount: 0, productCount: 0, distributorCount: 0 },
        compare: {
          salesValue: { current: 0, prior: null, pct: null },
          salesUnits: { current: 0, prior: null, pct: null },
          stockUnits: { current: 0, prior: null, pct: null },
        },
        regions: [], products: [], distributorBreakdown: [], branchBreakdown: [],
        zeroSalesBranches: [], weekComparison: [], sources: [], trend: [], factRows,
      }) as unknown as WeeklyDashboard;

    const base = {
      weekly: dash(rows), mtd: dash(rows), ytd: dash(rows), trend: dash(rows),
      managerIndex: { dmByLineRegion: new Map(), operationalRegionByLineArea: new Map(), seatsById: new Map(), nameByHrId: new Map(), regionNameByCode: new Map(), ceoName: null },
      ytdMonths: [JUL], periodLabel: "test", generatedAt: "2026-08-12 00:00 UTC", lineFilter: [],
      masterAreas: [
        { areaCode: "CA1", areaName: "Heliopolis", regionCode: "CA" },
        { areaCode: "CA2", areaName: "Nasr City", regionCode: "CA" },
      ],
      regionNames: [{ regionCode: "CA", regionName: "Cairo" }],
    };
    const julyTargets = [
      { lineLabel: "CNS", areaCode: "CA1", targetUnits: 40 },
      { lineLabel: "CNS", areaCode: "CA2", targetUnits: 60 },
    ];

    const buffer = await buildWeeklySummaryWorkbook({
      ...base,
      vsTarget: {
        kind: "shown",
        months: [{ period: "2026-07", monthRows: rows, targets: julyTargets, targetedLines: ["CNS"] }],
        dataNote: "",
      },
    });

    assert.ok(buffer.length > 100 && buffer[0] === 0x50 && buffer[1] === 0x4b, "the workbook must be a valid .xlsx");

    const zip = await JSZip.loadAsync(buffer);
    let outlined = 0;
    let collapsedButVisible = 0;
    for (const name of Object.keys(zip.files)) {
      if (!/worksheets\/sheet\d+\.xml$/.test(name)) continue;
      const xml = await zip.files[name].async("string");
      for (const rowXml of xml.match(/<row [^>]*>/g) ?? []) {
        if (/outlineLevel="[1-9]/.test(rowXml)) outlined += 1;
        if (/collapsed="1"/.test(rowXml) && !/hidden="1"/.test(rowXml)) collapsedButVisible += 1;
      }

      // THE ONE THAT ACTUALLY BROKE EXCEL. OOXML's CT_SheetPr is a SEQUENCE —
      // tabColor -> outlinePr -> pageSetUpPr — and ExcelJS 4.4.0 emits pageSetUpPr FIRST. Combining
      // fitToPage with outlineProperties therefore yields schema-invalid XML that is still
      // well-formed, so nothing but Excel notices: it reports "Load error. Line 2, column 0" and
      // offers to repair the workbook. Assert the order rather than the absence, so the day ExcelJS
      // fixes its xform this test stops complaining instead of blocking the improvement.
      const sheetPr = /<sheetPr>(.*?)<\/sheetPr>/.exec(xml)?.[1] ?? "";
      const outlineAt = sheetPr.indexOf("<outlinePr");
      const pageSetupAt = sheetPr.indexOf("<pageSetUpPr");
      if (outlineAt >= 0 && pageSetupAt >= 0) {
        assert.ok(
          outlineAt < pageSetupAt,
          `${name}: <outlinePr> must precede <pageSetUpPr> inside <sheetPr> — Excel rejects the sheet otherwise. Got: ${sheetPr}`,
        );
      }
    }
    assert.ok(outlined > 0, "Tab 2 must actually carry outline levels — otherwise it cannot collapse");
    assert.equal(
      collapsedButVisible,
      0,
      `${collapsedButVisible} row(s) are marked collapsed while still visible — Excel will offer to repair this file`,
    );

    // The area names must be printed, never the codes.
    const shared = await zip.file("xl/sharedStrings.xml")?.async("string");
    assert.ok(shared?.includes("Heliopolis"), "areas must print as names");
    assert.ok(!/>CA1</.test(shared ?? ""), "an area CODE must never reach the sheet");

    // The new tab must actually be in the book, named, and beside the MTD tab it extends.
    const workbookXml = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
    // Attribute-order agnostic on purpose: ExcelJS emits `sheetId` BEFORE `name`, so a regex anchored
    // on `<sheet name=` matches nothing and the tab looks absent when it is in fact present.
    const sheetNames = [...workbookXml.matchAll(/<sheet\b[^>]*\sname="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(sheetNames.length >= 6, `could not read the sheet list from workbook.xml — got ${sheetNames.length} names`);
    assert.ok(sheetNames.includes("Month vs Target"), `Month vs Target tab missing — got ${sheetNames.join(", ")}`);
    assert.equal(
      sheetNames.indexOf("Month vs Target"),
      sheetNames.indexOf("MTD by Distributor") + 1,
      "Month vs Target must sit directly after MTD by Distributor — both measure the same month",
    );

    // ── The tab is a decision, not an array: hidden, blocked, or shown ─────────
    const readSheets = async (vsTarget: VsTargetTabInput) => {
      const built = await buildWeeklySummaryWorkbook({ ...base, vsTarget });
      const zipped = await JSZip.loadAsync(built);
      const bookXml = (await zipped.file("xl/workbook.xml")?.async("string")) ?? "";
      return {
        names: [...bookXml.matchAll(/<sheet\b[^>]*\sname="([^"]+)"/g)].map((match) => match[1]),
        strings: (await zipped.file("xl/sharedStrings.xml")?.async("string")) ?? "",
      };
    };

    // A Medical Rep gets NO Month vs Target sheet — and the other five are untouched, which is the
    // half of the owner's decision that a "hide the rows" implementation would quietly break.
    const hidden = await readSheets({ kind: "hidden" });
    assert.ok(
      !hidden.names.includes("Month vs Target"),
      `a hidden vs-target tab must write no sheet at all — got ${hidden.names.join(", ")}`,
    );
    assert.equal(
      hidden.names.length,
      sheetNames.length - 1,
      "hiding Tab 6 must remove exactly one sheet and leave the other five in place",
    );

    // Blocked writes ONE sheet carrying the reason. An absent tab would read as "no data this month".
    const blocked = await readSheets({ kind: "blocked", reason: "Distributor filter is active." });
    assert.ok(
      blocked.names.includes("Month vs Target"),
      "a blocked vs-target tab must still write its sheet, so its absence is never guessed at",
    );
    assert.ok(
      blocked.strings.includes("Distributor filter is active."),
      "the blocked sheet must print the reason it was withheld",
    );

    // Multi-month: one section per month, each anchor naming its own month so two "CNS" bands cannot
    // be confused — and each measured against ITS OWN month's target.
    const multi = await readSheets({
      kind: "shown",
      months: [
        { period: "2026-06", monthRows: rows, targets: julyTargets, targetedLines: ["CNS"] },
        { period: "2026-07", monthRows: rows, targets: julyTargets, targetedLines: ["CNS"] },
      ],
      dataNote: "",
    });
    assert.ok(
      multi.strings.includes("CNS — 2026-06") && multi.strings.includes("CNS — 2026-07"),
      "each month must get its own named section anchor when several months are exported together",
    );
  }

  // ── Month vs Target ─────────────────────────────────────────────────────────

  const AREA_INDEX = new Map([
    ["CA1", { areaName: "Heliopolis", regionCode: "CA" }],
    ["CA2", { areaName: "Nasr City", regionCode: "CA" }],
    ["GZ1", { areaName: "Dokki", regionCode: "GZ" }],
  ]);
  const REGION_NAMES = new Map([
    ["CA", "Cairo"],
    ["GZ", "Giza"],
  ]);

  // The headline: sales for the month, target for the whole month, per region and per area, with the
  // area rows summing exactly to the region row above them.
  {
    const sections = buildVsTargetModel(
      [
        factRow({ areaCode: "CA1", regionCode: "CA", salesUnits: 30 }),
        factRow({ areaCode: "CA2", regionCode: "CA", salesUnits: 20 }),
        factRow({ areaCode: "GZ1", regionCode: "GZ", salesUnits: 90 }),
      ],
      [
        { lineLabel: "CNS", areaCode: "CA1", targetUnits: 60 },
        { lineLabel: "CNS", areaCode: "CA2", targetUnits: 40 },
        { lineLabel: "CNS", areaCode: "GZ1", targetUnits: 90 },
      ],
      AREA_INDEX,
      ["CNS"],
      REGION_NAMES,
    );

    assert.equal(sections.length, 1, "one line in, one section out");
    const cns = sections[0];
    assert.equal(cns.hasTarget, true);
    assert.equal(cns.salesUnits, 140);
    assert.equal(cns.targetUnits, 190);

    const regions = cns.regions.map((region) => region.label);
    assert.deepEqual(regions, ["Cairo", "Giza"], "regions follow the Monthly Closing order, by NAME");

    const cairo = cns.regions[0];
    assert.equal(cairo.salesUnits, 50);
    assert.equal(cairo.targetUnits, 100);
    assert.equal(cairo.achievement, 0.5);
    assert.equal(
      cairo.areas.reduce((sum, area) => sum + area.salesUnits, 0),
      cairo.salesUnits,
      "a region row must be exactly the sum of the area rows under it, or the sheet does not reconcile",
    );
    assert.equal(cns.regions[1].achievement, 1, "Giza sold its whole target");
  }

  // A region is the AREA's region, never the branch's. Where the two disagree the area row would
  // otherwise land under one region while its target sat under another, and the column would stop
  // adding up. Here the branch says Giza and the area map says Cairo — Cairo wins.
  {
    const sections = buildVsTargetModel(
      [factRow({ areaCode: "CA1", regionCode: "GZ", regionName: "Giza", salesUnits: 25 })],
      [{ lineLabel: "CNS", areaCode: "CA1", targetUnits: 50 }],
      AREA_INDEX,
      ["CNS"],
      REGION_NAMES,
    );
    assert.deepEqual(sections[0].regions.map((region) => region.label), ["Cairo"]);
    assert.equal(sections[0].regions[0].achievement, 0.5, "sales and target must meet in ONE region");
  }

  // An area with a target and NO sales is the single most important row on the tab — it must appear.
  // An area with sales and no target must appear too, reading as a dash, never as 0%.
  {
    const sections = buildVsTargetModel(
      [factRow({ areaCode: "CA1", regionCode: "CA", salesUnits: 10 })],
      [
        { lineLabel: "CNS", areaCode: "CA1", targetUnits: 40 },
        { lineLabel: "CNS", areaCode: "CA2", targetUnits: 80 },
      ],
      AREA_INDEX,
      ["CNS"],
      REGION_NAMES,
    );
    const labels = sections[0].regions[0].areas.map((area) => area.label);
    assert.deepEqual(labels.sort(), ["Heliopolis", "Nasr City"], "a targeted area with zero sales must still be listed");
    const silent = sections[0].regions[0].areas.find((area) => area.label === "Nasr City");
    assert.equal(silent?.salesUnits, 0);
    assert.equal(silent?.achievement, 0, "zero sales against a real target IS 0% — that is the point");
  }

  // Sales that no area owns are ~29% of the rows in production. They must land in a named row inside
  // their own region, carry no target, and never dilute a real area's achievement.
  {
    const sections = buildVsTargetModel(
      [
        factRow({ areaCode: "CA1", regionCode: "CA", salesUnits: 40 }),
        factRow({ areaCode: null, regionCode: "CA", regionName: "Cairo", salesUnits: 500 }),
      ],
      [{ lineLabel: "CNS", areaCode: "CA1", targetUnits: 40 }],
      AREA_INDEX,
      ["CNS"],
      REGION_NAMES,
    );
    const cairo = sections[0].regions[0];
    const bucket = cairo.areas.find((area) => area.unmapped);
    assert.ok(bucket, "the not-area-mapped sales must have their own row");
    assert.equal(bucket?.salesUnits, 500);
    assert.equal(bucket?.targetUnits, 0);
    assert.equal(bucket?.achievement, null, "no target means no percentage — never 0%, never omitted");
    assert.equal(cairo.areas[cairo.areas.length - 1]?.unmapped, true, "the residue closes the region");
    assert.equal(
      cairo.areas.find((area) => area.label === "Heliopolis")?.achievement,
      1,
      "the real area still reads 100% — unowned volume must not be smeared across it",
    );
  }

  // August 2026 in production: CNS and Pedia carry targets, Anti Infective does not. The untargeted
  // line keeps its sales and is flagged; it is never reported as having achieved 0%.
  {
    const sections = buildVsTargetModel(
      [
        factRow({ line: "CNS", areaCode: "CA1", regionCode: "CA", salesUnits: 10 }),
        factRow({ line: "Anti Infective", areaCode: "CA1", regionCode: "CA", salesUnits: 700 }),
      ],
      [{ lineLabel: "CNS", areaCode: "CA1", targetUnits: 40 }],
      AREA_INDEX,
      ["CNS"],
      REGION_NAMES,
    );
    assert.equal(sections.length, 2);
    assert.equal(sections[0].label, "CNS", "a measured line outranks a bigger unmeasured one");
    assert.equal(sections[0].hasTarget, true);
    const anti = sections[1];
    assert.equal(anti.label, "Anti Infective");
    assert.equal(anti.hasTarget, false, "no uploaded target must be reported as such");
    assert.equal(anti.salesUnits, 700, "its sales are still shown in full");
    assert.equal(anti.achievement, null, "and never divided by a target that does not exist");
  }

  // Head Office resolves to no target line at all. It must not silently borrow another line's number.
  {
    const sections = buildVsTargetModel(
      [factRow({ line: "Head Office", areaCode: null, regionCode: "CA", regionName: "Cairo", salesUnits: 12 })],
      [{ lineLabel: "CNS", areaCode: "CA1", targetUnits: 40 }],
      AREA_INDEX,
      ["CNS"],
      REGION_NAMES,
    );
    const headOffice = sections.find((section) => section.label === "Head Office");
    assert.ok(headOffice, "Head Office sales must still be reported");
    assert.equal(headOffice?.targetUnits, 0);
    assert.equal(headOffice?.hasTarget, false);
  }
}
