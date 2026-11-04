import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";

import {
  buildRepRanking,
  carveByArea,
  carveChannelsByArea,
  UNASSIGNED_TEAM,
} from "../src/lib/sales/closing-rep-ranking.ts";
import { isRepRankingLine, resolveTrendPeriods } from "../src/lib/sales/closing-rep-ranking-export.ts";
import { toLegacyShape } from "../src/lib/sales/closing-rep-ranking-legacy-shape.ts";
import {
  describeRankingFilters,
  narrowClosingMatrixForRanking,
  rankingFiltersAreEmpty,
  searchedAreaCodes,
} from "../src/lib/sales/closing-rep-ranking-filter.ts";
import { buildRepRankingWorkbook } from "../src/lib/sales/closing-rep-ranking-workbook.ts";
import {
  ANTI_INFECTIVE_RANKING_DRESS,
  CNS_RANKING_DRESS,
  PEDIA_RANKING_DRESS,
  dressedRankingLines,
  rankingDressFor,
} from "../src/lib/sales/closing-ranking-dress.ts";
import type { AreaSeatAssignment } from "../src/lib/sales/closing-performance-review.ts";
import type { ClosingDetailRow } from "../src/lib/sales/monthly-closing-details.ts";
import type { MonthlyClosingMatrix } from "../src/lib/sales/monthly-distributor-import.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE EMPLOYEE PORTAL'S ANTI INFECTIVE CLOSING EXPORT IS THE REP RANKING WORKBOOK.
//
// These are the invariants the scratchpad build proved by BREAKING the builder thirty-nine times,
// carried into the repository so an edit cannot quietly undo one. The two that matter most are the
// arrangement the owner corrected on 2026-10-13 — a district's reps together, then ONE banded
// manager line carrying his whole district — and the collapsed-flag defect, which hid every rep's
// products from the exported PDF while leaving every row in the file.
//
// No database: the ranking is pure arithmetic over matrices handed in exactly as the portal loader
// hands them over, so a failure here names a broken rule and never a fixture outage.
// ─────────────────────────────────────────────────────────────────────────────

const LINE = "Anti Infective";
const PERIOD = "2026-09";

type CellSpec = { sales: number; target?: number | null; units?: number; targetUnits?: number | null };
type AreaSpec = {
  areaCode: string;
  areaName: string;
  cells: Array<CellSpec | null>;
  regionCode: string;
  regionName: string;
};

const PRODUCTS = [
  { family: "Royafloxacin", productCode: "RF500", productName: "Royafloxacin 500" },
  { family: "Saginkgo", productCode: "SG120", productName: "Saginkgo 120" },
];

/** A matrix in the exact shape loadPortalMonthlyClosing hands back, with every total re-derived. */
function matrixOf(period: string, areas: readonly AreaSpec[]): MonthlyClosingMatrix {
  const cellOf = (spec: CellSpec | null) => ({
    achievement: spec && spec.target ? spec.sales / spec.target : null,
    salesUnits: spec?.units ?? 0,
    salesValue: spec?.sales ?? 0,
    targetUnits: spec?.targetUnits ?? null,
    targetValue: spec?.target ?? null,
  });
  const sumOf = (specs: Array<CellSpec | null>) => {
    const real = specs.filter((spec): spec is CellSpec => Boolean(spec));
    const targeted = real.filter((spec) => spec.target != null);
    return cellOf({
      sales: real.reduce((total, spec) => total + spec.sales, 0),
      target: targeted.length > 0 ? targeted.reduce((total, spec) => total + Number(spec.target), 0) : null,
      targetUnits: real.reduce<number | null>(
        (total, spec) => (spec.targetUnits == null ? total : (total ?? 0) + spec.targetUnits),
        null,
      ),
      units: real.reduce((total, spec) => total + (spec.units ?? 0), 0),
    });
  };
  const columnTotals = (rows: Array<Array<CellSpec | null>>) =>
    PRODUCTS.map((_product, index) => sumOf(rows.map((row) => row[index] ?? null)));

  const byRegion = new Map<string, AreaSpec[]>();
  for (const area of areas) {
    byRegion.set(area.regionCode, [...(byRegion.get(area.regionCode) ?? []), area]);
  }
  const regions = [...byRegion.entries()].map(([regionCode, list]) => ({
    areas: list.map((area) => ({
      areaCode: area.areaCode,
      areaName: area.areaName,
      cells: area.cells.map(cellOf),
      kind: "area" as const,
      regionCode: area.regionCode,
      regionName: area.regionName,
      rowTotal: sumOf(area.cells),
    })),
    regionCode,
    regionName: list[0]!.regionName,
    subtotal: {
      cells: columnTotals(list.map((area) => area.cells)),
      kind: "regionSubtotal" as const,
      regionCode,
      regionName: list[0]!.regionName,
      rowTotal: sumOf(list.flatMap((area) => area.cells)),
    },
  }));

  return {
    availableLines: [LINE],
    availablePeriods: ["2026-07", "2026-08", "2026-09"],
    columns: PRODUCTS,
    grandTotal: {
      cells: columnTotals(areas.map((area) => area.cells)),
      kind: "grandTotal",
      rowTotal: sumOf(areas.flatMap((area) => area.cells)),
    },
    line: LINE,
    period,
    regions,
  } as MonthlyClosingMatrix;
}

const DELTA = { regionCode: "DL", regionName: "Delta" };
const UPPER = { regionCode: "UE", regionName: "Upper Egypt" };

/** July: one seat that still exists, plus an area that stopped selling before the closing month. */
const JULY: AreaSpec[] = [
  { ...DELTA, areaCode: "DK1", areaName: "Dakahlia 1", cells: [{ sales: 90_000, target: 90_000, units: 700 }, null] },
  { ...DELTA, areaCode: "GONE", areaName: "Closed area", cells: [{ sales: 15_000, target: null }, null] },
];

const AUGUST: AreaSpec[] = [
  { ...DELTA, areaCode: "DK1", areaName: "Dakahlia 1", cells: [{ sales: 100_000, target: 95_000, units: 820 }, null] },
];

/** September: two districts of two seats, one seat vacant, one seat with no manager and no target. */
const SEPTEMBER: AreaSpec[] = [
  {
    ...DELTA,
    areaCode: "DK1",
    areaName: "Dakahlia 1",
    cells: [
      { sales: 120_000, target: 100_000, targetUnits: 900, units: 1_000 },
      { sales: 30_000, target: 40_000, targetUnits: 300, units: 250 },
    ],
  },
  {
    ...DELTA,
    areaCode: "DK2",
    areaName: "Dakahlia 2",
    cells: [{ sales: 60_000, target: 90_000, targetUnits: 800, units: 500 }, null],
  },
  {
    ...DELTA,
    areaCode: "MN1",
    areaName: "Menoufia 1",
    cells: [
      { sales: 200_000, target: 100_000, targetUnits: 900, units: 1_600 },
      { sales: 10_000, target: 10_000, targetUnits: 90, units: 80 },
    ],
  },
  {
    ...DELTA,
    areaCode: "MN2",
    areaName: "Menoufia 2",
    cells: [{ sales: 40_000, target: 50_000, targetUnits: 400, units: 320 }, null],
  },
  { ...UPPER, areaCode: "ORP", areaName: "Orphan area", cells: [{ sales: 25_000, target: null }, null] },
  // No manager AND a target it beat three times over: without the explicit "Not assigned last" rule
  // this district would sort FIRST, which is what gives that assertion its teeth.
  {
    ...UPPER,
    areaCode: "NOM",
    areaName: "Nobody's area",
    cells: [{ sales: 300_000, target: 100_000, targetUnits: 900, units: 2_400 }, null],
  },
];

const SEATS = new Map<string, AreaSeatAssignment>([
  ["antiinfective::DK1", { managerName: "Hany Mansour", repIsVacant: false, repName: "Ahmed Said" }],
  ["antiinfective::DK2", { managerName: "Hany Mansour", repIsVacant: true, repName: null }],
  ["antiinfective::MN1", { managerName: "Tarek Fouad", repIsVacant: false, repName: "Mona Adel" }],
  ["antiinfective::MN2", { managerName: "Tarek Fouad", repIsVacant: false, repName: "Sara Nabil" }],
  ["antiinfective::ORP", { managerName: null, repIsVacant: false, repName: "Khaled Omar" }],
  ["antiinfective::NOM", { managerName: null, repIsVacant: false, repName: "Nour Hassan" }],
]);

/**
 * The three-month trend, and — since 2026-10-13 — a SHORTER one on demand.
 *
 * 🔴 THE TREND IS NOT ALWAYS THREE MONTHS, and assuming it was lost the owner his download. With
 * only July and August published on Anti Infective, September's trend held two months and July's
 * held ONE, and the Trust sheet's `monthName(TREND[2])` reached `.split` on undefined: "Cannot read
 * properties of undefined (reading 'split')" instead of a workbook. `months` builds the same
 * ranking over the last N months so the one-month and two-month shapes are exercised here.
 */
function ranking(months: 1 | 2 | 3 = 3, line: string = LINE) {
  const all = [
    { matrix: matrixOf("2026-07", JULY), period: "2026-07" },
    { matrix: matrixOf("2026-08", AUGUST), period: "2026-08" },
    { matrix: matrixOf(PERIOD, SEPTEMBER), period: PERIOD },
  ];
  return buildRepRanking({
    directByArea: new Map([[`${PERIOD}|MN1`, 20_000]]),
    line,
    matricesByPeriod: all.slice(all.length - months),
    period: PERIOD,
    probationByName: new Map([["Sara Nabil", "2026-12-01"]]),
    seats: SEATS,
    storesByArea: new Map([[`${PERIOD}|DK1`, 50_000]]),
    warehouseCustomers: 7,
  });
}

