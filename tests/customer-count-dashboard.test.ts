import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildClosingPharmacyCounts, type PharmacyCountRow } from "../src/lib/sales/closing-pharmacy-counts.ts";
import { buildCustomerCountPayload, NO_REP_LABEL, type CustomerCountRow } from "../src/lib/sales/customer-count-build.ts";
import {
  breakdown,
  filterFacts,
  monthTrend,
  summarize,
  type CustomerCountPayload,
} from "../src/lib/sales/customer-count-dashboard.ts";

// The Customer Count dashboard (owner, 24 Nov 2026: "I want a separate dashboard for number of
// customers … month by month, per product, per line, per rep, per area, per region, per brick", then
// "keep a monthly closing sheets, but I want a dashboard specialized for now customer count").
//
// WHO BOUGHT is the Closing Matrix's own rule (one distributor customer, net units above zero, real
// pharmacies only), each month judged on its own — so a month here equals that month's Pharmacies
// column. Every cut is a count of DISTINCT pharmacies: never a sum of rows.

function row(overrides: Partial<CustomerCountRow> & { clientCode: string; productCode: string }): CustomerCountRow {
  return {
    distributorCode: "UCP",
    clientName: `Pharmacy ${overrides.clientCode}`,
    clientAddress: "",
    areaCode: "D16",
    sheetAreaCode: "D16",
    areaName: "Kafr El-Sheikh 1",
    sheetAreaName: "Kafr El-Sheikh 1",
    brickId: "B1",
    brickName: "Desouk",
    productName: overrides.productCode === "IV" ? "Ivyronc" : overrides.productCode === "GU" ? "Guamusin" : overrides.productCode,
    salesValue: 100,
    effectiveUnits: 2,
    qty: 2,
    isDirect: false,
    evenSplitApplied: false,
    includedInClosing: true,
    operationalRegionName: "Delta",
    ...overrides,
  };
}

const AUG = "2026-08";
const SEP = "2026-09";
const OCT = "2026-10";

const D17 = { areaCode: "D17", sheetAreaCode: "D17", areaName: "Kafr El-Sheikh 2", sheetAreaName: "Kafr El-Sheikh 2", brickId: "B2", brickName: "Bila" };
const CA1 = { areaCode: "CA1", sheetAreaCode: "CA1", areaName: "Heliopolis", sheetAreaName: "Heliopolis", brickId: "B9", brickName: "Korba", operationalRegionName: "Cairo" };

const pedia = {
  [AUG]: [
    row({ clientCode: "1", productCode: "IV" }),
    row({ clientCode: "1", productCode: "GU" }), // same pharmacy, second product: still ONE pharmacy
    row({ clientCode: "2", productCode: "IV" }),
    row({ clientCode: "3", productCode: "IV", qty: 2 }),
    row({ clientCode: "3", productCode: "IV", qty: -2 }), // a return that nets to zero: not a purchase
    row({ clientCode: "4", productCode: "IV", ...D17 }),
    row({ clientCode: "5", productCode: "IV", ...CA1 }),
    row({ clientCode: "6", productCode: "IV", isDirect: true }), // a direct order is not a pharmacy that bought
    row({ clientCode: "7", productCode: "IV", includedInClosing: false }), // outside the closing
    // A customer the closing shares across two areas is a wholesaler's city share, not a pharmacy.
    row({ clientCode: "W", productCode: "IV" }),
    row({ clientCode: "W", productCode: "IV", ...D17 }),
  ],
  [SEP]: [
    row({ clientCode: "1", productCode: "IV" }),
    row({ clientCode: "2", productCode: "GU" }),
    row({ clientCode: "8", productCode: "IV" }), // new in September
    row({ clientCode: "5", productCode: "IV", ...CA1 }),
  ],
  [OCT]: [
    row({ clientCode: "1", productCode: "IV" }),
    row({ clientCode: "8", productCode: "IV" }),
    row({ clientCode: "5", productCode: "GU", ...CA1 }),
  ],
};

