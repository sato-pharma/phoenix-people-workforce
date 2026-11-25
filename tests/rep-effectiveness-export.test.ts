import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import type { PharmacyCountRow } from "../src/lib/sales/closing-pharmacy-counts.ts";
import { buildRepEffectivenessDocument } from "../src/lib/sales/rep-effectiveness/document.ts";
import {
  buildRepEffectiveness,
  productTags,
  reviewFileName,
  summariseClosingMonth,
  type EffMonth,
  type EffRep,
} from "../src/lib/sales/rep-effectiveness/model.ts";
import { buildRepEffectivenessWorkbook, REP_EFFECTIVENESS_SHEETS } from "../src/lib/sales/rep-effectiveness/workbook.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE REP EFFECTIVENESS REVIEW (owner, 25 Nov 2026: "audit the conversation of the managers and their requirements and
 * tailor the export to show exactly the data needed", "the customer count is very important", then "i want to be able to
 * export from system xlsx and pdf").
 *
 * What would go wrong, each without an error anyone could see:
 *   - A pharmacy that bought and returned, a direct order or a wholesaler's share is counted as a customer, and the one
 *     figure the managers asked for first reads high.
 *   - A wholesaler is judged on the area's rows alone, so a customer the closing shares across areas reads as a pharmacy.
 *   - Units of different products are added into one total.
 *   - The growth bridge does not add up to the change it explains.
 *   - The rep's own months and the area's history before her are not told apart.
 *   - The review, which is HR evidence on one named person, opens to someone other than the Super Admin.
 */

const row = (partial: Partial<PharmacyCountRow>): PharmacyCountRow =>
  ({
    areaCode: "D16",
    sheetAreaCode: "D16",
    distributorCode: "IBN",
    clientCode: "C1",
    clientName: "صيدلية النور",
    clientAddress: "",
    areaName: "Kafr El-Sheikh 1",
    brickId: "B1",
    brickName: "Kafr El-Sheikh",
    productCode: "GU001",
    productName: "Guamusin",
    salesValue: 100,
    effectiveUnits: 2,
    isDirect: false,
    evenSplitApplied: false,
    qty: 2,
    includedInClosing: true,
    ...partial,
  }) as PharmacyCountRow;

function oneMonthOfRows(): void {
  const rows: PharmacyCountRow[] = [
    // A pharmacy buying two products: one pharmacy, two buyer entries.
    row({ clientCode: "C1" }),
    row({ clientCode: "C1", productCode: "IV001", productName: "Ivyronc", salesValue: 300, qty: 1, effectiveUnits: 1 }),
    // Bought and returned in the month: no purchase.
    row({ clientCode: "C2", clientName: "Returned", qty: 2, salesValue: 100 }),
    row({ clientCode: "C2", clientName: "Returned", qty: -2, effectiveUnits: -2, salesValue: -100 }),
    // A direct order: sales, never a pharmacy that bought.
    row({ clientCode: "C3", clientName: "Nursery", isDirect: true, salesValue: 5000, qty: 650 }),
    // A customer the closing books in two areas: a wholesaler's share here, judged across the whole line.
    row({ clientCode: "W1", clientName: "Wholesaler", salesValue: 700, qty: 7 }),
    row({ clientCode: "W1", clientName: "Wholesaler", areaCode: "D17", sheetAreaCode: "D17", salesValue: 900, qty: 9 }),
    // Another area's pharmacy: not ours.
    row({ clientCode: "C9", areaCode: "D17", sheetAreaCode: "D17" }),
    // A row with no customer code: other.
    row({ clientCode: "", clientName: "", salesValue: 40 }),
  ];
  const { sources, buyers } = summariseClosingMonth(rows, "d16");
  assert.deepEqual(
    buyers.map((b) => `${b.key}:${b.product}`).sort(),
    ["IBN|C1:GU001", "IBN|C1:IV001"],
    "one pharmacy buying two products; the return, the direct order, the wholesaler and the other area are not buyers",
  );
  assert.equal(buyers[0].name, "صيدلية النور", "the pharmacy keeps its invoice name");
  assert.equal(sources.direct, 5000);
  assert.equal(sources.wholesalerShare, 700, "the shared customer is a wholesaler's share although only one of its areas is ours");
  assert.equal(sources.pharmacy, 400, "the return nets to nothing inside pharmacy sales");
  assert.equal(sources.other, 40);
}

const rep: EffRep = {
  hrId: "B-1",
  name: "Ebtissam Alaa",
  jobTitle: "Medical Representative",
  line: "Pedia",
  areaCode: "D16",
  areaName: "Kafr El-Sheikh 1",
  regionName: "Delta",
  managerName: "A Manager",
  hireDate: "2026-09-12",
};

