import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
import { buildRepRankingWorkbook } from "../src/lib/sales/closing-rep-ranking-workbook.ts";
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

function ranking() {
  return buildRepRanking({
    directByArea: new Map([[`${PERIOD}|MN1`, 20_000]]),
    line: LINE,
    matricesByPeriod: [
      { matrix: matrixOf("2026-07", JULY), period: "2026-07" },
      { matrix: matrixOf("2026-08", AUGUST), period: "2026-08" },
      { matrix: matrixOf(PERIOD, SEPTEMBER), period: PERIOD },
    ],
    period: PERIOD,
    probationByName: new Map([["Sara Nabil", "2026-12-01"]]),
    seats: SEATS,
    storesByArea: new Map([[`${PERIOD}|DK1`, 50_000]]),
    warehouseCustomers: 7,
  });
}

export async function runClosingRepRankingTests(): Promise<void> {
  // ── The gate: this line and no other ──────────────────────────────────────────────────────────
  assert.ok(isRepRankingLine("Anti Infective"), "Anti Infective takes the ranking workbook");
  assert.ok(isRepRankingLine("anti infective"), "...however the line is spelled");
  for (const other of ["CNS", "Pedia", "Head Office", "", null]) {
    assert.ok(!isRepRankingLine(other), `${String(other)} keeps the export it already had`);
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
    carve: { direct: carve.direct, stores: carve.stores },
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
  assert.equal(built.facts.lockedSheets, built.facts.sheetNames.length, "🔒 every tab is locked");
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
    assert.ok(xml.includes("<sheetProtection"), `${name}: locked`);
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

  assertAdminRepRankingButton();
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
  for (const other of ["CNS", "Pedia", "Head Office", "", null, undefined]) {
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
  assert.ok(
    route.includes("filters: {}"),
    "the route takes the selection only: narrowing the rows alone would shrink the channel split"
      + " underneath a ranking built from matrices that take no row filter",
  );
  for (const field of ["areaCodes", "regionCodes", "productCodes", "detailSearch"]) {
    assert.ok(
      !route.includes(`body.${field}`),
      `the route never reads ${field} out of the body, so the two halves of the workbook cannot disagree`,
    );
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
    "and it is ABSENT on CNS and Pedia rather than disabled — the workbook does not exist there",
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
