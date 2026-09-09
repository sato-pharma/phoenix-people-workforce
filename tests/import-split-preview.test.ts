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

  // ── El Qema, 700 packs: the priority ladder, owner 2026-09-09 ────────────────────────────────
  //
  // 🔴 There is no local half and no national half any more, so `nationalSplit` is false for every
  // El Qema row and `unitsPerAwayArea` is zero. This block used to assert 350 over a seven-area
  // Qalubeya + Cairo block and 350 over the other 42; both of those rules are gone.
  const sept = buildImportSplitPlan({ period: "2026-09", rows: [row()] });
  assert.equal(sept.splitActive, true);
  const forsan = sept.customers[0];
  assert.equal(forsan.willSplit, true);
  assert.equal(forsan.nationalSplit, false, "the ladder has no away block to report");
  assert.equal(
    forsan.group,
    "El Qema priority ladder",
    "and the city column names the rule that moved the money",
  );
  assert.equal(forsan.targetAreas.length, COUNTRY_AREAS, "every area in the country receives something");
  assert.ok(forsan.targetAreas.includes("D11"), "Qalubeya takes a share like everyone else");
  assert.ok(forsan.targetAreas.includes("AB1"), "and so does Alexandria");
  assert.equal(
    Number(forsan.unitsPerArea.toFixed(6)),
    Number((700 / COUNTRY_AREAS).toFixed(6)),
    "the headline is the MEAN per area — one number cannot say more about a ladder",
  );
  assert.equal(forsan.unitsPerAwayArea, 0, "there is no away block, so nothing divides over one");
  assert.equal(sept.widestFanOut, COUNTRY_AREAS, "the headline reports the widest reach in the file");

  // ── 🔴 THE ORIGIN AND THE SIZE BOTH STOPPED MATTERING — owner, 2026-09-09 ────────────────────
  //
  // This block used to prove three things that are all now false: that Sohag kept half its own sale
  // across its two areas, that 120 packs in a one-area governorate stayed whole because there was
  // nothing to divide across, and that the same customer over 200 behaved differently. The ladder
  // has no governorate and no threshold, so every El Qema row reaches every area whatever its size
  // and wherever it was sold.
  const mixed = buildImportSplitPlan({
    period: "2026-09",
    rows: [
      row({ areaCode: "UE5", clientCode: "3040", clientName: "بدر فارم سوهاج", qty: 960 }),
      row({ areaCode: "UE9", clientCode: "1099", clientName: "دار الادويه للتوكيلات الطبيه", qty: 120 }),
    ],
  });
  const sohag = mixed.customers.find((c) => c.clientCode === "3040");
  assert.equal(sohag?.targetAreas.length, COUNTRY_AREAS, "960 packs reaches every area");
  assert.equal(
    Number((sohag?.unitsPerArea ?? 0).toFixed(6)),
    Number((960 / COUNTRY_AREAS).toFixed(6)),
    "and the mean per area is simply the quantity over the country",
  );
  assert.equal(sohag?.group, "El Qema priority ladder");

  const beniSuef = mixed.customers.find((c) => c.clientCode === "1099");
  assert.equal(beniSuef?.willSplit, true, "120 packs now splits too — there is no threshold left");
  assert.equal(beniSuef?.targetAreas.length, COUNTRY_AREAS, "and it reaches every area as well");
  assert.equal(beniSuef?.nationalSplit, false, "with no away block to report");

  // The same customer at twice the size behaves identically, in proportion.
  const beniSuefBig = buildImportSplitPlan({
    period: "2026-09",
    rows: [row({ areaCode: "UE9", clientCode: "1099", clientName: "دار الادويه للتوكيلات الطبيه", qty: 240 })],
  });
  assert.equal(beniSuefBig.customers[0].willSplit, true, "240 packs splits the same way");
  assert.equal(
    Number(beniSuefBig.customers[0].unitsPerArea.toFixed(6)),
    Number((240 / COUNTRY_AREAS).toFixed(6)),
    "twice the quantity, twice the mean, same shape",
  );

  // ── THE BASKET AND THE PRODUCT NOW GIVE THE SAME ANSWER ──────────────────────────────────────
  //
  // This used to be the sharpest assertion in the file: three products of 100 packs is a 300-pack
  // basket and not one 300-pack product, and reading the basket total would have promised a
  // nationwide fan-out the closing never performed. The ladder has no threshold, so basket and
  // product are indistinguishable and the trap has nothing left to catch. Kept as a live check that
  // per-product accounting still reaches every area rather than deleted, so a future rule with a
  // threshold has somewhere to reattach.
  const basket = buildImportSplitPlan({
    period: "2026-09",
    rows: [
      row({ productCode: "LA001", qty: 100 }),
      row({ productCode: "LA002", qty: 100 }),
      row({ productCode: "LA003", qty: 100 }),
    ],
  });
  assert.equal(basket.customers[0].units, 300, "the customer bought 300 packs in total");
  assert.equal(basket.customers[0].nationalSplit, false, "no away block, whatever the basket holds");
  assert.equal(
    basket.customers[0].targetAreas.length,
    COUNTRY_AREAS,
    "and every product, at any size, reaches every area",
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
  assert.equal(
    alex?.targetAreas.length,
    COUNTRY_AREAS,
    "each leg reaches every area — the ladder is blind to where the leg was sold",
  );
  assert.equal(
    Number((alex?.unitsPerArea ?? 0).toFixed(6)),
    Number((150 / COUNTRY_AREAS).toFixed(6)),
    "and it is still NOT pooled with the Sohag leg — two placements, two plans",
  );

  // ── Rows for one customer, one area and one product are summed before the plan is drawn ───────
  //
  // The summing still matters even without a threshold to judge: the preview reports one placement
  // per customer and area, and two invoice lines must not read as two customers.
  const summed = buildImportSplitPlan({
    period: "2026-09",
    rows: [row({ qty: 350 }), row({ qty: 350 })],
  });
  assert.equal(summed.customers.length, 1, "two invoice lines, one customer, one placement");
  assert.equal(summed.customers[0].units, 700);
  assert.equal(
    Number(summed.customers[0].unitsPerArea.toFixed(6)),
    Number((700 / COUNTRY_AREAS).toFixed(6)),
    "and the mean is taken on the summed 700, not on either line alone",
  );

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