const month = (m: string, holder: string, isRepMonth: boolean, extra: Partial<EffMonth>): EffMonth => ({
  month: m,
  holder,
  isRepMonth,
  products: [],
  sources: { direct: 0, wholesalerShare: 0, pharmacy: 0, other: 0 },
  buyers: [],
  ...extra,
});

function theReport() {
  const g = (code: string, units: number, value: number, targetUnits: number | null, targetValue: number | null) => ({
    code,
    name: code === "GU001" ? "Guamusin" : "Lacto Advanced 1",
    actualUnits: units,
    actualValue: value,
    targetUnits,
    targetValue,
  });
  const buyer = (key: string, product: string, brickName = "Kafr El-Sheikh") => ({ key, name: `Pharmacy ${key}`, brickName, product });
  return buildRepEffectiveness({
    rep,
    generatedAt: "2026-11-25T10:00:00Z",
    universe: { total: 1650, byBrick: { "Kafr El-Sheikh": 565, "دسوق": 691 } },
    kpis: [
      {
        month: "2026-11",
        toDate: true,
        unread: false,
        rep: { coveragePct: 40, frequencyPct: 20, amPerDay: 1, amAttainmentPct: 50, pmPerDay: 5, pmAttainmentPct: 50, overallPct: 40, justStarted: false },
        colleagues: [{ name: "Colleague One", area: "Tanta", figures: { coveragePct: 90, frequencyPct: 70, amPerDay: 2, amAttainmentPct: 100, pmPerDay: 9, pmAttainmentPct: 90, overallPct: 88, justStarted: false } }],
      },
    ],
    months: [
      month("2026-10", "Ebtissam Alaa", true, {
        products: [g("GU001", 10, 1000, 20, 2000), g("LA001", 7, 700, null, 1000)],
        sources: { direct: 500, wholesalerShare: 600, pharmacy: 500, other: 0 },
        buyers: [buyer("P1", "GU001"), buyer("P1", "LA001"), buyer("P3", "GU001", "دسوق")],
      }),
      month("2026-08", "Vacant seat", false, {
        products: [g("GU001", 5, 500, 10, 1000)],
        sources: { direct: 0, wholesalerShare: 200, pharmacy: 300, other: 0 },
        buyers: [buyer("P1", "GU001"), buyer("P2", "GU001")],
      }),
      month("2026-09", "Ebtissam Alaa", true, {
        products: [g("GU001", 8, 800, 16, 1600)],
        sources: { direct: 0, wholesalerShare: 400, pharmacy: 400, other: 0 },
        buyers: [buyer("P2", "GU001")],
      }),
    ],
  });
}

function theNumbers(): void {
  const report = theReport();
  assert.deepEqual(report.months, ["2026-08", "2026-09", "2026-10"], "the months run oldest first whatever order they arrive in");
  assert.deepEqual(report.repMonths, ["2026-09", "2026-10"]);
  assert.deepEqual(report.sales.map((s) => s.pharmaciesBuying), [2, 1, 2], "a pharmacy buying two products is one pharmacy that month");
  assert.equal(report.customers.GU001["2026-10"], 2);
  assert.equal(report.customers.LA001["2026-08"], 0, "a product with no buyer reads 0 in a month that was published");
  const oct = report.sales[2];
  assert.equal(oct.actualValue, 1700);
  assert.equal(oct.targetValue, 3000);
  assert.equal(oct.achievementPct, 57);
  assert.equal(oct.achievementWithoutDirectPct, 40, "achievement without the direct order");
  assert.equal(report.sales[0].achievementWithoutDirectPct, null, "no direct order, no second figure");
  for (const s of report.sales) assert.ok(!("actualUnits" in s), "no month total adds units of different products");
  // Growth: September to October, each source's change, and the steps add up to the change.
  const g = report.growth!;
  assert.equal(g.from, "2026-09");
  assert.equal(g.start + g.steps.reduce((sum, s) => sum + s.change, 0), g.end, "the bridge adds up to the change it explains");
  assert.equal(g.steps.find((s) => s.label === "Direct orders")?.change, 500);
  assert.ok(g.steps.some((s) => s.label.startsWith("Closing allocations")), "a gap between the closing and its rows is named, never hidden");
  // Pharmacies: newest buyers first; a first purchase in the rep's months is new, one before her is not.
  const byName = new Map(report.pharmacies.map((p) => [p.name, p]));
  assert.equal(byName.get("Pharmacy P3")?.newInRepTime, true);
  assert.equal(byName.get("Pharmacy P1")?.newInRepTime, false);
  assert.deepEqual(byName.get("Pharmacy P1")?.months["2026-10"], ["G", "LA1"], "the cell names what the pharmacy bought, in product order");
  assert.equal(report.pharmacies[0].lastMonth, "2026-10");
  // Bricks: a brick on the map with no buyer still shows, with its customers on the map.
  assert.equal(report.bricks.find((b) => b.name === "دسوق")?.onMap, 691);
  assert.equal(report.repAveragePerProduct, 1, "Guamusin 1 and 2, Lacto Advanced 0 and 1, over two months");
  assert.equal(report.beforeAveragePerProduct, 2, "only the products sold before her are averaged in the months before");
  // The answers: the customer count comes first, and every answer names its sheet.
  assert.equal(report.answers[0].question, "How many customers does the area reach?");
  assert.match(report.answers[0].answer, /2 pharmacies bought any product in October 2026, out of 1,650/);
  for (const a of report.answers) assert.ok(REP_EFFECTIVENESS_SHEETS.includes(a.sheet as (typeof REP_EFFECTIVENESS_SHEETS)[number]), `${a.sheet} is a sheet`);
  for (const a of report.answers) assert.ok(!/\bher\b|\bhis\b/.test(a.answer), "the rep is named, never her or his");
  assert.deepEqual([...productTags([{ code: "A", name: "Lacto Advanced 1" }, { code: "B", name: "Lacto Advanced 1" }]).values()], ["LA1", "LA12"], "tags never collide");
  assert.equal(reviewFileName("Ebtissam Alaa", report.months, "pdf"), "Ebtissam-Alaa-Effectiveness-Review-2026-08-to-2026-10.pdf");
}

