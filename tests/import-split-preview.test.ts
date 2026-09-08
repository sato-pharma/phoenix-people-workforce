import assert from "node:assert/strict";

import { buildImportSplitPlan, type SplitPlanSourceRow } from "../src/lib/sales/import-split-preview.ts";

/**
 * THE VALIDATION SCREEN MUST SAY WHERE THE MONEY GOES — owner, 2026-09-07: "you only consider the
 * qty and the city, then must in validation show the city and show how it will be distributed."
 *
 * Until this existed the import preview answered "will it work" and never "what will it do". For a
 * wholesaler file that is the whole question, and since the 200-pack rule of 2026-09-08 it is a
 * bigger one: an El Qema warehouse over 200 packs of a product now reaches EVERY area in the
 * country, and the only way to learn that used to be to import the file and read the closing after.
 *
 * THE PLAN MUST EQUAL WHAT THE CLOSING WILL DO. It is built by calling the split's own functions,
 * never by restating the rule, so these assertions are really checking the wiring: same period gate,
 * same eligibility, same targets. Real El Qema customers and their real August areas are used so a
 * change to the rule shows up here as a changed plan rather than as an abstraction that still passes.
 *
 * 🔴 THE THRESHOLD IS PER PRODUCT, AND THE PREVIEW DISPLAYS PER CUSTOMER. Those two grains are not
 * the same, and reading the customer's basket total would report a national fan-out the closing will
 * not perform. `productCode` is on the source row for exactly that reason.
 */

/** Every area on the city list. The national half of a large order reaches all but its own city. */
const COUNTRY_AREAS = 49;

const base: SplitPlanSourceRow = {
  areaCode: "D11",
  clientCode: "2678",
  clientName: "الفرسان انترناشول جروب بنها",
  distributorCode: "QM",
  isDirect: false,
  officialLine: "Pedia",
  productCode: "LA001",
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

  // ── El Qema, Qalubeya, 700 packs: half stays, half crosses the country ───────────────────────
  const sept = buildImportSplitPlan({ period: "2026-09", rows: [row()] });
  assert.equal(sept.splitActive, true);
  const forsan = sept.customers[0];
  assert.equal(forsan.willSplit, true);
  assert.equal(forsan.nationalSplit, true, "700 packs of one product is over 200");
  assert.equal(forsan.group, "Qalubeya + nationwide", "the city column names the rule that moved it");
  assert.equal(forsan.targetAreas.length, COUNTRY_AREAS, "every area in the country receives something");
  assert.ok(forsan.targetAreas.includes("D11"), "Qalubeya keeps a share of its own sale");
  assert.ok(forsan.targetAreas.includes("AB1"), "and Alexandria, which the old Cairo-only rule never reached");
  assert.equal(forsan.unitsPerArea, 350, "half of 700 stays in Qalubeya, which holds one area");
  assert.equal(
    Number(forsan.unitsPerAwayArea.toFixed(6)),
    Number((350 / 48).toFixed(6)),
    "the other half divides evenly over the 48 areas outside Qalubeya",
  );
  assert.equal(sept.widestFanOut, COUNTRY_AREAS, "the headline reports the widest reach in the file");

  // ── Sohag holds two areas, so the home half splits between them ──────────────────────────────
  const mixed = buildImportSplitPlan({
    period: "2026-09",
    rows: [
      row({ areaCode: "UE5", clientCode: "3040", clientName: "بدر فارم سوهاج", qty: 960 }),
      row({ areaCode: "UE9", clientCode: "1099", clientName: "دار الادويه للتوكيلات الطبيه", qty: 120 }),
    ],
  });
  const sohag = mixed.customers.find((c) => c.clientCode === "3040");
  assert.equal(sohag?.targetAreas.length, COUNTRY_AREAS, "960 packs is over 200, so it goes national");
  assert.equal(sohag?.unitsPerArea, 240, "480 of the 960 stays in Sohag, across its two areas");
  assert.equal(sohag?.group, "Sohag + nationwide");

  // ── Up to 200 in a one-area governorate stays whole, and says why ─────────────────────────────
  //
  // This is the half of the rule that is easiest to lose: "وليس له علاقه بتوزيع الجمهورية" — a small
  // order has NOTHING to do with the national spread. Beni Suef holds one area, so nothing moves.
  const beniSuef = mixed.customers.find((c) => c.clientCode === "1099");
  assert.equal(beniSuef?.willSplit, false, "120 packs stays in Beni Suef, which holds one area");
  assert.equal(beniSuef?.nationalSplit, false, "and it never reaches the national half");
  assert.match(
    beniSuef?.reason ?? "",
    /one area only/,
    "and the reason says so, because staying whole here is CORRECT and must not read as a fault",
  );
  assert.equal(beniSuef?.unitsPerArea, 120, "a customer that stays whole keeps all its units");

  // The SAME customer over the threshold does move — one area at home, the rest of the country away.
  const beniSuefBig = buildImportSplitPlan({
    period: "2026-09",
    rows: [row({ areaCode: "UE9", clientCode: "1099", clientName: "دار الادويه للتوكيلات الطبيه", qty: 240 })],
  });
  assert.equal(beniSuefBig.customers[0].willSplit, true, "240 packs crosses 200 even in a one-area governorate");
  assert.equal(beniSuefBig.customers[0].unitsPerArea, 120, "half stays on Beni Suef's single area");

  // ── 🔴 THE THRESHOLD IS PER PRODUCT, NEVER THE BASKET ────────────────────────────────────────
  //
  // Three products of 100 packs each is a 300-pack basket and not one 300-pack product. Judged on the
  // basket this customer would be reported as reaching the whole country; judged correctly it does
  // not leave Qalubeya at all, and Qalubeya holds one area, so nothing moves.
  const basket = buildImportSplitPlan({
    period: "2026-09",
    rows: [
      row({ productCode: "LA001", qty: 100 }),
      row({ productCode: "LA002", qty: 100 }),
      row({ productCode: "LA003", qty: 100 }),
    ],
  });
  assert.equal(basket.customers[0].units, 300, "the customer bought 300 packs in total");
  assert.equal(
    basket.customers[0].willSplit,
    false,
    "but no single PRODUCT crossed 200, so nothing goes national — reading the basket total here "
      + "would promise a fan-out the closing never performs",
  );

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
      row({ areaCode: "AB2", clientCode: "SAME", clientName: "مخزن المدينة", qty: 150 }),
    ],
  });
  assert.equal(twoAreas.customers.length, 2, "grouped by customer AND origin area");
  const alex = twoAreas.customers.find((c) => c.originArea === "AB2");
  assert.deepEqual(alex?.targetAreas, ["AB1", "AB2", "AB3"], "the Alexandria leg spreads across Alexandria");
  assert.equal(alex?.unitsPerArea, 50, "150 / 3 — and it is NOT pooled with the Sohag leg");

  // ── Rows for one customer, one area and one product are summed before the plan is drawn ───────
  const summed = buildImportSplitPlan({
    period: "2026-09",
    rows: [row({ qty: 350 }), row({ qty: 350 })],
  });
  assert.equal(summed.customers.length, 1, "two invoice lines, one customer, one placement");
  assert.equal(summed.customers[0].units, 700);
  assert.equal(summed.customers[0].unitsPerArea, 350, "and the 200 rule is judged on the 700, not on either 350");

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