export async function runClosingRepRankingTests(): Promise<void> {
  // ── The gate: the lines that have an identity to wear it in, and no other ────────────────────
  assert.ok(isRepRankingLine("Anti Infective"), "Anti Infective takes the ranking workbook");
  assert.ok(isRepRankingLine("anti infective"), "...however the line is spelled");
  assert.ok(isRepRankingLine("CNS"), "and CNS, which the owner added on 2026-10-13");
  assert.ok(isRepRankingLine("cns"), "...however that line is spelled too");
  assert.ok(isRepRankingLine("Pedia"), "and Pedia, which the owner added on 2026-10-13");
  assert.ok(isRepRankingLine("  pedia "), "...spaced and cased however it arrives");
  for (const other of ["Head Office", "", null]) {
    assert.ok(!isRepRankingLine(other), `${String(other)} keeps the export it already had`);
  }

  // 🔴 THE GATE AND THE DRESS REGISTRY ARE ONE LIST IN TWO FILES, and they must answer alike. A
  // line the gate lets through with no dress reaches the builder undressed and throws instead of
  // downloading; a dress with no gate is art nothing can ever open. The builder cannot catch either
  // one, because it only ever sees the line it was called with.
  for (const line of dressedRankingLines()) {
    assert.ok(isRepRankingLine(line), `${line} has a dress, so the gate must let it through`);
  }
  for (const line of ["Anti Infective", "CNS", "Pedia"]) {
    assert.ok(rankingDressFor(line), `${line} passes the gate, so it must have a dress`);
  }
  assert.equal(dressedRankingLines().length, 3, "three dressed lines — Head Office still has none");
  assert.equal(rankingDressFor("Head Office"), null, "and an undressed line answers null, never a default");

  // THE TWO DRESSES ARE DIFFERENT LOOKS, not one look with a different folder. Checked on the
  // tokens a reader actually sees, so a copy-paste that left the navy behind fails here.
  assert.notEqual(ANTI_INFECTIVE_RANKING_DRESS.colours.field, CNS_RANKING_DRESS.colours.field);
  assert.notEqual(ANTI_INFECTIVE_RANKING_DRESS.colours.covered, CNS_RANKING_DRESS.colours.covered);
  assert.notEqual(ANTI_INFECTIVE_RANKING_DRESS.bannerDir, CNS_RANKING_DRESS.bannerDir);
  // 🔴 THE SEAM'S ORDER IS THE IDENTITY'S OWN AND THE TWO RUN OPPOSITE WAYS. Anti-Infective runs
  // Royafloxacin red into Saginkgo blue; CNS runs Tebofortin leaf into Tebofortin amber, which is
  // the reverse of its accent pairing. Deriving the seam from short/covered would flip one of them.
  assert.equal(ANTI_INFECTIVE_RANKING_DRESS.colours.seamLeft, ANTI_INFECTIVE_RANKING_DRESS.colours.short);
  assert.equal(CNS_RANKING_DRESS.colours.seamLeft, CNS_RANKING_DRESS.colours.covered, "leaf on the left");
  assert.equal(CNS_RANKING_DRESS.colours.seamRight, CNS_RANKING_DRESS.colours.short, "amber on the right");
  // Pedia runs the OTHER way round from CNS: gold (its alarm colour) on the left, aqua (covered)
  // on the right, which is the order the identity's own seam is drawn in.
  assert.equal(PEDIA_RANKING_DRESS.colours.seamLeft, PEDIA_RANKING_DRESS.colours.short, "gold on the left");
  assert.equal(PEDIA_RANKING_DRESS.colours.seamRight, PEDIA_RANKING_DRESS.colours.covered, "aqua on the right");
  assert.notEqual(PEDIA_RANKING_DRESS.colours.field, CNS_RANKING_DRESS.colours.field);
  assert.notEqual(PEDIA_RANKING_DRESS.bannerDir, CNS_RANKING_DRESS.bannerDir);

  // ── Every dressed line's chrome is really committed ──────────────────────────────────────────
  // The builder reads these ten files off disk at build time and throws if one is missing, so a
  // line named in the gate with no art turns its download into an error page.
  for (const dress of [ANTI_INFECTIVE_RANKING_DRESS, CNS_RANKING_DRESS, PEDIA_RANKING_DRESS]) {
    for (const file of [
      "banner-full.png", "strip-districts.png", "strip-filter.png", "strip-months.png",
      "strip-product.png", "strip-ranking.png", "strip-regions.png", "strip-trend.png",
      "strip-units.png", "strip-who.png",
    ]) {
      const bytes = readFileSync(resolve(process.cwd(), dress.bannerDir, file));
      assert.ok(bytes.length > 10_000, `${dress.bannerDir}/${file} is a real render`);
      assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG", `${file} is a PNG`);
    }
  }

  // ── The trend is PUBLISHED months, oldest first, never a calendar ─────────────────────────────
  assert.deepEqual(
    resolveTrendPeriods(["2026-09", "2026-08", "2026-07", "2026-06"], "2026-09"),
    ["2026-07", "2026-08", "2026-09"],
    "the closing month and the two published months before it, oldest first",
  );
  assert.deepEqual(
    resolveTrendPeriods(["2026-09", "2026-06"], "2026-09"),
    ["2026-06", "2026-09"],
    "a gap in the published months stays a gap — never a month invented to fill it",
  );
  assert.deepEqual(
    resolveTrendPeriods(["2026-09", "2026-08"], "2026-08"),
    ["2026-08"],
    "a month with nothing published before it trends over itself alone",
  );
  assert.deepEqual(
    resolveTrendPeriods(["2026-09"], "2026-05"),
    ["2026-05"],
    "a month outside this viewer's published list never widens the trend",
  );

  const report = ranking();
  assert.deepEqual(report.trend, ["2026-07", "2026-08", "2026-09"]);

  // ── An untargeted seat is UNRANKED, never scored 0% ───────────────────────────────────────────
  const orphan = report.seats.find((seat) => seat.areaCode === "ORP")!;
  assert.equal(orphan.targetValue, null, "the orphan seat carries no target");
  assert.equal(orphan.achievement, null, "...so it has no achievement");
  assert.equal(orphan.rank, null, "...and no rank");
  assert.equal(report.seats.at(-1)!.areaCode, "ORP", "an unranked seat sorts after every ranked one");
  assert.equal(report.totals.rankedCount, 5, "five of the six seats are ranked");
  assert.equal(orphan.managerName, UNASSIGNED_TEAM, "a seat with no manager is labelled, never blank");

  // ── A vacant seat is RANKED, not hidden ───────────────────────────────────────────────────────
  const vacant = report.seats.find((seat) => seat.areaCode === "DK2")!;
  assert.ok(vacant.vacant, "DK2 has a seat and nobody in it");
  assert.ok(vacant.rank !== null, "a vacant seat still carries a rank");
  assert.equal(vacant.salesValue, 60_000, "and its money is still on the sheet");
  assert.equal(report.totals.vacantCount, 1);

  // ── The ranking is by achievement, high to low ────────────────────────────────────────────────
  assert.deepEqual(
    report.seats.filter((seat) => seat.rank !== null).map((seat) => seat.areaCode),
    ["NOM", "MN1", "DK1", "MN2", "DK2"],
    "300% then 191% then 107% then 80% then 67%",
  );

  // ── THE ARRANGEMENT (owner, 2026-10-13) ──────────────────────────────────────────────────────
  // His correction: "arrange them to be reps first then their district manager then another rep
  // team then district manager, as today's arrangement in the closing matrix".
  assert.equal(
    new Set(report.teams.map((team) => team.managerName)).size,
    report.teams.length,
    "🔴 A MANAGER APPEARS ONCE. He closes his own team; he is never repeated under every rep.",
  );
  assert.deepEqual(
    report.teams.map((team) => team.managerName),
    ["Tarek Fouad", "Hany Mansour", UNASSIGNED_TEAM],
    "teams in the districts' own achievement order, 'Not assigned' last",
  );
  const unassigned = report.teams.at(-1)!;
  assert.ok(
    (unassigned.achievement ?? 0) > (report.teams[0]!.achievement ?? 0),
    "and it is last although it OUT-ACHIEVED every real district — only the rule puts it there",
  );
  const hany = report.teams.find((team) => team.managerName === "Hany Mansour")!;
  assert.deepEqual(
    hany.seats.map((seat) => seat.areaCode),
    ["DK1", "DK2"],
    "a district holds exactly the seats reporting to that manager, in the ranking's own order",
  );
  assert.equal(
    hany.salesValue,
    hany.seats.reduce((total, seat) => total + seat.salesValue, 0),
    "a manager's line is his whole district — the reps above it added together",
  );
  assert.ok(report.teams.every((team) => team.seats.length > 0), "no team is emitted without reps");
  assert.equal(
    report.teams.reduce((total, team) => total + team.seats.length, 0),
    report.seats.length,
    "every seat sits in exactly one team",
  );

  // ── A district is VALUE OVER VALUE, never the mean of its seats' percentages ───────────────────
  assert.equal(hany.achievement, 210_000 / 230_000, "value over value");
  const meanOfSeats = hany.seats.reduce((total, seat) => total + (seat.achievement ?? 0), 0) / hany.seats.length;
  assert.ok(
    Math.abs(meanOfSeats - (hany.achievement ?? 0)) > 1e-6,
    "and the fixture is built so the mean would be a DIFFERENT number — the check has teeth",
  );

  // ── The three channels add to the closing's own sales ──────────────────────────────────────────
  for (const seat of report.seats) {
    assert.ok(
      Math.abs(seat.channels.distributor + seat.channels.stores + seat.channels.direct - seat.salesValue) < 0.01,
      `${seat.areaName}: distributor + stores + direct must equal the published sales`,
    );
  }
  const dakahlia = report.seats.find((seat) => seat.areaCode === "DK1")!;
  const menoufia = report.seats.find((seat) => seat.areaCode === "MN1")!;
  assert.equal(dakahlia.channels.stores, 50_000, "the warehouse carve reaches the seat");
  assert.equal(dakahlia.channels.distributor, 100_000, "and comes OUT of the distributor book");
  assert.equal(menoufia.channels.direct, 20_000);
  assert.equal(
    report.totals.channels.distributor + report.totals.channels.stores + report.totals.channels.direct,
    report.totals.salesValue,
    "and they add at the line too",
  );

  // ── Absence is never a zero ───────────────────────────────────────────────────────────────────
  assert.equal(menoufia.months.length, 3, "one entry per trend month");
  assert.equal(menoufia.months[0], null, "a month the closing never published for a seat is null");
  assert.equal(menoufia.monthTargets[0], null, "...and so is that month's target");
  assert.equal(dakahlia.months[1], 100_000, "August's own figure");
  assert.equal(dakahlia.monthTargets[1], 95_000, "August's OWN target, never September's reused");
  assert.equal(dakahlia.monthTargets[2], 140_000, "September's own");
  assert.notEqual(
    dakahlia.monthTargets[1],
    dakahlia.monthTargets[2],
    "the two months differ, so the per-month target check has teeth",
  );

  // ── Probation marks the rep it belongs to, and nobody else ────────────────────────────────────
  assert.equal(report.seats.find((seat) => seat.areaCode === "MN2")!.probationEndsOn, "2026-12-01");
  assert.equal(dakahlia.probationEndsOn, null);
  assert.equal(report.totals.probationCount, 1);

  // ── An area that sold earlier and holds no seat now is carried, never dropped ─────────────────
  assert.deepEqual(
    report.seatlessAreas.map((seat) => seat.areaCode),
    ["GONE"],
    "the quarter's seatless area is kept at the foot",
  );
  assert.equal(report.seatlessAreas[0]!.months[0], 15_000, "with its own month's money");
  assert.equal(report.seatlessAreas[0]!.rank, null, "unranked — it is money, not a performance");

  // ── The warehouse carve ───────────────────────────────────────────────────────────────────────
  const rows = [
    { areaCode: "DK1", clientCode: "C1", clientName: "مخزن الاهرام", distributorCode: "EG", includedInClosing: true, invoicePeriod: PERIOD, isDirect: false, productCode: "RF500", salesValue: 30_000 },
    { areaCode: "DK1", clientCode: "C1", clientName: "مخزن الاهرام", distributorCode: "EG", includedInClosing: true, invoicePeriod: PERIOD, isDirect: false, productCode: "RF500", salesValue: 20_000 },
    { areaCode: "DK1", clientCode: "C9", clientName: "Sayed Pharmacy", distributorCode: "EG", includedInClosing: true, invoicePeriod: PERIOD, isDirect: false, productCode: "RF500", salesValue: 70_000 },
    { areaCode: "MN1", clientCode: "C7", clientName: "A Hospital", distributorCode: "EG", includedInClosing: false, invoicePeriod: PERIOD, isDirect: true, productCode: "RF500", salesValue: 20_000 },
    { areaCode: "", clientCode: "C8", clientName: "No area at all", distributorCode: "EG", includedInClosing: false, invoicePeriod: PERIOD, isDirect: true, productCode: "RF500", salesValue: 99_000 },
  ] as unknown as ClosingDetailRow[];
  const carve = carveChannelsByArea(rows, LINE);
  // The warehouse words are ARABIC — the distributor sheets name customers in Arabic, so an
  // English "Stores" is a pharmacy to this rule and the fixture has to use the real thing.
  assert.equal(carve.stores.get(`${PERIOD}|DK1|RF500`), 50_000, "the two warehouse invoices add up");
  assert.equal(carve.direct.get(`${PERIOD}|MN1|RF500`), 20_000, "a direct row lands in the direct map");
  assert.ok(!carve.stores.has(`${PERIOD}|MN1|RF500`), "a direct row is never also a warehouse row");
  assert.equal(carve.warehouseCustomers.size, 1, "two invoices to one warehouse are one customer");
  assert.equal(
    [...carve.direct.values()].reduce((total, value) => total + value, 0),
    20_000,
    "a direct row with no area is skipped, never spread — that would be inventing geography",
  );
  assert.equal(carveByArea(carve.stores).get(`${PERIOD}|DK1`), 50_000, "and the carve rolls up to the area");

  // ── The shape the sheets read ─────────────────────────────────────────────────────────────────
  const legacy = toLegacyShape(report, new Map(), carve, []);
  assert.equal(legacy.SEATS.rows.length, 6);
  assert.equal(legacy.SEATS.ranked, 5);
  assert.equal(legacy.SEATS.total, report.totals.salesValue);
  assert.equal(legacy.TEAMS.length, 3);
  assert.equal(legacy.TEAMS[0]!.dm, "Tarek Fouad", "the teams keep the ranking's own order");
  assert.equal(legacy.TEAMS[1]!.d.vacant, 1, "a district counts its vacant seats");
  const legacyDakahlia = legacy.SEATS.rows.find((row) => row.code === "DK1")!;
  assert.equal(
    legacyDakahlia.distOnly,
    legacyDakahlia.dist - 50_000,
    "distOnly is the distributor book with the warehouses taken out",
  );
  assert.equal(legacyDakahlia.distOnly + legacyDakahlia.store + legacyDakahlia.dir, legacyDakahlia.sales);
  assert.equal(legacy.lineTarget("2026-08"), 95_000, "each month's own line target");
  assert.equal(legacy.lineTarget(PERIOD), report.totals.targetValue, "and the closing month's");
  assert.equal(legacy.targetRows("2026-08").length, 1, "August gave exactly one seat a target");
  assert.equal(legacy.lineSales("2026-07"), 105_000, "July's line includes the seatless area's money");
  assert.ok(legacy.cellsOf(PERIOD).length > 0, "the month's published cells are countable");
  assert.equal(legacy.warehouseCustomers, 7);

  // ── THE EMITTED FILE ──────────────────────────────────────────────────────────────────────────
  const built = await buildRepRankingWorkbook({
    carve: { direct: carve.direct, office: carve.office, stores: carve.stores },
    probationByName: new Map(),
    publications: [{ period: PERIOD, published_at: "2026-10-01T09:00:00Z", published_by: "B-10", unpublished_at: null }],
    ranking: report,
  });

  assert.ok(built.facts.sheetNames.includes("Ranking"), "the lead sheet is there");
  assert.ok(built.facts.sheetNames.includes("Trust"), "and the provenance sheet");
  assert.ok(built.facts.sheetNames.length >= 9, `nine tabs or more, got ${built.facts.sheetNames.length}`);
  assert.equal(
    built.facts.sheetNames.length,
    new Set(built.facts.sheetNames).size,
    "no sheet is emitted twice",
  );
  // One rendered strip per sheet, registered on FIRST USE — so a workbook that drops a sheet never
  // still carries that sheet's chrome inside it.
  assert.equal(built.facts.bannersEmbedded, built.facts.sheetNames.length, "the identity dress is embedded");
  assert.equal(built.facts.openSheets, built.facts.sheetNames.length, "every tab is left unprotected");
  assert.ok(built.facts.productRows > 0, "the product rows are really in the file");

  const zip = await JSZip.loadAsync(built.buffer);
  const sheetFiles = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  assert.equal(sheetFiles.length, built.facts.sheetNames.length);
  let outlined = 0;
  for (const name of sheetFiles) {
    const xml = await zip.file(name)!.async("string");
    // 🔴 THE DEFECT THAT HID EVERY REP'S PRODUCTS FROM THE PDF. ExcelJS stamps collapsed="1" on
    // every outlined row; Excel ignores it, LibreOffice folds the group, and LibreOffice renders the
    // PDF. Every row was in the file and the reader saw one rep's products per team.
    assert.ok(!xml.includes('collapsed="1"'), `${name}: no row may leave the server collapsed`);
    assert.ok(!xml.includes('hidden="1"'), `${name}: nor hidden`);
    assert.ok(!xml.includes("<sheetProtection"), `${name}: not protected`);
    outlined += [...xml.matchAll(/\soutlineLevel="\d+"/g)].length;
    // Duplicated cfRule priorities are what make Excel "repair" the file and drop the formats.
    const priorities = [...xml.matchAll(/<cfRule\b[^>]*?priority="(\d+)"/g)].map((match) => Number(match[1]));
    assert.deepEqual(
      priorities,
      priorities.map((_value, index) => index + 1),
      `${name}: conditional-format priorities run 1..n`,
    );
    assert.ok(!xml.includes("<x14:id/>"), `${name}: the dangling data-bar extension is stripped`);
  }
  assert.ok(outlined > 0, "the workbook really is outlined — otherwise the collapse checks pass vacuously");

  // ── THE ROWS TAB — every counted row, in the emitted file ─────────────────────────────────────
  // Owner, 2026-10-13: "I want the raw detailed sheet to be in the export rep ranking in monthly
  // closing." The arrangement is pinned in tests/closing-rows-sheet.test.ts; what is checked HERE
  // is the thing only the built file can answer — that the tab lands, where it lands, that its
  // total is written as a number, and that El Qema survives nowhere in the zip.
  const detailRows = [
    { clientName: "Sayed Pharmacy", distributorCode: "IS", id: 9_001, salesValue: 1_000 },
    { clientName: "El Qema's own customer", distributorCode: "QM", id: 9_002, salesValue: 500 },
  ].map((row) => ({
    areaCode: "DK1", areaMismatch: false, areaName: "Dakahlia 1", blockCode: "B1", bonusQty: 0,
    brickId: "B184-4", brickName: "Mansoura", brickUnmapped: false,
    clientAddress: "12 Gomhoria Street", clientCode: `C${row.id}`, discount: 0,
    effectiveUnits: 10, evenSplitApplied: false, exclusions: [], factoryPrice: 100, family: "RF",
    includedInClosing: true, invoiceDate: "2026-09-07", invoicePeriod: PERIOD, invoiceRef: "0/1/1/18743",
    isConfidential: false, isDirect: false, missingClientCode: false, officialLine: LINE,
    operationalRegionCode: "DL", operationalRegionName: "Delta", productCode: "RF500",
    productName: "Royafloxacin 500 mg", qty: 10, regionCode: "DL", regionName: "Delta", rowNumber: 1,
    sheetAreaCode: "DK1", sheetAreaName: "Dakahlia 1", sheetRegionCode: "DL", sheetRegionName: "Delta",
    sheetValue: row.salesValue, validationState: "valid", ...row,
  })) as unknown as ClosingDetailRow[];

  const withRows = await buildRepRankingWorkbook({
    carve: { direct: carve.direct, office: carve.office, stores: carve.stores },
    details: detailRows,
    distributorNames: new Map([["IS", "Ibn Sina"], ["QM", "El Qema"]]),
    probationByName: new Map(),
    publications: [{ period: PERIOD, published_at: "2026-10-01T09:00:00Z", published_by: "B-10", unpublished_at: null }],
    ranking: report,
  });
  assert.ok(withRows.facts.sheetNames.includes("Rows"), "the raw detail tab is in the file");
  assert.equal(
    withRows.facts.sheetNames.indexOf("Rows"),
    withRows.facts.sheetNames.indexOf("Trust") - 1,
    "it sits immediately before Trust — Trust lists the workbook's own tabs, so a tab after it is missing from that list",
  );
  assert.equal(
    withRows.facts.sheetNames.length,
    built.facts.sheetNames.length + 1,
    "and it is the only tab the detail rows add",
  );
  // 🔴 EVERY OTHER TAB WEARS A LETTERHEAD STRIP AND THIS ONE DOES NOT — on purpose. Each strip in
  // public/brand/anti-infective-ranking/ names ONE tab and bakes a MONTH into the artwork, so
  // borrowing one would print both the wrong tab name and a month this file may not be.
  assert.equal(
    withRows.facts.bannersEmbedded,
    withRows.facts.sheetNames.length - 1,
    "the Rows tab is the one tab with no strip — there is no artwork for it, and no other tab's may be borrowed",
  );
  assert.equal(withRows.facts.openSheets, withRows.facts.sheetNames.length, "it is unprotected like every other tab");

  // READ BACK WITH EXCEL'S OWN READER, not by grepping the XML: ExcelJS writes text into
  // sharedStrings and leaves an index behind in the sheet, so a grep of the worksheet part finds
  // neither "Ibn Sina" nor a second copy of a repeated word — a check that would pass on an empty
  // sheet as readily as on a full one.
  const readBack = new ExcelJS.Workbook();
  await readBack.xlsx.load(withRows.buffer as unknown as ArrayBuffer);
  const rowsSheet = readBack.getWorksheet("Rows")!;
  assert.ok(rowsSheet, "the tab opens");
  const textOf = (row: number, column: number): string => {
    const value = rowsSheet.getCell(row, column).value;
    return value === null || value === undefined ? "" : String(typeof value === "object" && "richText" in value
      ? (value as { richText: { text: string }[] }).richText.map((part) => part.text).join("")
      : value);
  };
  const cellsOfSheet: string[] = [];
  rowsSheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => cellsOfSheet.push(String(cell.value ?? "")));
  });
  const sheetText = cellsOfSheet.join(" | ");
  assert.ok(sheetText.includes("Ibn Sina"), "the distributor is NAMED on the sheet, never left as its code");
  assert.ok(!cellsOfSheet.includes("IS"), "and its bare code appears in no cell at all");
  assert.ok(sheetText.includes("Main Stores"), "the masked row carries the substituted buyer");
  assert.equal(
    cellsOfSheet.filter((value) => value === "not totalled").length,
    2,
    "🔴 units and bonus units each say they are not totalled — units of different products are never added",
  );
  const totalCell = cellsOfSheet.find((value) => value === "1500");
  assert.ok(totalCell !== undefined, "the foot carries the counted total, 1,500, as a number");
  assert.ok(rowsSheet.autoFilter !== undefined, "the raw sheet can be filtered — the lock allows it");
  assert.ok(
    textOf(1 + 0, 1) !== undefined && rowsSheet.rowCount > detailRows.length,
    "the sheet carries its masthead, its rows and its footnotes",
  );

  // 🔒 EL QEMA LEAVES NO TRACE IN THE WHOLE FILE, not merely on the sheet that was asked to mask it.
  const rowsZip = await JSZip.loadAsync(withRows.buffer);
  for (const name of Object.keys(rowsZip.files).filter((file) => file.endsWith(".xml"))) {
    const xml = await rowsZip.file(name)!.async("string");
    assert.ok(!xml.includes("El Qema&apos;s own customer") && !xml.includes("El Qema's own customer"),
      `${name}: the masked customer survives nowhere`);
  }

  // ── A SHORTER TREND BUILDS — the crash the owner hit on 2026-10-13 ───────────────────────────
  // He clicked Export Rep Ranking on a month whose trend was shorter than three, and the Trust
  // sheet's `monthName(TREND[2])` answered "Cannot read properties of undefined (reading 'split')".
  // This was the FIRST real run of the builder: no Anti Infective month had been published since 9
  // October, so neither the portal export nor the admin button had ever built a file. Both shorter
  // shapes are built here, and their captions are read back out of the emitted workbook — the
  // caption is where the three-month assumption lived, so checking `facts` alone would pass while
  // a sheet still claimed July to September over one month of data.
  for (const months of [1, 2] as const) {
    const shortRanking = ranking(months);
    assert.equal(shortRanking.trend.length, months, `the fixture really trends over ${months} month(s)`);
    const shortBuilt = await buildRepRankingWorkbook({
      carve: { direct: carve.direct, office: carve.office, stores: carve.stores },
      probationByName: new Map(),
      publications: [{ period: PERIOD, published_at: "2026-10-01T09:00:00Z", published_by: "B-10", unpublished_at: null }],
      ranking: shortRanking,
    });
    assert.ok(shortBuilt.buffer.byteLength > 0, `a ${months}-month trend produces a workbook at all`);
    assert.deepEqual(
      shortBuilt.facts.sheetNames,
      built.facts.sheetNames,
      `a ${months}-month trend emits the same sheets — none is dropped for want of a month`,
    );
    const shortZip = await JSZip.loadAsync(shortBuilt.buffer);
    // 🔴 BOTH PLACES, because the two captions live in different parts of the zip: a sheet's
    // subtitle is written into its PRINT FOOTER (`book.dress` → headerFooter.oddFooter → the
    // worksheet xml), while the footnotes are cell text in sharedStrings. Reading only
    // sharedStrings passed a build whose every sheet still footed "July to September 2026" over one
    // month of data — measured on 2026-10-13, which is why this reads both.
    const strings = (await Promise.all(
      Object.keys(shortZip.files)
        .filter((name) => name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
        .map((name) => shortZip.file(name)!.async("string")),
    )).join("\n");
    assert.ok(
      !strings.includes("July to September 2026"),
      `the ${months}-month file must not caption itself July to September — that span is three months`,
    );
    assert.ok(
      !/THE THREE MONTHS|the three months|JULY PLUS AUGUST PLUS SEPTEMBER/.test(strings),
      `nor claim three months in its prose with ${months} month(s) of data`,
    );
    const expectedSpan = months === 1 ? "September 2026" : "August 2026 to September 2026";
    assert.ok(
      strings.includes(expectedSpan),
      `the ${months}-month file names its real span (${expectedSpan})`,
    );
  }

  await assertCnsWearsItsOwnIdentity();
  await assertPediaWearsItsOwnIdentity();
  await assertOfficeIsCnsThirdChannel();
  await assertTheFilterNarrowsTheWholeFile();

  assertAdminRepRankingButton();
  assertSpreadEpdaRowsAreNotStores();
}