async function theWorkbook(): Promise<void> {
  const report = theReport();
  const book = new ExcelJS.Workbook();
  await book.xlsx.load((await buildRepEffectivenessWorkbook(report)) as unknown as ArrayBuffer);
  assert.deepEqual(book.worksheets.map((ws) => ws.name), [...REP_EFFECTIVENESS_SHEETS], "the eight sheets, in the managers' order");
  const list = book.getWorksheet("Customer list")!;
  assert.equal(list.getCell(1, 4).value, "Pharmacy", "Customer list starts with its table header");
  assert.equal(list.rowCount, 1 + 6, "one row per pharmacy, month and product");
  const text: string[] = [];
  book.getWorksheet("Customers per product")!.eachRow((r) => r.eachCell((c) => text.push(String(c.value ?? ""))));
  assert.ok(text.includes("Guamusin") && text.includes("دسوق"), "products and bricks are on the customers sheet");
  const kpi: string[] = [];
  book.getWorksheet("KPIs vs target")!.eachRow((r) => r.eachCell((c) => kpi.push(String(c.value ?? ""))));
  assert.ok(kpi.some((t) => t.startsWith("Colleague One")), "the district colleagues stand beside the rep");
}

function theDocument(): void {
  const html = buildRepEffectivenessDocument(theReport());
  assert.match(html, /Customers per product per month/);
  assert.match(html, /Effectiveness Review/);
  assert.match(html, /<span dir="rtl" lang="ar">/, "an Arabic name keeps its own direction");
  const fills = [...html.matchAll(/background:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual([...new Set(fills)], ["#F2F6FA"], "the ink rule: the 6% zebra is the only filled area");
}

function theSuperAdminsAlone(): void {
  const route = stripComments(readFileSync("app/api/admin/rep-effectiveness-export/route.ts", "utf8"));
  const gate = route.indexOf("canExportRepEffectiveness(access)");
  assert.ok(gate > 0 && gate < route.indexOf("loadRepEffectiveness("), "the route asks the gate before any read");
  assert.match(route, /assertExportRateLimit\(/, "the export is rate-limited");
  assert.match(route, /writeAuditLog\(/, "the export is audited");
  const server = stripComments(readFileSync("src/lib/sales/rep-effectiveness/server.ts", "utf8"));
  assert.match(server, /export function canExportRepEffectiveness\(access: Pick<AccessContext, "role">\): boolean \{\s*return access\.role === "Super Admin";/);
  const loader = server.slice(server.indexOf("export async function loadRepEffectiveness("));
  const askedAt = loader.indexOf("if (!canExportRepEffectiveness(access)) throw forbiddenError");
  assert.ok(askedAt > 0 && askedAt < loader.indexOf("getSupabaseAdmin()") && askedAt < loader.indexOf("loadPhoenixCrmOrg()"), "the loader asks again before its first read");
  assert.match(server, /listPublishedPeriodsForLine\(/, "only published closing months are read");
  const page = stripComments(readFileSync("app/(admin)/admin/rep-visits-export/page.tsx", "utf8"));
  assert.match(page, /const REVIEW_ROUTE = "\/api\/admin\/rep-effectiveness-export"/);
  assert.match(page, /value="xlsx"/);
  assert.match(page, /value="pdf"/);
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(registry, /pattern: "\/api\/admin\/rep-effectiveness-export"/);
}

export async function runRepEffectivenessExportTests() {
  oneMonthOfRows();
  theNumbers();
  await theWorkbook();
  theDocument();
  theSuperAdminsAlone();
}
