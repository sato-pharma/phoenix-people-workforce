import assert from "node:assert/strict";

import { buildImportSplitPlan, type SplitPlanSourceRow } from "../src/lib/sales/import-split-preview.ts";
import { LOCAL_BLOCK_OVERRIDES } from "../src/lib/sales/store-sales-city-split.ts";

import { referenceQemaShares } from "./qema-warehouse-split.test.ts";

/**
 * THE VALIDATION SCREEN MUST SAY WHERE THE MONEY GOES — owner, 2026-09-07: "you only consider the
 * qty and the city, then must in validation show the city and show how it will be distributed."
 *
 * Until this existed the import preview answered "will it work" and never "what will it do". For a
 * wholesaler file that is the whole question, and under the 200-pack rule it is a bigger one: an El
 * Qema warehouse over 200 packs of a product reaches EVERY area in the country, and the only way to
 * learn that used to be to import the file and read the closing after.
 *
 * 🔴 THE PREVIEW READS THE PLAN'S SHARES, NEVER `homeFraction` ON ITS OWN. El Qema's صعيد
 * redistribution is a weight on the plan, so the fraction describes the band a row started from and
 * not what any area receives. Every expected number below comes from `referenceQemaShares`, the
 * independent derivation of the owner's words in the El Qema suite, so this file proves the wiring
 * rather than restating the rule — which is the whole point of building the preview from the
 * split's own functions.
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

/** Every area on the city list. No organogram is loaded here, so nothing is parked in Others. */
const COUNTRY_AREAS = 49;

/** No regions map reaches the preview, so the exclusion set is empty on every plan it builds. */
const NO_OTHERS: ReadonlySet<string> = new Set<string>();

/** Qalubeya's local block: itself plus the six Cairo areas, and no area of it weighted above another. */
const QALUBEYA_BLOCK = LOCAL_BLOCK_OVERRIDES.get("QM|D11")?.areas ?? [];

/** What the owner's rule gives one area of the home block, and one of the rest of the country. */
function blockMeans(origin: string, units: number) {
  const shares = referenceQemaShares(origin, units, units, NO_OTHERS);
  const block = origin === "D11" ? QALUBEYA_BLOCK : [];
  const home = block.reduce((sum, area) => sum + (shares.get(area) ?? 0), 0);
  const awayParts = COUNTRY_AREAS - block.length;
  return {
    home: block.length > 0 ? home / block.length : 0,
    away: awayParts > 0 ? (units - home) / awayParts : 0,
  };
}

const near = (actual: number, expected: number) => Number(actual.toFixed(6)) === Number(expected.toFixed(6));

const base: SplitPlanSourceRow = {
  areaCode: "D11",
  clientCode: "2678",
  clientName: "الفرسان انترناشول جروب بنها",
  distributorCode: "QM",
  isDirect: false,
  officialLine: "Pedia",
  productCode: "LA001",
  qty: 600,
};

const row = (over: Partial<SplitPlanSourceRow> = {}): SplitPlanSourceRow => ({ ...base, ...over });