/**
 * OFFICE IS CNS'S THIRD CHANNEL, WHERE EVERY OTHER LINE HAS DIRECT ORDERS.
 *
 * Owner, 2026-10-13: "in CNS, instead of the direct order column in channels, you will put office,
 * okay? In only CNS. CNS don't have direct orders. So instead of the direct you will consider the
 * office as the direct, and put it in a separate column in the tab that shows this." Measured on
 * production the same day: CNS 2026-09 has ZERO direct rows and 6,971,180 EGP of Office over 3,960
 * rows — the line's biggest channel.
 *
 * 🔴 THE TWO HALVES BOTH HAVE TEETH HERE. The CARVE half must take Office out of the distributor
 * book, because Office is not a distributor and leaving it in would have the three channel shares
 * read past the sales they divide. The COLUMN half must be measured on the EMITTED header row, not
 * on the HEADS constant: the heading reaches the file through `headerRow`, and a build that
 * resolved the line's third channel correctly and still printed the other line's word is exactly
 * the defect this catches. One line list only — `lineHasOfficeChannel` — so a second list here
 * could not drift from the one the upload enforces.
 */
/**
 * AN EPDA ROW THE CLOSING SPREAD IS NEVER CARVED AS STORES AT ITS INVOICED AREA (owner's EPDA rule 2,
 * 2026-11-04, from the October 2026 closing). The matrix has moved it to the areas that earned it, so
 * a Stores figure at the invoiced area would drive that area's Distributor column below zero.
 */
