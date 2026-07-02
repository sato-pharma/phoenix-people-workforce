import assert from "node:assert/strict";

import JSZip from "jszip";

import { buildSosBiWorkbook } from "../src/lib/sales/sos-bi-workbook.ts";
import type { SosDashboardData } from "../src/lib/sales/sos-dashboard.ts";

const GENERATED_AT = "2026-07-02 12:00 UTC";

function isXlsx(buffer: Buffer): boolean {
  // .xlsx is a zip → first two bytes are 'P' 'K' (0x50 0x4B)
  return buffer.length > 100 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

/** Detects the XML-illegal control bytes a stray name could smuggle into the package. */
const CTRL = (() => {
  let chars = "";
  for (let index = 0; index <= 0x1f; index += 1) {
    if (index === 9 || index === 10 || index === 13) continue;
    chars += String.fromCharCode(index);
  }
  return new RegExp(`[${chars}]`);
})();

async function hasControlBytes(buffer: Buffer): Promise<boolean> {
  const zip = await JSZip.loadAsync(buffer);
  for (const name of Object.keys(zip.files)) {
    if (!/\.(xml|rels)$/.test(name)) continue;
    const xml = await zip.files[name].async("string");
    if (CTRL.test(xml)) return true;
  }
  return false;
}

async function workbookXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  return (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
}

/** Returns a named part's XML from the package, or null when the part is absent. */
async function zipPart(buffer: Buffer, name: string): Promise<string | null> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file(name);
  return file ? await file.async("string") : null;
}

const groupRow = (code: string, label: string, value: number, line: string | null = null) => ({
  code,
  label,
  line,
  value,
  units: Math.round(value / 10),
  share: 0.5,
});

function fixture(): SosDashboardData {
  // A product name carrying punctuation + a control byte — cleanText must neutralise both.
  const nastyName = `Royafloxacin, "500mg" & co` + String.fromCharCode(7);
  return {
    period: "2026-06",
    selectedPeriods: ["2026-06"],
    availablePeriods: ["2026-06", "2026-05"],
    filters: { periods: ["2026-06", "2026-05"], lines: ["Pedia"], distributors: [], regions: [], areas: [], products: [] },
    restrictedRevealed: true,
    summary: {
      totalValue: 10_000,
      totalUnits: 1_000,
      avgPricePerUnit: 10,
      distributorCount: 2,
      productCount: 2,
      customerCount: 3,
      directValue: 2_000,
      distributorValue: 8_000,
      directShare: 0.2,
      areasReached: 2,
      totalAreas: 3,
      bricksReached: 2,
      totalBricks: 4,
    },
    trend: [
      { period: "2026-05", value: 9_000, units: 950 },
      { period: "2026-06", value: 10_000, units: 1_000 },
    ],
    channelMix: [
      { name: "Distributors", value: 8_000 },
      { name: "Direct (Company)", value: 2_000 },
    ],
    byDistributor: [
      { ...groupRow("IS", "Ibn Sina", 8_000), regions: 2, areas: 2, products: 2 },
      { ...groupRow("DIRECT", "Direct", 2_000), regions: 1, areas: 1, products: 1 },
    ],
    byRegion: [groupRow("D1", "Delta 1", 6_000), groupRow("D2", "Delta 2", 4_000)],
    byArea: [groupRow("A1", "Area 1", 6_000, "Delta 1"), groupRow("A2", "Area 2", 4_000, "Delta 2")],
    byProduct: [groupRow("SAG", "Saginkgo", 7_000, "Pedia"), groupRow("ROY", nastyName, 3_000, "Pedia")],
    byLine: [groupRow("Pedia", "Pedia", 10_000, "Pedia")],
    topBricks: [groupRow("BR1", "Brick 1", 5_000)],
    bottomBricks: [groupRow("BR2", "Brick 2", 100)],
    topCustomers: [
      { code: "C1", name: "Pharmacy One", distributor: "Ibn Sina", region: "Delta 1", area: "Area 1", value: 4_000, units: 400, share: 0.5 },
    ],
    customerTop10Share: 0.8,
    whiteSpaceAreas: [{ code: "A3", label: "Area 3", region: "Delta 2" }],
    insights: [{ tone: "neutral", text: "Ibn Sina leads distribution." }],
    momComparison: {
      priorPeriod: "2026-05",
      summaryDeltas: {
        totalValue: { current: 10_000, previous: 9_000, delta: 1_000, deltaPct: 1_000 / 9_000 },
        totalUnits: { current: 1_000, previous: 950, delta: 50, deltaPct: 50 / 950 },
        avgPricePerUnit: { current: 10, previous: 9.47, delta: 0.53, deltaPct: 0.056 },
        distributorCount: { current: 2, previous: 2, delta: 0, deltaPct: 0 },
        productCount: { current: 2, previous: 2, delta: 0, deltaPct: 0 },
        directShare: { current: 0.2, previous: 0.22, delta: -0.02, deltaPct: -0.09 },
        areasReached: { current: 2, previous: 3, delta: -1, deltaPct: -1 / 3 },
      },
      movers: {
        products: {
          gainers: [{ code: "SAG", label: "Saginkgo", value: 7_000, prevValue: 6_000, delta: 1_000, deltaPct: 1 / 6 }],
          decliners: [{ code: "ROY", label: nastyName, value: 3_000, prevValue: 3_500, delta: -500, deltaPct: -1 / 7 }],
        },
        regions: { gainers: [], decliners: [] },
        distributors: { gainers: [], decliners: [] },
      },
      contribution: {
        products: [
          { code: "SAG", label: "Saginkgo", value: 7_000, prevValue: 6_000, delta: 1_000, contribution: 2 / 3 },
          { code: "ROY", label: nastyName, value: 3_000, prevValue: 3_500, delta: -500, contribution: 1 / 3 },
        ],
        regions: [
          { code: "D1", label: "Delta 1", value: 6_000, prevValue: 5_000, delta: 1_000, contribution: 1 },
        ],
      },
      newProducts: [{ code: "NEW1", label: "Newlaunch", value: 250 }],
      lostProducts: [],
      newAreas: [],
      lostAreas: [{ code: "A3", label: "Area 3", value: 300 }],
    },
    paretoProducts: [
      { code: "SAG", label: "Saginkgo", line: "Pedia", value: 7_000, units: 700, share: 0.7, cumulativeShare: 0.7, abcClass: "A" },
      { code: "ROY", label: nastyName, line: "Pedia", value: 3_000, units: 300, share: 0.3, cumulativeShare: 1, abcClass: "C" },
    ],
    detailRows: [
      { period: "2026-06", distributorCode: "IS", distributorName: "Ibn Sina", officialLine: "Pedia", regionCode: "D1", regionName: "Delta 1", areaCode: "A1", areaName: "Area 1", productCode: "SAG", productName: "Saginkgo", channel: "Distributor", units: 700, value: 7_000 },
      { period: "2026-06", distributorCode: "IS", distributorName: "Ibn Sina", officialLine: "Pedia", regionCode: "D2", regionName: "Delta 2", areaCode: "A2", areaName: "Area 2", productCode: "ROY", productName: nastyName, channel: "Distributor", units: 100, value: 1_000 },
      { period: "2026-06", distributorCode: "DIRECT", distributorName: "Direct", officialLine: "Pedia", regionCode: "D1", regionName: "Delta 1", areaCode: "DIRECT", areaName: "Direct (National)", productCode: "SAG", productName: "Saginkgo", channel: "Direct", units: 200, value: 2_000 },
    ],
  };
}