export function runImportSplitPreviewTests() {
  // ── The period gate is reported, not left to be inferred from an empty list ───────────────────
  // JUNE, not July: the gate moved to 2026-07 on the owner's "FIX JULY" ruling (2026-10-02), so June
  // is now the newest month that predates the split. The assertion is about the plan SAYING SO
  // rather than returning a silently empty list, which is true of whichever month is before the gate.
  const june = buildImportSplitPlan({ period: "2026-06", rows: [row()] });
  assert.equal(june.splitActive, false, "June predates the split — the plan says so explicitly");
  assert.equal(june.splittingCustomers, 0);
  assert.equal(june.customers[0].willSplit, false);
  assert.match(
    june.customers[0].reason ?? "",
    /does not apply to 2026-06/,
    "and the reason names the period rather than blaming the customer",
  );
  // And July is on the other side of the gate now — the same file imported for July DOES split.
  const julySinceTheRuling = buildImportSplitPlan({ period: "2026-07", rows: [row()] });
  assert.equal(
    julySinceTheRuling.splitActive,
    true,
    "July splits since 'FIX JULY', so an import preview for it must show the distribution, not a gate notice",
  );

  // ── El Qema, 600 packs from Benha: step 2, then the صعيد pass ─────────────────────────────
  //
  // Half stays with Qalubeya + Cairo, half crosses the country, and the redistribution then takes
  // Upper Egypt's share of that half back out again. The preview must report the shares AFTER that.
  const sept = buildImportSplitPlan({ period: "2026-09", rows: [row()] });
  assert.equal(sept.splitActive, true);
  const forsan = sept.customers[0];
  const forsanMeans = blockMeans("D11", 600);
  assert.equal(forsan.willSplit, true);
  assert.equal(forsan.nationalSplit, true, "600 packs is over 200, so there IS an away block");
  assert.equal(
    forsan.group,
    "Qalubeya + Cairo + nationwide, Upper Egypt redistributed",
    "and the city column names both rules that moved the money",
  );
  assert.equal(forsan.targetAreas.length, COUNTRY_AREAS, "every area in the country receives something");
  assert.ok(forsan.targetAreas.includes("D11"), "Qalubeya keeps a share of its own sale");
  assert.ok(forsan.targetAreas.includes("AB1"), "and Alexandria takes one of the national half");
  assert.ok(
    near(forsan.unitsPerArea, forsanMeans.home),
    `one area of Qalubeya + Cairo takes ${forsanMeans.home}, got ${forsan.unitsPerArea}`,
  );
  assert.ok(
    near(forsan.unitsPerAwayArea, forsanMeans.away),
    `one area outside it takes ${forsanMeans.away} on average, got ${forsan.unitsPerAwayArea}`,
  );
  assert.ok(
    forsan.unitsPerArea > forsan.unitsPerAwayArea,
    "and the governorate half is real — home beats away",
  );
  // 🔴 THE ASSERTION THAT CATCHES A PREVIEW READING `homeFraction` ALONE. Half of 600 over the
  // seven-area block is exactly 50; the صعيد pass then adds the national top-up, so anything that
  // reports a flat 50 here has skipped the redistribution the closing will perform.
  assert.notEqual(
    Number(forsan.unitsPerArea.toFixed(6)),
    Number((300 / QALUBEYA_BLOCK.length).toFixed(6)),
    "the preview reports the plan's shares, not the band's fraction",
  );
  assert.equal(sept.widestFanOut, COUNTRY_AREAS, "the headline reports the widest reach in the file");

  // ── 🔴 AN UPPER EGYPT WAREHOUSE REACHES THE COUNTRY IN EVERY BAND, THE FIRST INCLUDED ────────
  //
  // Sohag's 960 packs are step 2, so half stays in Sohag's two areas before the صعيد pass takes it
  // back out. Beni Suef's 120 packs are step 1, which on its own would keep the whole sale inside a
  // ONE-AREA governorate and report "nothing to divide across" — and it used to. The second rule
  // takes it national anyway: "كل البيع اللي محسوب للصعيد", all of it, whatever band produced it.
  const mixed = buildImportSplitPlan({
    period: "2026-09",
    rows: [
      row({ areaCode: "UE5", clientCode: "3040", clientName: "بدر فارم سوهاج", qty: 960 }),
      row({ areaCode: "UE9", clientCode: "1099", clientName: "دار الادويه للتوكيلات الطبيه", qty: 120 }),
    ],
  });
  const sohag = mixed.customers.find((c) => c.clientCode === "3040");
  assert.equal(sohag?.targetAreas.length, COUNTRY_AREAS, "960 packs reaches every area");
  assert.equal(sohag?.nationalSplit, true, "step 2 gives it a real away block");
  assert.match(
    sohag?.group ?? "",
    /Upper Egypt redistributed$/,
    "and the city column says the صعيد pass touched it",
  );

  const beniSuef = mixed.customers.find((c) => c.clientCode === "1099");
  assert.equal(beniSuef?.willSplit, true, "120 packs splits too, through the صعيد pass");
  assert.equal(beniSuef?.targetAreas.length, COUNTRY_AREAS, "and it reaches every area as well");

  // A one-area governorate OUTSIDE Upper Egypt under 200 is the control: it still stays whole, so
  // the case above is the redistribution and not a threshold quietly going missing again.
  const smallQalubeya = buildImportSplitPlan({
    period: "2026-09",
    rows: [row({ clientCode: "SMALL-D11", qty: 120 })],
  });
  assert.equal(
    smallQalubeya.customers[0].nationalSplit,
    false,
    "120 packs from Benha stays in Qalubeya + Cairo — step 1, and nothing redistributes it",
  );
  assert.equal(
    smallQalubeya.customers[0].targetAreas.length,
    QALUBEYA_BLOCK.length,
    "reaching its own block and no further",
  );

  // ── 🔴 THE BASKET IS NOT THE PRODUCT, AND THIS IS THE SHARPEST ASSERTION IN THE FILE ─────────
  //
  // Three products of 100 packs is a 300-pack basket and NOT one 300-pack product. Reading the
  // basket total would promise a nationwide fan-out the closing never performs, because the band is
  // judged per product. Benha is used because it is outside Upper Egypt, so nothing else can carry
  // this row across the country and the assertion cannot pass for the wrong reason.
  const basket = buildImportSplitPlan({
    period: "2026-09",
    rows: [
      row({ productCode: "LA001", qty: 100 }),
      row({ productCode: "LA002", qty: 100 }),
      row({ productCode: "LA003", qty: 100 }),
    ],
  });
  assert.equal(basket.customers[0].units, 300, "the customer bought 300 packs in total");
  assert.equal(basket.customers[0].nationalSplit, false, "but no product of it crossed 200");
  assert.equal(
    basket.customers[0].targetAreas.length,
    QALUBEYA_BLOCK.length,
    "so it reaches its own block only, never the country",
  );

  // The same 300 packs in ONE product does cross, which is what makes the assertion above mean
  // something rather than passing because nothing splits.
  const oneProduct = buildImportSplitPlan({
    period: "2026-09",
    rows: [row({ productCode: "LA001", qty: 300 })],
  });
  assert.equal(oneProduct.customers[0].nationalSplit, true, "300 packs of ONE product is over 200");
  assert.equal(oneProduct.customers[0].targetAreas.length, COUNTRY_AREAS, "and reaches the country");

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
    3,
    "the Alexandria leg is 150 packs — step 1, so it stays inside Alexandria's three areas",
  );
  assert.equal(
    Number((alex?.unitsPerArea ?? 0).toFixed(6)),
    Number((150 / 3).toFixed(6)),
    "50 each, and NOT pooled with the Sohag leg — two placements, two plans",
  );
  const sohagLeg = twoAreas.customers.find((c) => c.originArea === "UE5");
  assert.equal(
    sohagLeg?.targetAreas.length,
    COUNTRY_AREAS,
    "while the Sohag leg reaches the country, because Sohag is Upper Egypt",
  );

  // ── Rows for one customer, one area and one product are summed before the plan is drawn ───────
  //
  // Two 300-pack lines are ONE 600-pack product, which is step 2. Judged line by line each would
  // be step 1 and the preview would report a sale that never leaves Qalubeya + Cairo.
  const summed = buildImportSplitPlan({
    period: "2026-09",
    rows: [row({ qty: 300 }), row({ qty: 300 })],
  });
  assert.equal(summed.customers.length, 1, "two invoice lines, one customer, one placement");
  assert.equal(summed.customers[0].units, 600);
  assert.ok(
    near(summed.customers[0].unitsPerArea, forsanMeans.home),
    "and the band is judged on the summed 600, not on either 300 line alone",
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