function assertSpreadEpdaRowsAreNotStores(): void {
  const row = (period: string, distributorCode: string) => ({
    areaCode: "AB1", clientCode: "W1", clientName: "مخزن الحجاز", distributorCode, includedInClosing: true,
    invoicePeriod: period, isDirect: false, officialLine: LINE, productCode: "SA001", salesValue: 9_000,
  });
  const october = carveChannelsByArea([row("2026-10", "EP-BK"), row("2026-10", "IS")] as unknown as ClosingDetailRow[], LINE);
  assert.equal(october.stores.get("2026-10|AB1|SA001"), 9_000, "only the other distributor's warehouse row is Stores in October");
  assert.equal(october.warehouseCustomers.size, 1, "and the spread EPDA customer is not counted as a warehouse");
  const september = carveChannelsByArea([row("2026-09", "EP-BK")] as unknown as ClosingDetailRow[], LINE);
  assert.equal(september.stores.get("2026-09|AB1|SA001"), 9_000, "September spread no Saginko, so its warehouse row stays Stores");
}

async function assertOfficeIsCnsThirdChannel(): Promise<void> {
  const rows = [
    { areaCode: "DK1", clientCode: "C9", clientName: "Sayed Pharmacy", distributorCode: "IS", includedInClosing: true, invoicePeriod: PERIOD, isDirect: false, productCode: "RF500", salesValue: 70_000 },
    { areaCode: "DK1", clientCode: null, clientName: null, distributorCode: "Office", includedInClosing: true, invoicePeriod: PERIOD, isDirect: false, productCode: "RF500", salesValue: 30_000 },
    { areaCode: "DK1", clientCode: "C1", clientName: "مخزن الاهرام", distributorCode: "IS", includedInClosing: true, invoicePeriod: PERIOD, isDirect: false, productCode: "RF500", salesValue: 50_000 },
  ] as unknown as ClosingDetailRow[];

  const cnsCarve = carveChannelsByArea(rows, "CNS");
  assert.equal(cnsCarve.office.get(`${PERIOD}|DK1|RF500`), 30_000, "the Office row lands in the Office map");
  assert.equal(cnsCarve.stores.get(`${PERIOD}|DK1|RF500`), 50_000, "the warehouse row still lands in Stores");
  assert.ok(!cnsCarve.direct.has(`${PERIOD}|DK1|RF500`), "and nothing here is a direct order");
  assert.equal(cnsCarve.warehouseCustomers.size, 1, "an Office row is never counted as a warehouse customer");

  // 🔴 AND NOT ON ANY OTHER LINE. The same rows, read as Anti Infective, carve no Office at all —
  // the gate is the repo's own `lineHasOfficeChannel`, so this is the half that fails if a future
  // edit widens the channel by hand instead of widening that list.
  const aiCarve = carveChannelsByArea(rows, LINE);
  assert.equal(aiCarve.office.size, 0, "Anti Infective has no Office channel, so its map stays empty");
  assert.equal(
    aiCarve.stores.get(`${PERIOD}|DK1|RF500`),
    50_000,
    "and its warehouse carve is untouched by the new one",
  );

  // THE SEAT'S CHANNELS ADD TO ITS SALES, with Office taken OUT of the distributor book.
  const cnsRanking = buildRepRanking({
    directByArea: new Map(),
    line: "CNS",
    matricesByPeriod: [{ matrix: matrixOf(PERIOD, SEPTEMBER), period: PERIOD }],
    officeByArea: carveByArea(cnsCarve.office),
    period: PERIOD,
    probationByName: new Map(),
    seats: new Map(),
    storesByArea: carveByArea(cnsCarve.stores),
    warehouseCustomers: cnsCarve.warehouseCustomers.size,
  });
  const dk1 = cnsRanking.seats.find((seat) => seat.areaCode === "DK1")!;
  assert.equal(dk1.channels.office, 30_000, "the seat carries its Office money");
  assert.equal(dk1.channels.direct, 0, "and no direct money on this line");
  assert.equal(
    dk1.channels.distributor + dk1.channels.stores + dk1.channels.office + dk1.channels.direct,
    dk1.salesValue,
    "the channels add to the seat's published sales, exactly",
  );
  assert.ok(
    dk1.channels.distributor < dk1.salesValue - dk1.channels.stores,
    "Office came OUT of the distributor book — leaving it in is the defect this measures",
  );

  // THE EMITTED HEADER ROW — the owner's "separate column", read back out of the file.
  const heads = async (line: string, carve: Parameters<typeof buildRepRankingWorkbook>[0]["carve"]) => {
    const built = await buildRepRankingWorkbook({
      carve,
      probationByName: new Map(),
      ranking: ranking(3, line),
    });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(built.buffer as unknown as ArrayBuffer);
    const out: string[] = [];
    book.getWorksheet("Ranking")!.eachRow((row) => row.eachCell((cell) => {
      if (typeof cell.value === "string") out.push(cell.value);
    }));
    return out;
  };

  const cnsHeads = await heads("CNS", { direct: new Map(), office: cnsCarve.office, stores: cnsCarve.stores });
  assert.ok(cnsHeads.includes("Office EGP"), "the CNS Ranking sheet heads its third channel Office");
  assert.ok(cnsHeads.includes("Office %"), "and shares it as Office too");
  assert.ok(!cnsHeads.includes("Direct EGP"), "and never offers a direct column on a line with no direct orders");
  assert.ok(!cnsHeads.includes("Direct %"), "nor a direct share of it");

  const aiHeads = await heads(LINE, { direct: aiCarve.direct, office: aiCarve.office, stores: aiCarve.stores });
  assert.ok(aiHeads.includes("Direct EGP"), "every other line keeps its Direct column");
  assert.ok(!aiHeads.includes("Office EGP"), "and never grows an Office one");

  // 🔴 A NEGATIVE CHANNEL FIGURE IS PRINTED, NOT CALLED "none" — and the three columns still add.
  //
  // This is the absence-is-not-zero mistake with its sign reversed, and it was live: the Ranking
  // sheet wrote `store > 0 ? store : "none"`, so a month whose warehouse credits outweighed its
  // warehouse invoices read as no warehouse trade at all. Measured on the real CNS September 2026
  // file — Cairo East 2's warehouses are -25,640 EGP — where it did worse than hide a number: the
  // row's Distributor + Office came to 25,640 EGP MORE than its own published sales, on a sheet
  // whose Trust page says the channels add up exactly, with nothing on the row to explain it.
  const negativeStores = buildRepRanking({
    directByArea: new Map(),
    line: "CNS",
    matricesByPeriod: [{ matrix: matrixOf(PERIOD, SEPTEMBER), period: PERIOD }],
    officeByArea: new Map([[`${PERIOD}|DK1`, 30_000]]),
    period: PERIOD,
    probationByName: new Map(),
    seats: new Map(),
    storesByArea: new Map([[`${PERIOD}|DK1`, -25_640]]),
    warehouseCustomers: 1,
  });
  const negativeBuilt = await buildRepRankingWorkbook({
    carve: { direct: new Map(), office: new Map(), stores: new Map() },
    probationByName: new Map(),
    ranking: negativeStores,
  });
  const negativeBook = new ExcelJS.Workbook();
  await negativeBook.xlsx.load(negativeBuilt.buffer as unknown as ArrayBuffer);
  const ranking1 = negativeBook.getWorksheet("Ranking")!;
  let measured = 0;
  // 🔴 FROM THE HEADER ROW DOWN, NEVER OVER THE WHOLE SHEET. The keycards above the table hold
  // numbers in these same columns — one of them is an achievement ratio in column 9 — so a scan of
  // every row "adds" a keycard to a table row and fails on arithmetic nobody wrote.
  let headAt = 0;
  ranking1.eachRow((row, n) => {
    if (!headAt && row.getCell(1).value === "Rank") headAt = n;
  });
  assert.ok(headAt > 0, "the Ranking sheet has a header row to measure from");
  ranking1.eachRow((row, rowNumber) => {
    if (rowNumber <= headAt) return;
    const sales = row.getCell(9).value;
    const dist = row.getCell(6).value;
    if (typeof sales !== "number" || typeof dist !== "number") return;
    const store = row.getCell(7).value;
    const office = row.getCell(8).value;
    const n = (v: unknown) => (typeof v === "number" ? v : 0);
    assert.ok(
      Math.abs(dist + n(store) + n(office) - sales) < 1,
      `a seat's three printed channels add to its printed sales (${String(row.getCell(4).value)}: ${dist} + ${String(store)} + ${String(office)} vs ${sales})`,
    );
    if (String(row.getCell(4).value) === "Dakahlia 1") {
      measured += 1;
      assert.equal(store, -25_640, "the negative warehouse figure is PRINTED, never written as none");
      assert.equal(office, 30_000, "beside its Office money");
    }
  });
  assert.equal(measured, 1, "the seat carrying the negative figure really is on the sheet");
}

