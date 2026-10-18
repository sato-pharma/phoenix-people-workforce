import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { computeDiscountSalesValue } from "../src/lib/direct-orders/approval-flow.ts";
import { previewBasketValue, priceBasketLine } from "../src/lib/direct-orders/basket-value.ts";
import {
  MULTI_ITEM_FAMILY_CODES,
  familyAllowsMultipleItems,
  familyKey,
  selectableFamilyMembers,
  validateDirectOrderBasket,
} from "../src/lib/direct-orders/product-family.ts";
import { DIRECT_ORDER_REPORT_COLUMNS } from "../src/lib/direct-orders/report-columns.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * One request may carry several products — from ONE family, and only a family allowed to combine.
 *
 * THE ASK (owner, 2026-08-12): "in the same request make him able to choose lacto adv 1 and lacto
 * adv 2 but this only with lacto". So Lacto Advanced 1 + 2 may share a request; Tebofortin's seven
 * concentrations and Conviban's four may not, until somebody deliberately allows them.
 *
 * The rule is enforced in three places and each is asserted here or in the migration's own guard:
 * the DATABASE trigger (mixed families can never be stored), the SERVICE (via
 * resolveDirectOrderBasket), and the FORM (which offers only what the service accepts). The form
 * matters least for safety and most for not wasting a requester's time.
 */