// The same pharmacy (UCP|1) also buys on CNS in October — "all lines" must still count it once.
const cns = {
  [OCT]: [row({ clientCode: "1", productCode: "CX" }), row({ clientCode: "9", productCode: "CX", ...D17 })],
};

const reps: Record<string, string> = {
  "pedia::D16": "Ebtissam Alaa",
  "pedia::D17": "Mona Salah",
  "cns::D16": "Karim Adel",
};

function payload(): CustomerCountPayload {
  return buildCustomerCountPayload({
    months: [AUG, SEP, OCT],
    lines: [
      { line: "Pedia", months: Object.entries(pedia).map(([month, rows]) => ({ month, rows })) },
      { line: "CNS", months: Object.entries(cns).map(([month, rows]) => ({ month, rows })) },
    ],
    repFor: (line, area) => reps[`${line.toLowerCase()}::${area}`] ?? null,
    availableMonths: [OCT, SEP, AUG],
    availableLines: ["CNS", "Pedia"],
    unpublished: [{ line: "CNS", month: AUG }],
  });
}

const index = (list: readonly string[], value: string) => {
  const found = list.indexOf(value);
  assert.notEqual(found, -1, `${value} is in the payload`);
  return found;
};

export async function runCustomerCountDashboardTests() {
  const data = payload();
  const all = data.facts;

  // ── Month by month, all lines ────────────────────────────────────────────────────────────────
  const trend = monthTrend(data, all);
  assert.deepEqual(
    trend.map((point) => point.month),
    [AUG, SEP, OCT],
    "the axis is the months picked, oldest first",
  );
  // August: 1, 2, 4, 5. Not 3 (nets to zero), 6 (direct), 7 (outside the closing), W (wholesaler).
  assert.equal(trend[0].pharmacies, 4, "August counts four pharmacies: the net, direct, closing and wholesaler rules all hold");
  assert.equal(trend[1].pharmacies, 4, "September: 1, 2, 8, 5");
  // October: Pedia 1, 8, 5 and CNS 1, 9 — pharmacy 1 buys on both lines and counts ONCE.
  assert.equal(trend[2].pharmacies, 4, "October across all lines counts a pharmacy on two lines once");
  assert.equal(trend[0].gained, null, "the first month has nothing to compare with");
  assert.equal(trend[1].gained, 1, "September gained pharmacy 8");
  assert.equal(trend[1].lost, 1, "September lost pharmacy 4");
  assert.equal(trend[2].gained, 1, "October gained pharmacy 9");
  assert.equal(trend[2].lost, 1, "October lost pharmacy 2");
  assert.equal(trend[0].productsPerPharmacy, 5 / 4, "August: pharmacy 1 took two products, three took one");

  const summary = summarize(data, all);
  assert.equal(summary.latest, 4);
  assert.equal(summary.previous, 4);
  assert.equal(summary.reached, 6, "1, 2, 4, 5, 8 and 9: every distinct pharmacy across the three months, once");
  assert.equal(summary.everyMonth, 2, "pharmacies 1 and 5 bought in all three months");

  // ── Per line ─────────────────────────────────────────────────────────────────────────────────
  const byLine = breakdown(data, all, "line");
  const pediaRow = byLine.find((entry) => entry.label === "Pedia");
  const cnsRow = byLine.find((entry) => entry.label === "CNS");
  assert.deepEqual(pediaRow?.perMonth, [4, 4, 3], "Pedia by month");
  assert.deepEqual(cnsRow?.perMonth, [0, 0, 2], "CNS bought only in October");
  assert.equal(pediaRow?.change, -1);

  // ── Per area, region, brick, product, rep ────────────────────────────────────────────────────
  const byArea = breakdown(data, all, "area");
  const d16 = byArea.find((entry) => entry.label === "Kafr El-Sheikh 1");
  assert.deepEqual(d16?.perMonth, [2, 3, 2], "D16: Aug 1+2, Sep 1+2+8, Oct 1+8 (pharmacy 1 on two lines once)");
  assert.equal(d16?.parent, "Delta", "an area names its region");
  const byRegion = breakdown(data, all, "region");
  assert.deepEqual(byRegion.find((entry) => entry.label === "Delta")?.perMonth, [3, 3, 3], "Delta = D16 + D17, distinct");
  assert.deepEqual(byRegion.find((entry) => entry.label === "Cairo")?.perMonth, [1, 1, 1]);
  const byBrick = breakdown(data, all, "brick");
  assert.equal(byBrick.find((entry) => entry.label === "Korba")?.parent, "Heliopolis", "a brick names its area");
  const byProduct = breakdown(data, all, "product");
  const iv = byProduct.find((entry) => entry.label === "Ivyronc");
  assert.deepEqual(iv?.perMonth, [4, 3, 2], "Ivyronc buyers by month");
  assert.equal(iv?.parent, "Pedia", "a product names its line");
  const byRep = breakdown(data, all, "rep");
  assert.deepEqual(byRep.find((entry) => entry.label === "Ebtissam Alaa")?.perMonth, [2, 3, 2], "the rep on D16's Pedia seat");
  assert.deepEqual(byRep.find((entry) => entry.label === "Karim Adel")?.perMonth, [0, 0, 1], "the rep on D16's CNS seat");
  assert.ok(byRep.some((entry) => entry.label === NO_REP_LABEL), "an area with nobody on the seat says so, never blank");

  // ── Filters narrow, then count distinct ──────────────────────────────────────────────────────
  const delta = filterFacts(data, { regions: [index(data.regions, "Delta")] });
  assert.deepEqual(monthTrend(data, delta).map((point) => point.pharmacies), [3, 3, 3], "the Delta filter");
  const pediaOnly = filterFacts(data, { lines: [index(data.lines, "Pedia")] });
  assert.deepEqual(monthTrend(data, pediaOnly).map((point) => point.pharmacies), [4, 4, 3], "the Pedia filter");

  // ── It equals the Closing Matrix's Pharmacies column, month by month ─────────────────────────
  for (const [month, rows] of Object.entries(pedia)) {
    const closing = buildClosingPharmacyCounts({ line: "Pedia", periods: [{ period: month, rows: rows as PharmacyCountRow[] }] });
    const monthIndex = data.months.indexOf(month);
    for (const [areaCode, products] of Object.entries(closing.areas)) {
      const fromClosing = new Set(Object.values(products).flat()).size;
      const areaIndex = data.areas.findIndex((entry) => entry.code === areaCode);
      const fromDashboard = breakdown(data, pediaOnly, "area").find((entry) => entry.key === `area:${areaIndex}`)?.perMonth[monthIndex];
      assert.equal(fromDashboard, fromClosing, `${month} ${areaCode}: the dashboard equals the closing's Pharmacies column`);
    }
  }

  // ── No customer code or name leaves the server ───────────────────────────────────────────────
  const wire = JSON.stringify(data);
  assert.ok(!wire.includes("Pharmacy 1") && !wire.includes("UCP|"), "the payload carries ids, never a customer's code or name");
  assert.deepEqual(data.unpublished, [{ line: "CNS", month: AUG }], "an unpublished month is named, never a zero");

  // ── The doors ────────────────────────────────────────────────────────────────────────────────
  const loader = readFileSync(new URL("../src/lib/sales/customer-count-loader.ts", import.meta.url), "utf8");
  assert.match(loader, /access\.role === "Medical Rep"/, "the portal read refuses a Medical Rep");
  assert.match(loader, /listPublishedPeriodsForLine/, "published months only");
  assert.match(loader, /narrowClosingDetailsToAreas/, "a manager is narrowed to his own areas");
  const adminRoute = readFileSync(new URL("../app/api/sales/customer-count/route.ts", import.meta.url), "utf8");
  assert.match(adminRoute, /access\.role !== "Super Admin" && access\.scope !== "system" && access\.role !== "SFE Manager" && access\.role !== "CEO"/, "the admin route has the admin closing's gate");
  const portalRoute = readFileSync(new URL("../app/api/employee-portals/customer-count/route.ts", import.meta.url), "utf8");
  assert.match(portalRoute, /canAccessPortalClosing\(access\)/, "the portal route has the portal closing's gate");
}