/**
 * THE SCREEN'S FILTER NARROWS THE WHOLE FILE, AND EVERY FIGURE IN IT IS STILL A PUBLISHED CELL.
 *
 * Owner, 2026-10-13: "I filtered from my admin account and exported - it's supposed to follow my
 * filter. No, it did not follow my filter. All the shit is exported." The route used to drop the
 * filter on purpose, and the objection behind that was real - a narrowed ROW set shrinks the
 * channel split underneath a ranking that did not move - so what is measured here is the thing
 * that makes his answer safe: the matrix is narrowed by DROPPING cells, never by re-deriving a
 * number, so a filtered workbook is the closing over a smaller rectangle and nothing else.
 *
 * 🔴 THE TARGET IS THE HALF THAT CAN GO WRONG SILENTLY. Summing targets with `?? 0` would hand
 * every seat in a product-filtered file a 0 target and an infinite achievement, where the rule is
 * that a seat with no target is UNRANKED. Both are measured below.
 */
async function assertTheFilterNarrowsTheWholeFile(): Promise<void> {
  const matrix = matrixOf(PERIOD, SEPTEMBER);
  const codes = matrix.columns.map((column) => column.productCode);
  assert.ok(codes.length >= 2, "the fixture has two products to filter between");

  // ── Nothing selected is not a filter ──────────────────────────────────────────────────────────
  assert.ok(rankingFiltersAreEmpty(null), "no filter at all");
  assert.ok(rankingFiltersAreEmpty({ areaCodes: [], productCodes: [], regionCodes: [], search: "" }),
    "and the screen's empty state, which is what the portal path sends");
  assert.equal(
    narrowClosingMatrixForRanking(matrix, { areaCodes: [], search: "" }),
    matrix,
    "an empty filter hands back the SAME matrix object - the unfiltered file cannot change at all",
  );

  // ── An area filter drops rows, and the survivors keep their own published figures ─────────────
  const oneArea = narrowClosingMatrixForRanking(matrix, { areaCodes: ["DK1"] });
  const keptAreas = oneArea.regions.flatMap((region) => region.areas);
  assert.deepEqual(keptAreas.map((area) => area.areaCode), ["DK1"], "one area survives");
  const before = matrix.regions.flatMap((r) => r.areas).find((a) => a.areaCode === "DK1")!;
  assert.equal(keptAreas[0]!.rowTotal.salesValue, before.rowTotal.salesValue,
    "and its sales is the published figure, untouched");
  assert.equal(oneArea.grandTotal.rowTotal.salesValue, before.rowTotal.salesValue,
    "the grand total is the selection's total, not the line's");
  assert.ok(
    oneArea.grandTotal.rowTotal.salesValue < matrix.grandTotal.rowTotal.salesValue,
    "which is SMALLER than the line - the whole point of the owner's complaint",
  );

  // 🔴 A REGION FILTER SELECTS THE GROUP THE MATRIX SHOWS, NEVER THE REGION AN AREA CAME FROM.
  // Owner, 2026-10-13: "I filtered on Delta 1 and the export came out with Delta 1 and Delta 3
  // together." On Anti Infective Qalubeya sits under Delta (3) and keeps Delta (1) as its source;
  // the first version of this filter answered to the source too and returned it under Delta (1).
  const moved = matrixOf(PERIOD, SEPTEMBER);
  const dkGroup = moved.regions.find((g) => g.regionCode === "DL")!;
  const upGroup = moved.regions.find((g) => g.regionCode === "UE")!;
  upGroup.areas[0] = { ...upGroup.areas[0]!, sourceRegionCode: "DL", sourceRegionName: "Delta" } as typeof upGroup.areas[number];
  const deltaOnly = narrowClosingMatrixForRanking(moved, { regionCodes: ["DL"] });
  assert.deepEqual(
    deltaOnly.regions.map((g) => g.regionCode),
    ["DL"],
    "choosing one region returns that region and not the one an area was moved out of",
  );
  assert.deepEqual(
    deltaOnly.regions[0]!.areas.map((a) => a.areaCode),
    dkGroup.areas.map((a) => a.areaCode),
    "and exactly the areas the matrix shows under it",
  );

  // ── A product filter drops columns, and a row total is the sum of its survivors ───────────────
  const oneProduct = narrowClosingMatrixForRanking(matrix, { productCodes: [codes[0]!] });
  assert.deepEqual(oneProduct.columns.map((c) => c.productCode), [codes[0]], "one column survives");
  for (const region of oneProduct.regions) {
    for (const area of region.areas) {
      assert.equal(area.cells.length, 1, "every row carries exactly the surviving cell");
      assert.equal(area.rowTotal.salesValue, area.cells[0]!.salesValue,
        `${area.areaName}: the row total is its own surviving cell, never a re-derived number`);
      assert.equal(area.rowTotal.targetValue, area.cells[0]!.targetValue,
        `${area.areaName}: and so is its target`);
    }
  }

  // 🔴 A PRODUCT NOBODY TARGETED LEAVES THE TARGET NULL, NOT ZERO.
  const untargeted = matrixOf(PERIOD, [
    { ...SEPTEMBER[0]!, cells: [{ sales: 1_000, target: null }, { sales: 500, target: 4_000 }] },
  ]);
  const noTarget = narrowClosingMatrixForRanking(untargeted, { productCodes: [codes[0]!] });
  const row = noTarget.regions[0]!.areas[0]!;
  assert.equal(row.rowTotal.targetValue, null, "no target survives as NULL - the seat is unranked");
  assert.equal(row.rowTotal.achievement, null, "so there is no achievement either, never 0% or Infinity");
  assert.equal(row.rowTotal.salesValue, 1_000, "while its sales is the real figure");

  // ── The free-text search has no matrix grain, so it narrows the SEATS its rows touched ────────
  assert.equal(searchedAreaCodes({ search: "" }, []), null, "no search, no extra narrowing");
  const touched = searchedAreaCodes({ search: "صيدلية" }, [
    { areaCode: "DK1" }, { areaCode: "dk1" }, { areaCode: null },
  ]);
  assert.deepEqual([...touched!], ["DK1"], "the areas its rows reached, upper-cased and deduped");
  const searched = narrowClosingMatrixForRanking(matrix, { search: "صيدلية" }, touched);
  assert.deepEqual(
    searched.regions.flatMap((r) => r.areas).map((a) => a.areaCode),
    ["DK1"],
    "and the file is those seats",
  );
  const nothing = narrowClosingMatrixForRanking(matrix, { search: "nobody" }, new Set<string>());
  assert.equal(nothing.regions.length, 0,
    "a search that matched nothing empties the matrix, which the builder reads as no file - never a month of zeroes");

  // ── The file SAYS what it covers, in names rather than codes ──────────────────────────────────
  assert.deepEqual(describeRankingFilters(null), [], "an unfiltered file says nothing extra");
  assert.deepEqual(
    describeRankingFilters(
      { areaCodes: ["DK1"], productCodes: [codes[0]!], search: "  " },
      { areaNames: new Map([["DK1", "Dakahlia 1"]]), productNames: new Map([[codes[0]!.toUpperCase(), "Royafloxacin 500"]]) },
    ),
    ["Areas: Dakahlia 1", "Products: Royafloxacin 500"],
    "names, never codes (AGENTS.md §4) - and whitespace is not a search",
  );

  // ── THE EMITTED FILE carries the sentence, on the Ranking sheet and on Trust ──────────────────
  const built = await buildRepRankingWorkbook({
    carve: { direct: new Map(), office: new Map(), stores: new Map() },
    coverage: ["Areas: Dakahlia 1", "Products: Royafloxacin 500"],
    probationByName: new Map(),
    ranking: ranking(),
  });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(built.buffer as unknown as ArrayBuffer);
  const prose = (name: string) => {
    const out: string[] = [];
    book.getWorksheet(name)!.eachRow((r) => r.eachCell((c) => {
      if (typeof c.value === "string") out.push(c.value);
    }));
    return out.join(" ");
  };
  assert.ok(prose("Ranking").includes("FILTERED"), "the Ranking sheet's own heading says it is filtered");
  assert.ok(prose("Ranking").includes("Areas: Dakahlia 1"), "and names the rectangle");
  assert.ok(prose("Trust").includes("WHAT THIS FILE COVERS"), "Trust opens with the rectangle");
  assert.ok(prose("Trust").includes("is the total OF THIS SELECTION"),
    "and warns that its line total will not reconcile against the line");

  const plain = await buildRepRankingWorkbook({
    carve: { direct: new Map(), office: new Map(), stores: new Map() },
    probationByName: new Map(),
    ranking: ranking(),
  });
  const plainBook = new ExcelJS.Workbook();
  await plainBook.xlsx.load(plain.buffer as unknown as ArrayBuffer);
  const plainProse: string[] = [];
  plainBook.getWorksheet("Trust")!.eachRow((r) => r.eachCell((c) => {
    if (typeof c.value === "string") plainProse.push(c.value);
  }));
  assert.ok(
    !plainProse.join(" ").includes("WHAT THIS FILE COVERS"),
    "and an UNFILTERED file says none of it - a warning that is always there is read by nobody",
  );
}

