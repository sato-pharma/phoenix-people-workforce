import assert from "node:assert/strict";

import { buildImportSplitPlan, type SplitPlanSourceRow } from "../src/lib/sales/import-split-preview.ts";

/**
 * THE VALIDATION SCREEN MUST SAY WHERE THE MONEY GOES — owner, 2026-09-07: "you only consider the
 * qty and the city, then must in validation show the city and show how it will be distributed."
 *
 * Until this existed the import preview answered "will it work" and never "what will it do". For a
 * wholesaler file that is the whole question: El Qema's Qalubeya customer reaches SEVEN areas, its
 * Sohag customer reaches TWO, and its Beni Suef customer reaches only itself — and the only way to
 * learn that was to import the file and read the closing afterwards.
 *
 * THE PLAN MUST EQUAL WHAT THE CLOSING WILL DO. It is built by calling the split's own functions,
 * never by restating the rule, so these assertions are really checking the wiring: same period gate,
 * same eligibility, same targets. Real El Qema customers and their real August areas are used so a
 * change to the rule shows up here as a changed plan rather than as an abstraction that still passes.
 */

const base: SplitPlanSourceRow = {
  areaCode: "D11",
  clientCode: "2678",
  clientName: "الفرسان انترناشول جروب بنها",
  distributorCode: "QM",
  isDirect: false,
  officialLine: "Pedia",
  qty: 700,
};

const row = (over: Partial<SplitPlanSourceRow> = {}): SplitPlanSourceRow => ({ ...base, ...over });

export function runImportSplitPreviewTests() {
  // ── The period gate is reported, not left to be inferred from an empty list ───────────────────
  const july = buildImportSplitPlan({ period: "2026-07", rows: [row()] });
  assert.equal(july.splitActive, false, "July predates the split — the plan says so explicitly");
  assert.equal(july.splittingCustomers, 0);
  assert.equal(july.customers[0].willSplit, false);
  assert.match(
    july.customers[0].reason ?? "",
    /does not apply to 2026-07/,
    "and the reason names the period rather than blaming the customer",
  );

  // ── El Qema, Qalubeya: seven areas, evenly ────────────────────────────────────────────────────
  const sept = buildImportSplitPlan({ period: "2026-09", rows: [row()] });
  assert.equal(sept.splitActive, true);
  const forsan = sept.customers[0];
  assert.equal(forsan.willSplit, true);
  assert.equal(forsan.group, "Qalubeya + Cairo (El Qema)", "the city column names the rule that moved it");
  assert.deepEqual(forsan.targetAreas, ["CA1", "CA2", "CA3", "CA4", "CA5", "CA6", "D11"]);
  assert.equal(forsan.unitsPerArea, 100, "700 units / 7 areas");
  assert.equal(sept.widestFanOut, 7, "the headline reports the widest reach in the file");

  // ── Sohag: two areas. Beni Suef: one, so it stays whole and says why ──────────────────────────
  const mixed = buildImportSplitPlan({
    period: "2026-09",
    rows: [
      row({ areaCode: "UE5", clientCode: "3040", clientName: "بدر فارم سوهاج", qty: 960 }),
      row({ areaCode: "UE9", clientCode: "1099", clientName: "دار الادويه للتوكيلات الطبيه", qty: 240 }),
    ],
  });
  const sohag = mixed.customers.find((c) => c.clientCode === "3040");
  assert.deepEqual(sohag?.targetAreas, ["UE5", "UE6"], "Sohag holds two areas");
  assert.equal(sohag?.unitsPerArea, 480, "960 / 2");
  assert.equal(sohag?.group, "Sohag");

  const beniSuef = mixed.customers.find((c) => c.clientCode === "1099");
  assert.equal(beniSuef?.willSplit, false, "Beni Suef holds one area — nothing to divide across");
  assert.match(
    beniSuef?.reason ?? "",
    /one area only/,
    "and the reason says so, because staying whole here is CORRECT and must not read as a fault",
  );
  assert.equal(beniSuef?.unitsPerArea, 240, "a customer that stays whole keeps all its units");

  // ── A pharmacy is reported as a pharmacy, not as an unexplained no ────────────────────────────
  const pharmacy = buildImportSplitPlan({
    period: "2026-09",
    rows: [row({ areaCode: "CA2", clientCode: "P-1", clientName: "صيدلية النور", distributorCode: "PS" })],
  });
  assert.equal(pharmacy.customers[0].willSplit, false);
  assert.match(pharmacy.customers[0].reason ?? "", /pharmacy/, "the reason names the classification");

  // ── Head Office never splits, and says which line stopped it ──────────────────────────────────
  const headOffice = buildImportSplitPlan({
    period: "2026-09",
    rows: [row({ areaCode: "CA2", clientCode: "H-1", clientName: "مخزن الحجاز", officialLine: "Head Office" })],
  });
  assert.equal(headOffice.customers[0].willSplit, false);
  assert.match(headOffice.customers[0].reason ?? "", /not a split line/);

  // ── One customer in TWO areas is TWO placements, never one merged fan-out ─────────────────────
  const twoAreas = buildImportSplitPlan({
    period: "2026-09",
    rows: [
      row({ areaCode: "UE5", clientCode: "SAME", clientName: "مخزن المدينة", qty: 100 }),
      row({ areaCode: "AB2", clientCode: "SAME", clientName: "مخزن المدينة", qty: 300 }),
    ],
  });
  assert.equal(twoAreas.customers.length, 2, "grouped by customer AND origin area");
  const alex = twoAreas.customers.find((c) => c.originArea === "AB2");
  assert.deepEqual(alex?.targetAreas, ["AB1", "AB2", "AB3"], "the Alexandria leg spreads across Alexandria");
  assert.equal(alex?.unitsPerArea, 100, "300 / 3 — and it is NOT pooled with the Sohag leg");

  // ── Rows for one customer in one area are summed before the plan is drawn ─────────────────────
  const summed = buildImportSplitPlan({
    period: "2026-09",
    rows: [row({ qty: 350 }), row({ qty: 350 })],
  });
  assert.equal(summed.customers.length, 1, "two invoice lines, one customer, one placement");
  assert.equal(summed.customers[0].units, 700);
  assert.equal(summed.customers[0].unitsPerArea, 100);

  // ── Biggest first, so a file of small pharmacies cannot bury the one that moves ───────────────
  const ordered = buildImportSplitPlan({
    period: "2026-09",
    rows: [
      row({ areaCode: "CA2", clientCode: "SMALL", clientName: "مخزن صغير", qty: 6 }),
      row({ areaCode: "CA2", clientCode: "BIG", clientName: "مخزن كبير", qty: 6000 }),
    ],
  });
  assert.equal(ordered.customers[0].clientCode, "BIG", "the customer that moves the most money is first");
}