const EXPECTED_SHEETS = [
  "Dashboard", "MoM Movers", "Trend", "Region x Product", "Pareto ABC",
  "Distributor x Product", "Product x Month",
  "Region x Distributor", "Line x Region", "Area x Product",
  "Region Pareto", "Growth Contribution",
  "Outliers", "Coverage", "Region Drill",
  "Distributors", "Regions", "Areas", "Products", "Lines",
  "Top Customers", "Bricks", "White-space", "Report Info", "Data",
];

export async function runSosBiWorkbookTests() {
  const data = fixture();
  const buffer = await buildSosBiWorkbook({
    data,
    generatedBy: "PHX-1",
    generatedAt: GENERATED_AT,
    filterSummary: "lines: Pedia",
  });

  assert.ok(isXlsx(buffer), "output must be a valid xlsx (zip) package");
  assert.ok(!(await hasControlBytes(buffer)), "control bytes must be stripped from every XML part");

  const wbXml = await workbookXml(buffer);
  for (const name of EXPECTED_SHEETS) {
    assert.ok(wbXml.includes(`name="${name}"`), `missing sheet: ${name}`);
  }
  // The Data sheet must be hidden, and must not be the active tab (Excel refuses to open
  // a workbook whose only active sheet is hidden — the classic silent-repair trigger).
  // ExcelForge serialises hidden sheets as <sheet name="Data" ... state="hidden"/>.
  assert.match(wbXml, /name="Data"[^>]*state="hidden"/, "Data sheet must be hidden");

  // ExcelForge feature parity + beyond-parity charts: with the full fixture the
  // workbook embeds 8 native charts — ABC split (Pareto ABC) + the 7 Dashboard
  // charts (products, regions, distributors, trend, pareto, MoM bridge, channel mix).
  for (let i = 1; i <= 8; i += 1) {
    const chartXml = await zipPart(buffer, `xl/charts/chart${i}.xml`);
    assert.ok(chartXml, `native chart part xl/charts/chart${i}.xml must exist in the package`);
  }
  const tableXml = await zipPart(buffer, "xl/tables/table1.xml");
  assert.ok(tableXml, "native table part xl/tables/table1.xml must exist in the package");
  assert.match(tableXml ?? "", /name="tblSos"/, "the Data sheet table must be named tblSos");

  // No prior period: momComparison null + no detail rows must still build every sheet.
  const noMomBuffer = await buildSosBiWorkbook({
    data: { ...fixture(), momComparison: null, paretoProducts: [], detailRows: [] },
    generatedBy: "PHX-1",
    generatedAt: GENERATED_AT,
    filterSummary: "No filters (full scope)",
  });
  assert.ok(isXlsx(noMomBuffer), "null-mom workbook must still build");
  assert.ok(!(await hasControlBytes(noMomBuffer)), "null-mom workbook must contain no control bytes");
  const noMomXml = await workbookXml(noMomBuffer);
  for (const name of EXPECTED_SHEETS) {
    assert.ok(noMomXml.includes(`name="${name}"`), `null-mom workbook missing sheet: ${name}`);
  }

  // Fields absent entirely (portal-shaped payload, flags off) must also not throw.
  const bare = { ...fixture() };
  delete bare.momComparison;
  delete bare.paretoProducts;
  delete bare.detailRows;
  const bareBuffer = await buildSosBiWorkbook({ data: bare, generatedBy: "PHX-1", generatedAt: GENERATED_AT, filterSummary: "—" });
  assert.ok(isXlsx(bareBuffer), "flag-less payload must still build");
}