/**
 * THE CNS WORKBOOK WEARS THE CNS IDENTITY — owner, 2026-10-13: "now use the CNS identity to make the
 * new identity ranking rep closing sheet, exactly as you did for anti-infective, but for CNS with
 * CNS identity."
 *
 * 🔴 MEASURED ON THE EMITTED FILE, NEVER ON THE SOURCE. A dress record that holds the right hexes
 * proves nothing about the workbook: the colours reach a cell through a closure, a keycard, a seam
 * and a conditional format, and any one of those could still be carrying a constant left behind
 * from the line this builder was written for. So the file is built, unzipped, and its own styles
 * are read — the one place Excel keeps the colour a reader will actually see.
 */
async function assertCnsWearsItsOwnIdentity(): Promise<void> {
  const cns = await buildRepRankingWorkbook({
    carve: { direct: new Map(), office: new Map(), stores: new Map() },
    probationByName: new Map(),
    ranking: ranking(3, "CNS"),
  });
  const styles = await (await JSZip.loadAsync(cns.buffer)).file("xl/styles.xml")!.async("string");

  for (const [token, what] of [
    ["63B24A", "Tebofortin leaf"],
    ["E5732A", "Tebofortin amber"],
    ["B4531A", "its deeper amber, for a vacant seat's name"],
    ["0F3A1A", "the forest field, under the keycards"],
    ["A7E08F", "the eyebrow green, on their labels"],
    ["F0F2F1", "the identity's own 6% zebra"],
  ] as const) {
    assert.ok(styles.includes(token), `the emitted file carries ${what} (#${token})`);
  }

  // 🔴 AND NOT ONE TOKEN OF THE LINE THIS BUILDER WAS WRITTEN FOR. This is the assertion that fires
  // if a second identity is ever added by copying the first and forgetting a constant.
  for (const [token, what] of [
    ["D20000", "Royafloxacin red"],
    ["0384DB", "Saginkgo blue"],
    ["001641", "the navy field"],
    ["000A26", "the navy base"],
    ["67C2F6", "the eyebrow blue"],
    ["F5F7FA", "the navy-derived zebra"],
  ] as const) {
    assert.ok(!styles.includes(token), `no ${what} (#${token}) anywhere on a CNS file`);
  }

  // The chrome comes out of the CNS folder, not the other line's — ten renders, one per banner.
  assert.equal(cns.facts.bannersEmbedded, 10, "every CNS strip and its masthead are embedded");
  assert.ok(cns.facts.sheetNames.includes("Trust"), "and the identity page is there to explain them");

  // The Trust sheet names THIS identity, in its own words.
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(cns.buffer as unknown as ArrayBuffer);
  const trust = book.getWorksheet("Trust")!;
  const prose: string[] = [];
  trust.eachRow((row) => row.eachCell((cell) => {
    if (typeof cell.value === "string") prose.push(cell.value);
  }));
  const whole = prose.join(" ");
  assert.ok(whole.includes("the CNS identity"), "the Trust sheet names the identity the file wears");
  assert.ok(whole.includes("Tebofortin"), "and the hero it is built around");
  assert.ok(!whole.includes("Royafloxacin"), "and never the other line's products");
  assert.ok(!whole.includes("Saginkgo"), "nor the other line's second product");
}

