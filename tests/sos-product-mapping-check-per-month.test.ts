import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { findZeroSalesGaps, type SalesRow } from "../scripts/check-sos-product-mapping.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 2 of the product-mapping check judges EACH MONTH on its own units.
//
// It added every month together. Once a distributor had sold a product in ANY month, a month with
// zero could never be reported again, so the one detector built for the Overseas Rispadex syrup
// mis-map (item 7520 filed under Conviban 100) was blind to exactly that incident. Source of Sales
// audit, finding `scripts/check-sos-product-mapping.ts:220`, still open on the 2026-09-06 re-measure.
//
// Production on 2026-09-18 (read-only): Pharma Overseas sold Rispadex syrup (RI003) in January,
// February, July and August, and exactly zero in March to June. Judged month by month, all four
// zero months are reported; added together, none is. The fixture below is that shape.
// ─────────────────────────────────────────────────────────────────────────────

const SCRIPT = "scripts/check-sos-product-mapping.ts";

const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
const OVERSEAS_SYRUP: Record<string, number> = { "2026-01": 1174, "2026-02": 1036, "2026-07": 1298, "2026-08": 1306 };

function cns(period: string, distributor: string, product: string, qty: number): SalesRow {
  return { distributor_code: distributor, invoice_period: period, official_line: "CNS", product_code: product, qty };
}

function incidentRows(): SalesRow[] {
  const rows: SalesRow[] = [];
  for (const month of MONTHS) {
    // Pharma Overseas carries the line every month; its Rispadex syrup is zero March to June.
    rows.push(cns(month, "PS", "CO004", 2100), cns(month, "PS", "TE003", 5000));
    const syrup = OVERSEAS_SYRUP[month];
    if (syrup) rows.push(cns(month, "PS", "RI003", syrup));
    // Ibn Sina sells the whole range every month.
    rows.push(cns(month, "IS", "CO004", 1500), cns(month, "IS", "RI003", 2300), cns(month, "IS", "TE003", 4300));
  }
  // A product launched in July: only Ibn Sina has it, and only in July.
  rows.push(cns("2026-07", "IS", "NEW01", 800));
  // A distributor that uploaded January only, with no Rispadex syrup.
  rows.push(cns("2026-01", "MC", "TE003", 3000), cns("2026-01", "MC", "CO004", 500));
  return rows;
}

const key = (g: { period: string; distributorCode: string; productCode: string }) => `${g.period} ${g.distributorCode} ${g.productCode}`;

export function runSosProductMappingCheckPerMonthTests() {
  const gaps = findZeroSalesGaps(incidentRows());

  // ── The headline: every zero month is reported, however much sold in other months ─
  assert.deepEqual(
    gaps.filter((g) => g.distributorCode === "PS" && g.productCode === "RI003").map((g) => g.period),
    ["2026-06", "2026-05", "2026-04", "2026-03"],
    "Overseas sold zero Rispadex syrup March to June — each month must be reported, not hidden by the units it sold in January, February, July and August",
  );

  // ── Each month is judged against that month alone ─────────────────────────────
  assert.deepEqual(
    gaps.map(key),
    ["2026-07 PS NEW01", "2026-06 PS RI003", "2026-05 PS RI003", "2026-04 PS RI003", "2026-03 PS RI003", "2026-01 MC RI003"],
    "exactly these six, newest month first",
  );
  const syrupInMarch = gaps.find((g) => g.period === "2026-03" && g.productCode === "RI003");
  assert.ok(syrupInMarch);
  assert.equal(syrupInMarch.productUnitsElsewhere, 2300, "units sold elsewhere are THAT month's, not a lifetime total");
  assert.equal(
    gaps.some((g) => g.productCode === "NEW01" && g.period !== "2026-07"),
    false,
    "a product nobody sold that month is not expected of anyone that month — a July launch is not a gap in March",
  );
  assert.equal(
    gaps.some((g) => g.distributorCode === "MC" && g.period !== "2026-01"),
    false,
    "a distributor with no rows in a month is not judged for it: not every distributor uploads every month",
  );

  // ── Why the month matters: added together, the incident disappears ────────────
  const noMonth = incidentRows().map((row) => ({ ...row, invoice_period: null }));
  assert.equal(
    findZeroSalesGaps(noMonth).some((g) => g.distributorCode === "PS" && g.productCode === "RI003"),
    false,
    "rows with no month are judged together, as before — which is exactly why the script must read the month",
  );
  assert.ok(findZeroSalesGaps(noMonth).every((g) => g.period === ""), "rows with no month form one group");

  // ── The script reads the month from the fact rows ─────────────────────────────
  const script = stripComments(readFileSync(SCRIPT, "utf8"));
  assert.match(
    script,
    /\.select\("distributor_code,invoice_period,official_line,product_code,qty"\)/,
    "main() must read invoice_period, or every row lands in one no-month group and the lifetime blind spot is back",
  );
}