export async function runDirectOrderFamilyBasketTests() {
  const LACTO_ADV_1 = { productCode: "LA001", productName: "Lacto Advanced 1", familyCode: "LA", line: "Pedia" };
  const LACTO_ADV_2 = { productCode: "LA002", productName: "Lacto Advanced 2", familyCode: "LA", line: "Pedia" };
  const LACTO_BASIC_1 = { productCode: "LA003", productName: "Lacto Basic 1", familyCode: "LA", line: "Head Office" };
  const LACTO_BASIC_2 = { productCode: "LA004", productName: "Lacto Basic 2", familyCode: "LA", line: "Head Office" };
  const TEBO_1 = { productCode: "TE001", productName: "Tebofotin drops", familyCode: "TE", line: "CNS" };
  const TEBO_2 = { productCode: "TE002", productName: "Tebofortine Forte 80", familyCode: "TE", line: "CNS" };
  const CATALOGUE = [LACTO_ADV_1, LACTO_ADV_2, LACTO_BASIC_1, LACTO_BASIC_2, TEBO_1, TEBO_2];

  // ── LACTO ONLY, and that is the whole policy ───────────────────────────────
  assert.deepEqual([...MULTI_ITEM_FAMILY_CODES], ["LA"], "only Lacto may combine today");
  assert.equal(familyAllowsMultipleItems("LA"), true);
  assert.equal(familyAllowsMultipleItems("la"), true, "case is not the caller's problem");
  assert.equal(
    familyAllowsMultipleItems("TE"),
    false,
    "Tebofortin has SEVEN concentrations and still may not combine — the owner said Lacto only, and " +
      "a family being multi-product is not the same as a family being allowed to share a request",
  );
  assert.equal(familyAllowsMultipleItems(""), false, "a missing family never combines");
  assert.equal(familyAllowsMultipleItems(null), false);

  // familyKey is what every comparison here goes through — one normalisation, so "LA" and "la"
  // cannot be two families in the database and one in the UI.
  assert.equal(familyKey(" la "), "LA");
  assert.equal(familyKey(null), "");

  // ── The offered members exclude confidential products, ALWAYS ──────────────
  //
  // Two independent mechanisms, neither subsuming the other: RESTRICTED_PRODUCT_CODES (LA003/LA004)
  // and the whole Head Office line. "The rest of this family" is exactly the shape of question that
  // once leaked a restricted product onto an SFE Manager's screen.
  const lacto = selectableFamilyMembers(CATALOGUE, "LA");
  assert.deepEqual(
    lacto.map((p) => p.productCode),
    ["LA001", "LA002"],
    "the Lacto family a requester can be offered is exactly the two Advanced concentrations",
  );
  for (const hidden of ["LA003", "LA004"]) {
    assert.ok(
      !lacto.some((p) => p.productCode === hidden),
      `${hidden} is confidential and must never be offered as a family member`,
    );
  }
  assert.deepEqual(selectableFamilyMembers(CATALOGUE, "").map((p) => p.productCode), [], "no family, no members");

  // ── The basket rule ────────────────────────────────────────────────────────
  const ok = (items: { productCode: string; familyCode: string }[]) => validateDirectOrderBasket(items).ok;
  const why = (items: { productCode: string; familyCode: string }[]) => {
    const verdict = validateDirectOrderBasket(items);
    return verdict.ok ? "" : verdict.message;
  };

  assert.equal(ok([LACTO_ADV_1]), true, "one product is always fine — that is every order ever raised");
  assert.equal(ok([TEBO_1]), true, "…including from a family that may not combine");
  assert.equal(ok([LACTO_ADV_1, LACTO_ADV_2]), true, "THE ASK: both Lacto concentrations on one order");

  assert.equal(ok([]), false, "an empty basket is not an order");
  assert.match(why([]), /at least one product/i);

  assert.equal(ok([LACTO_ADV_1, TEBO_1]), false, "mixing families is never allowed");
  assert.match(why([LACTO_ADV_1, TEBO_1]), /same family/i, "and the refusal says why, in words");

  assert.equal(ok([TEBO_1, TEBO_2]), false, "two Tebofortins are one family but NOT an allowed one");
  assert.match(why([TEBO_1, TEBO_2]), /one product per direct order/i);

  assert.equal(
    ok([LACTO_ADV_1, { ...LACTO_ADV_1 }]),
    false,
    "the same product twice is one line entered badly — summing it silently would hide a mistake in the money",
  );
  assert.match(why([LACTO_ADV_1, { ...LACTO_ADV_1 }]), /listed twice/i);
  assert.equal(
    ok([LACTO_ADV_1, { ...LACTO_ADV_1, productCode: "la001" }]),
    false,
    "…and case does not make it a different product",
  );

  // ── The form offers only what the service accepts ──────────────────────────
  //
  // Not by inspection but by CONSTRUCTION: the component imports the same two functions the service
  // validates with. A component carrying its own copy of the rule eventually offers a basket the
  // service refuses, and the requester is told no after filling the form in.
  const form = readFileSync(
    new URL("../src/components/direct-orders/direct-order-submit-form.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    form,
    /from "@\/lib\/direct-orders\/product-family"/,
    "the submit form must import the policy rather than re-deriving families from product names",
  );
  for (const fn of ["familyAllowsMultipleItems", "selectableFamilyMembers"]) {
    assert.match(form, new RegExp(`\\b${fn}\\b`), `the form must use ${fn}`);
  }
  const formCode = stripComments(form);
  assert.doesNotMatch(
    formCode,
    /"LA"|'LA'/,
    'the form must not hardcode "LA" — which families combine is one constant, so adding Tebofortin ' +
      "later is an entry in MULTI_ITEM_FAMILY_CODES and not a hunt through this component",
  );

  // Lines the form no longer shows must not be submitted. Changing the main product changes the
  // family, and a stale selection would send a line the requester cannot see.
  assert.match(
    formCode,
    /siblings\.some\(\(s\) => s\.productCode === code\)/,
    "only lines still offered may be submitted — a stale extra line is the worst kind of surprise on an order",
  );

  // ── The value on the form is the WHOLE order, not the main line ────────────
  //
  // Reported 2026-10-18: Lacto Advanced 1, 100 units at 25% showed 24,750 EGP; ticking Lacto Advanced
  // 2 with its own 100 units at 25% left the number at 24,750. The server stored the right total, so
  // only the preview was wrong — and a requester cannot tell whether a line was counted if the figure
  // never moves.
  const discountLine = (productCode: string, publicPrice: number | null, qty = 100, discountPct = 25) => ({
    productCode,
    productName: productCode,
    dealType: "discount" as const,
    qty,
    discountPct,
    publicPrice,
    pharmacyPrice: null,
  });

  const mainOnly = previewBasketValue([discountLine("LA001", 330)]);
  assert.equal(mainOnly.total, 24_750, "the one-line order is valued exactly as before: 100 × 330 × (1 − 25%)");
  assert.equal(
    mainOnly.total,
    computeDiscountSalesValue({ qty: 100, publicPrice: 330, discountPct: 25 }),
    "a single line goes through the same locked formula, not a copy of it",
  );

  const twoLines = previewBasketValue([discountLine("LA001", 330), discountLine("LA002", 300)]);
  assert.deepEqual(
    twoLines.lines.map((line) => line.salesValue),
    [24_750, 22_500],
    "each concentration contributes its own value — the second is 100 × 300 × (1 − 25%)",
  );
  assert.equal(twoLines.total, 47_250, "the total moves when a second concentration is added");
  assert.ok(twoLines.total > mainOnly.total, "adding a priced line can only raise the order value");

  const mixedDeals = previewBasketValue([
    discountLine("LA001", 330),
    { ...discountLine("LA002", null), dealType: "bonus" as const, qty: 40, pharmacyPrice: 200 },
  ]);
  assert.deepEqual(
    mixedDeals.lines.map((line) => line.salesValue),
    [24_750, 8_000],
    "a bonus line is valued qty × PHARMACY price and ignores the discount, beside a discount line on the public price",
  );
  assert.equal(mixedDeals.total, 32_750);

  const unpriced = priceBasketLine(discountLine("LA002", null));
  assert.equal(unpriced.salesValue, 0, "the server refuses a discount line with no public price, so it adds nothing");
  assert.equal(unpriced.basisPrice, null, "…and says so, so the form can name the missing price");
  assert.equal(priceBasketLine(discountLine("LA002", 0)).basisPrice, null, "a zero price is a missing price");
  assert.equal(
    priceBasketLine({ ...discountLine("LA002", 330), dealType: "bonus", pharmacyPrice: null }).basisPrice,
    null,
    "a bonus line never falls back to the public price",
  );

  assert.equal(priceBasketLine(discountLine("LA001", 330, 100.9)).qty, 100, "quantity is whole units, as on the server");
  assert.equal(
    priceBasketLine(discountLine("LA001", 330, 100, 140)).discountPct,
    100,
    "a discount is held at 100%, as on the server",
  );
  assert.equal(previewBasketValue([]).total, 0, "an empty basket is worth nothing");

  // The form must price through that function, with the extra lines fed in — not the main product
  // alone, which is the whole defect.
  assert.match(formCode, /previewBasketValue\(/, "the form's sales value must come from the basket pricing");
  assert.match(
    formCode,
    /\.\.\.activeExtras\.map\(/,
    "every extra line still on the order must be priced into the value shown",
  );
  assert.match(formCode, /const salesValue = basket\.total;/, "the figure shown is the whole-order total");
  assert.doesNotMatch(
    formCode,
    /computeDiscountSalesValue|computeDirectOrderSalesValue/,
    "the form must not price the main line by itself again — one line's value is not the order's value",
  );

  // ── The report tells the truth about a basket, and adds NO column ──────────
  //
  // The report columns are positional twins feeding the owner's Google Sheet every 60 seconds.
  // Inserting one would shift every later column and break live formulas, so the basket is carried
  // in the columns that already exist. The count itself is pinned by
  // tests/direct-orders-report-columns.test.ts — deliberately not re-asserted here, because two
  // copies of a number is how one of them ends up stale.
  assert.ok(DIRECT_ORDER_REPORT_COLUMNS.length > 0, "the report must still have columns");

  const service = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
  const reportStart = service.indexOf("export async function getDirectOrderReport");
  assert.ok(reportStart > 0, "getDirectOrderReport must still exist");
  const reportEnd = service.indexOf("\nexport ", reportStart + 1);
  const report = service.slice(reportStart, reportEnd > 0 ? reportEnd : undefined);

  // Guarded on MORE THAN ONE line, never on "has items". Every order raised before this feature
  // must come out of the report byte-identical, and that is only guaranteed if the single-line path
  // still reads the request's own columns rather than reconstructing them from the items table.
  assert.match(report, /const isBasket = items\.length > 1;/, "the basket path must be gated on a second line");

  // The composition itself was lifted into summarizeDirectOrderBasket (basket-label.ts) so the
  // report, the approvals list, the Orders list, the Held Desk and the exception desk share ONE
  // definition instead of a copy each — this test used to pin the ternary inline here and went stale
  // the moment that lift happened. basket-label.test.ts pins the actual one-line/basket composition
  // rule; this only checks the report reads it rather than re-deriving it.
  assert.match(
    report,
    /const basket = summarizeDirectOrderBasket\(request, items\);/,
    "the report must compose the basket label through the shared function, not a private copy of the rule",
  );
  for (const field of ["productCode", "productName", "qty"] as const) {
    assert.match(
      report,
      new RegExp(`${field}: basket\\.${field},`),
      `the report's ${field} must come from the shared basket summary, not a re-derived ternary`,
    );
  }

  // bonus is not part of DirectOrderBasketSummary — it still falls back to the request's own column
  // inline, exactly as before the lift.
  assert.match(
    report,
    /bonus: isBasket \? items\.reduce\(\(total, item\) => total \+ item\.bonus, 0\) : request\.bonus/,
    "the report's bonus must fall back to the request's own column for one line",
  );

  // Sales value is ALREADY the basket total. Summing the units is what makes the row internally
  // consistent — money and units describing the same set of products.
  assert.doesNotMatch(
    report,
    /salesValue: isBasket/,
    "sales value is stored as the basket total on the request, so the report must not re-sum it",
  );

  // ── The API route decides nothing ──────────────────────────────────────────
  const route = readFileSync(new URL("../app/api/direct-orders/submit/route.ts", import.meta.url), "utf8");
  const routeCode = stripComments(route);
  assert.match(routeCode, /items:/, "the route must forward items");
  assert.doesNotMatch(
    routeCode,
    /familyCode|validateDirectOrderBasket|MULTI_ITEM/,
    "the route must not re-check the family rule — a second copy is a second place for it to drift",
  );

  console.log(`  direct-orders family basket: Lacto only, ${lacto.length} selectable members, confidential excluded`);
  console.log("  direct-orders family basket: form imports the rule, route decides nothing");
}