/**
 * THE PEDIA WORKBOOK WEARS THE PEDIA IDENTITY — owner, 2026-10-13: "build the Pedia ranking dress".
 *
 * Same discipline as the CNS test above and for the same reason: the file is built, unzipped and
 * its own styles read, because a dress record holding the right hexes proves nothing about a cell.
 * 🔴 AND NEITHER SIBLING'S TOKENS MAY SURVIVE ON IT — the assertion that fires when a third
 * identity is added by copying the second and forgetting a constant — nor the reserved indigo.
 */
async function assertPediaWearsItsOwnIdentity(): Promise<void> {
  const pedia = await buildRepRankingWorkbook({
    carve: { direct: new Map(), office: new Map(), stores: new Map() },
    probationByName: new Map(),
    ranking: ranking(3, "Pedia"),
  });
  const styles = await (await JSZip.loadAsync(pedia.buffer)).file("xl/styles.xml")!.async("string");

  for (const [token, what] of [
    ["3EAB95", "Lacto aqua"],
    ["C17E11", "Lacto gold"],
    ["8A5A0C", "its deeper gold, for a vacant seat's name"],
    ["0A4645", "the teal field, under the keycards"],
    ["A9E3D6", "the eyebrow teal, on their labels"],
    ["F0F2F2", "the identity's own 6% zebra"],
  ] as const) {
    assert.ok(styles.includes(token), `the emitted file carries ${what} (#${token})`);
  }

  for (const [token, what] of [
    ["D20000", "Royafloxacin red"],
    ["0384DB", "Saginkgo blue"],
    ["001641", "the navy field"],
    ["63B24A", "Tebofortin leaf"],
    ["E5732A", "Tebofortin amber"],
    ["0F3A1A", "the forest field"],
    ["04210F", "the forest base"],
    ["F0F2F1", "CNS's zebra"],
    ["191E68", "Lacto Advanced 2's indigo, which the identity reserves"],
  ] as const) {
    assert.ok(!styles.includes(token), `no ${what} (#${token}) anywhere on a Pedia file`);
  }

  assert.equal(pedia.facts.bannersEmbedded, 10, "every Pedia strip and its masthead are embedded");

  const book = new ExcelJS.Workbook();
  await book.xlsx.load(pedia.buffer as unknown as ArrayBuffer);
  const prose: string[] = [];
  book.getWorksheet("Trust")!.eachRow((row) => row.eachCell((cell) => {
    if (typeof cell.value === "string") prose.push(cell.value);
  }));
  const whole = prose.join(" ");
  assert.ok(whole.includes("the Pedia identity"), "the Trust sheet names the identity the file wears");
  assert.ok(whole.includes("Lacto Advanced"), "and the hero it is built around");
  assert.ok(whole.includes("Lacto gold"), "and names the alarm colour in the words the cells carry");
  for (const other of ["Royafloxacin", "Saginkgo", "Tebofortin", "Conviban"]) {
    assert.ok(!whole.includes(other), `and never another line's product (${other})`);
  }

  // Pedia carries direct orders like Anti Infective, so its third channel is DIRECT, never Office.
  const ranked = book.getWorksheet("Ranking")!;
  const headings: string[] = [];
  ranked.eachRow((row) => row.eachCell((cell) => {
    if (typeof cell.value === "string") headings.push(cell.value);
  }));
  assert.ok(headings.some((text) => /direct/i.test(text)), "the Ranking sheet has a Direct column");
}

/**
 * THE ADMIN SCREEN'S THIRD EXPORT BUTTON — owner, 2026-10-13: "add a third button", after asking how
 * he could download this sheet "from admin account".
 *
 * He could not, and nothing was broken: /api/sales/monthly-closing/export decides by ROLE before it
 * reaches its rep-ranking branch, so Super Admin, system scope, SFE Manager, CEO, Finance Manager
 * and the Marketing Manager — everyone who runs the admin closing screen — are handed the full
 * six-sheet workbook higher up the file and never reach the ranking at all. That disjunction is
 * append-only and the workbook it guards is frozen, so the button calls a route of its OWN beside
 * it. These are the four things that make the two paths one feature rather than two.
 */
function assertAdminRepRankingButton(): void {
  const ROOT = resolve(import.meta.dirname, "..");
  const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

  // ── 1 · ONE GATE, AND THE CLIENT CAN ASK IT ──────────────────────────────────────────────────
  // The line test moved into a dependency-free leaf module so the admin screen — a client
  // component — can ask the same question the route asks. Importing it from the builder would drag
  // `@/lib/supabase/server` and the employee-directory chain into the browser bundle, which webpack
  // refuses outright and which poisons a dev server for every later request once it compiles.
  assert.equal(isRepRankingLine("Anti Infective"), true, "the gate admits the line it was written for");
  assert.equal(isRepRankingLine("  anti infective "), true, "spacing and case are normalised, not compared raw");
  assert.equal(isRepRankingLine("CNS"), true, "and the line he added to it the same day");
  assert.equal(isRepRankingLine("Pedia"), true, "and Pedia, which got its own dress on 2026-10-13");
  for (const other of ["Head Office", "", null, undefined]) {
    assert.equal(isRepRankingLine(other), false, `${other ?? "nothing"} keeps the workbook it already had`);
  }
  // Asked of what it IMPORTS, not of its text: the comment above the function names `node:crypto`
  // as the thing that must not be reachable, so scanning the whole file would fail on its own
  // explanation.
  const leafImports = [...read("src/lib/sales/closing-rep-ranking-line.ts").matchAll(/from\s+"([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(
    leafImports,
    ["@/lib/sales/confidential-products"],
    "the gate module imports the dependency-free line-key primitive and nothing else — one server"
      + " import here is a webpack refusal in the browser bundle",
  );
  assert.ok(
    read("src/lib/sales/closing-rep-ranking-export.ts").includes("export { isRepRankingLine }"),
    "the builder re-exports it, so every existing caller keeps its import path",
  );

  // ── 2 · THE ROUTE ────────────────────────────────────────────────────────────────────────────
  const route = read("app/api/sales/monthly-closing/rep-ranking-export/route.ts");
  const permission = route.indexOf('assertPermission(access, "sales", "export")');
  const gate = route.indexOf("isRepRankingLine(details.line)");
  const build = route.indexOf("buildScopedRepRankingExport({");
  assert.ok(permission > 0, "the route asks the export permission");
  assert.ok(gate > permission, "and the Anti Infective gate after it");
  assert.ok(build > gate, "and refuses every other line BEFORE it builds anything");
  assert.ok(
    route.indexOf("unpublishedClosingMessage(") < build,
    "an unpublished month is refused in plain words first — the builder would answer it with"
      + " 'cannot be built', because loadPortalMonthlyClosing swaps it for the newest published one",
  );
  // 🔴 THE SCREEN'S FILTER REACHES BOTH HALVES OF THE FILE, OR NEITHER — owner, 2026-10-13: "I
  // filtered from my admin account and exported — it's supposed to follow my filter. No, it did
  // not follow my filter. All the shit is exported." It used to be dropped here on purpose
  // (`filters: {}`), because the ranking is built from the MATRICES while the channel carve comes
  // from the DETAIL ROWS, so narrowing only the rows shrinks Stores and Office underneath a
  // ranking that did not move. He was shown that and chose "every filter narrows everything", so
  // what is measured now is that the SAME object reaches both reads — one of them taking it alone
  // is the defect this replaces.
  assert.ok(!route.includes("filters: {}"), "the filter is no longer thrown away at the route");
  for (const field of ["areaCodes", "productCodes", "regionCodes", "search"]) {
    assert.ok(
      route.includes(`body.${field}`),
      `the route reads ${field} out of the body — exactly the four fields runExport sends`,
    );
  }
  assert.equal(
    (route.match(/^\s*filters,\s*$/gm) ?? []).length,
    2,
    "and hands that one object to BOTH loadMonthlyClosingDetails and buildScopedRepRankingExport —"
      + " two reads of one filter, never one of each",
  );
  assert.ok(
    route.includes("rankingFiltersAreEmpty(filters)"),
    "an empty build says WHICH of the two it was: the month has nothing, or the filter left nothing",
  );

  // THE SCREEN sends those four and nothing else, so the list above is the whole filter. A control
  // added to the screen without a line here would narrow the rows and not the ranking.
  const screen = read("src/components/sales/monthly-closing-workspace.tsx");
  const payload = screen.slice(screen.indexOf("const response = await fetch(input.url"));
  for (const field of ["areaCodes: filter.areaCodes", "productCodes: filter.productCodes",
    "regionCodes: filter.regionCodes", "search: filter.search"]) {
    assert.ok(payload.includes(field), `runExport sends ${field} with every export`);
  }

  // 🔒 THE FROZEN EXPORT IS UNTOUCHED — this route sits beside it. The role disjunction that makes
  // the ranking branch unreachable for the admin screen is pinned elsewhere as a literal substring;
  // what matters here is that nothing was rerouted through it.
  const frozen = read("app/api/sales/monthly-closing/export/route.ts");
  assert.ok(
    !frozen.includes("/api/sales/monthly-closing/rep-ranking-export"),
    "the frozen closing export does not redirect, proxy or know about the new route",
  );
  assert.ok(
    frozen.includes("if (isRepRankingLine(details.line)) {"),
    "and the portal still gets the ranking workbook from its own branch, by the same gate",
  );

  // ── 2b · HIS OWN COPY READS AN UNPUBLISHED MONTH; NOBODY ELSE'S DOES ─────────────────────────
  // Owner, 2026-10-13, asked why the button refused September: every Anti Infective month was
  // unpublished — September since 9 Oct, July and August since the 12th — so a publish-gated
  // builder could produce nothing for the one reader who opens unpublished months everywhere else.
  // He chose to have his own copy read the month his screen reads. It widens WHICH MONTHS, never
  // whose figures: the scoping chain inside the loader is untouched.
  assert.ok(
    route.includes("const readsUnpublished = readsUnpublishedClosings(access);"),
    "the route decides it with the ONE predicate — the same the details gate uses",
  );
  assert.ok(
    route.includes("includeUnpublished: readsUnpublished"),
    "and passes that answer through rather than a literal true",
  );
  assert.ok(
    !/includeUnpublished:\s*true/.test(route),
    "never an unconditional true: that would hand every sales:export role an unpublished month",
  );
  assert.ok(
    !frozen.includes("includeUnpublished"),
    "🔒 the portal export never asks for it — there the publish gate is the whole point",
  );
  // The flag is opt-in at the loader, so every existing portal caller keeps the gate by DEFAULT.
  const portal = read("src/lib/sales/monthly-closing-portal.ts");
  assert.ok(
    portal.includes("includeUnpublished?: boolean"),
    "the loader's flag is optional — absent means published months, as it always did",
  );
  assert.ok(
    portal.includes("input.includeUnpublished ? await listMonthlyClosingPeriods() : []")
      && portal.includes("input.includeUnpublished ? validatedPeriods : await listPublishedPeriodsForLine(line)"),
    "and it swaps ONLY the month list — the validated months are read once, not per line",
  );
  for (const step of [
    "const safe = stripRestrictedColumns(locked);",
    "scope.productCodes ? scopeMatrixToProducts(safe, scope.productCodes) : safe",
    "applyRegionScope(productScoped, scope.regionNames, areaCodesForMonth(scope.areaCodes, scope.earlierMonthAreas, selectedPeriod))",
  ]) {
    assert.ok(
      portal.includes(step),
      `the scoping chain is untouched by the flag — ${step.slice(0, 40)}… still runs for every caller`,
    );
  }
  // A validated month the line never traded in is NOT a zero month. The validated list is global,
  // because an import batch carries no line, so the builder has to drop an empty matrix rather than
  // render a trend column in which every rep scored nothing.
  const builder = read("src/lib/sales/closing-rep-ranking-export.ts");
  assert.ok(
    builder.includes("matrix && matrix.regions.length > 0 ? { matrix, period: month } : null"),
    "a month with no rows for this line is dropped from the trend, never shown as zero",
  );
  assert.ok(
    builder.includes("loadPortalMonthlyClosing({ access, includeUnpublished, line, period: month })"),
    "and every trend month is loaded with the same answer, so the file cannot mix gated and ungated months",
  );

  // ── 3 · THE REGISTRY ─────────────────────────────────────────────────────────────────────────
  // Asked of the registry itself, not of its source text: every route under app/api needs a
  // declaration or the required validate job goes red, and the permission it declares is what the
  // preflight enforces.
  const entry = findAccessRegistryEntry("/api/sales/monthly-closing/rep-ranking-export", "POST");
  assert.ok(entry, "the route is declared in the access registry");
  assert.deepEqual(entry.permission, { resource: "sales", action: "export" }, "under sales:export");
  assert.equal(entry.audit.classification, "export", "audited as an export");
  assert.equal(entry.audit.required, true, "and the audit row is required");
  assert.equal(entry.csrf.required, false, "no CSRF token: it is a POST only because it carries a selection");
  assert.ok(
    (entry.csrf.exemptReason ?? "").includes("no mutation"),
    "and the exemption says why — it writes nothing",
  );

  // ── 4 · THE BUTTON ───────────────────────────────────────────────────────────────────────────
  const workspace = read("src/components/sales/monthly-closing-workspace.tsx");
  assert.ok(
    workspace.includes("const showRepRankingExport = isRepRankingLine(selectedLine);"),
    "the screen offers the button by the same function the route gates on",
  );
  assert.match(
    workspace,
    /async function handleRepRankingExport\(\) \{\s*await runExport\(\{[^}]*url: "\/api\/sales\/monthly-closing\/rep-ranking-export"/,
    "the button goes through runExport, so its errors and its filename behave like every other export",
  );
  assert.ok(
    workspace.includes("{showRepRankingExport ? (") && workspace.includes("Export Rep Ranking"),
    "and it is ABSENT on a line with no dress rather than disabled — the workbook does not exist there",
  );
  // 🔴 AND IT IS DRAWN IN BOTH HALVES OF THE ROW. Owner, 2026-10-13: "still no Export Rep Ranking
  // button on Pedia" — it sat inside the single-month fragment, so picking two or more months
  // swapped the row to the three Consolidated buttons and this one vanished without a word. It must
  // come AFTER the consolidated branch's last button, so it is outside both.
  assert.match(
    workspace,
    /<\/>\s*\)\}\s*\{\/\* THE DRESSED LINES ONLY[\s\S]*?\{showRepRankingExport \? \(/,
    "the ranking button is drawn right after the single-month / consolidated split closes, so a span of months still shows it (disabled, with its reason)",
  );

  // 🔒 THE FITS-THE-SCREEN GOLDEN RULE. Three buttons fitted one line; the fourth takes the row
  // past the panel's width at 640 and 768. `shrink-0` on the row would make its own `flex-wrap`
  // inert — a flex item with shrink-0 is never handed a width narrower than its content — so the
  // page would scroll sideways instead of the buttons wrapping. See
  // tests/flex-wrap-shrink-guard.test.ts, which exists because that happened for real.
  assert.ok(
    workspace.includes('<div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">'),
    "the export row wraps and may shrink — never a pinned row that overflows",
  );
  assert.ok(
    !workspace.includes('<div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">'),
    "the pinned three-button row is gone, not kept beside the wrapping one",
  );
}
