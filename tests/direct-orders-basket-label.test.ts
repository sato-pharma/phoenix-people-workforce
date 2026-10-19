import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  describeDirectOrderBasketQuantities,
  describeDirectOrderBasketUnits,
  joinDirectOrderBasketUnits,
  summarizeDirectOrderBasket,
} from "../src/lib/direct-orders/basket-label.ts";
import { buildDirectOrderNeedsAction, type DirectOrderQueueRow } from "../src/lib/direct-orders/needs-action.ts";
import {
  DIRECT_ORDER_REPORT_COLUMNS,
  directOrderReportColumnIndex,
  directOrderReportRowCells,
  summariseDirectOrderReport,
} from "../src/lib/direct-orders/report-columns.ts";
import type { DirectOrderReportRow } from "../src/lib/direct-orders/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// "The total is calculated, but showing one product." — and then "96 of what?"
//
// THE LIVE CASE (production, 2026-08-13, reported by the owner from the portal's Recent orders
// card). Taha Mohamed Taha Elsayed AboElftouh's approved order 491063eb on بسمة – المنوات, Giza:
//
//     direct_order_requests.product_name = "Lacto Advanced 1"   qty = 72
//     direct_order_request_items         = LA001 × 72 = 19,008.00
//                                          LA002 × 24 =  6,336.00
//     direct_order_requests.sales_value  = 25,344.00
//
// The card rendered "Lacto Advanced 1 × 72" beside "25,344 EGP". Nothing was miscalculated — the
// money is right, 19,008 + 6,336 — but the NAME is line 1 while the VALUE is the whole basket. A
// reader cannot see what the total is for, and an approver signing that row is approving money they
// cannot see.
//
// The first fix named every product and SUMMED the units, so the same order read "Lacto Advanced 1 +
// Lacto Advanced 2 × 96". That breaks a standing owner rule: units of different products or
// concentrations are NEVER added together — a unit total is valid for one product code only
// (`units-of-different-products-are-never-added`). 96 is a number of nothing that exists.
//
// WHY IT HAPPENED. A direct order used to be one product, so the request's singular columns WERE
// the order. Baskets made those columns line 1 only, while `sales_value` stayed the basket total
// (collection's remaining_amount derives from it and must never under-count). `getDirectOrderReport`
// was fixed for its own columns; the LIST surfaces were not.
//
// This file guards:
//   · ONE DEFINITION — the join rule lives in basket-label.ts, not copied per surface.
//   · A BASKET HAS NO SINGLE QUANTITY — `qty` is null, every surface prints each product's own units,
//     and no list, desk, inbox, email or report cell adds them.
//   · A ONE-PRODUCT ORDER IS UNTOUCHED — the report's columns are positional twins read by the
//     owner's Google Sheet every 60 seconds, so a single-line order must not move a single cell.
//   · THE REPORT KEEPS ITS COLUMNS — a basket's Qty and Bonus cells become per-product text
//     ("72 + 24") in the SAME positions (owner, 2026-10-19: "Per product as text").
//   · THE CARD NAMES EVERY PRODUCT — and does it without an ellipsis, which is a standing owner
//     rule. Joining names into one string would have been longer than the row and truncated.
// ─────────────────────────────────────────────────────────────────────────────

const HEAD = { productCode: "LA001", productName: "Lacto Advanced 1", qty: 72 };

const REAL_BASKET = [
  { productCode: "LA001", productName: "Lacto Advanced 1", qty: 72 },
  { productCode: "LA002", productName: "Lacto Advanced 2", qty: 24 },
];

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function reportRow(overrides: Partial<DirectOrderReportRow> = {}): DirectOrderReportRow {
  return {
    id: "req-1",
    status: "approved",
    productCode: "LA001",
    productName: "Lacto Advanced 1",
    qty: 72,
    bonus: 0,
    basketUnits: null,
    salesValue: 19_008,
    ...overrides,
  } as DirectOrderReportRow;
}

function queueRow(overrides: Partial<DirectOrderQueueRow> = {}): DirectOrderQueueRow {
  return {
    id: "req-1",
    requesterName: "Taha",
    productName: "Lacto Advanced 1",
    qty: 72,
    pharmacyName: "Basma",
    areaName: "Giza",
    regionName: "Cairo",
    salesValue: 19_008,
    createdAt: "2026-08-13T09:00:00.000Z",
    status: "pending_approval",
    salesMonth: null,
    bonusOverCap: false,
    ...overrides,
  };
}

export function runDirectOrdersBasketLabelTests(): void {
  // ── 1. The exact production order that was reported ──────────────────────────────────────
  {
    const basket = summarizeDirectOrderBasket(HEAD, REAL_BASKET);
    assert.equal(
      basket.productName,
      "Lacto Advanced 1 + Lacto Advanced 2",
      "a basket must name EVERY product it charged for — naming line 1 only is the reported bug",
    );
    assert.equal(basket.productCode, "LA001 + LA002", "codes compose the same way names do");
    assert.equal(
      basket.qty,
      null,
      "a basket has NO single quantity: 72 + 24 = 96 adds a Lacto Advanced 1 pack to a Lacto Advanced 2 pack",
    );
    assert.equal(basket.isBasket, true);
    assert.equal(basket.lines.length, 2, "both lines must survive for a per-product renderer");
    assert.deepEqual(
      basket.lines.map((line) => `${line.productName} x${line.qty}`),
      ["Lacto Advanced 1 x72", "Lacto Advanced 2 x24"],
      "line order and quantities must be preserved exactly, not merged or re-sorted",
    );
  }

  // ── 2. A ONE-PRODUCT order must render byte-identically to before ────────────────────────
  // This is the Google Sheet guard. getDirectOrderReport's columns are positional and consumed
  // live; if this change moved a single-line order at all, it would shift the owner's formulas.
  {
    const single = summarizeDirectOrderBasket(HEAD, [
      { productCode: "LA001", productName: "Lacto Advanced 1", qty: 72 },
    ]);
    assert.equal(single.productName, "Lacto Advanced 1", "one product keeps its own plain name");
    assert.equal(single.productCode, "LA001");
    assert.equal(single.qty, 72, "one product keeps its own quantity — never re-derived");
    assert.equal(single.isBasket, false);
    assert.equal(single.lines.length, 1);
  }

  // A one-line order whose item row disagrees with the request columns still reports the REQUEST's
  // columns. They cannot disagree in practice (submitDirectOrder writes them from lines[0]), and
  // preferring the item row here would silently change report output for a case nobody reviewed.
  {
    const skewed = summarizeDirectOrderBasket(HEAD, [
      { productCode: "ZZ999", productName: "Something Else", qty: 5 },
    ]);
    assert.equal(skewed.productName, "Lacto Advanced 1", "a single line never overrides the request");
    assert.equal(skewed.qty, 72);
  }

  // ── 3. `lines` is ALWAYS populated, so no renderer has to branch ─────────────────────────
  {
    for (const items of [undefined, null, []]) {
      const basket = summarizeDirectOrderBasket(HEAD, items);
      assert.equal(basket.lines.length, 1, "a caller that loaded no items still gets one line");
      assert.equal(basket.lines[0]?.productName, "Lacto Advanced 1");
      assert.equal(basket.lines[0]?.qty, 72);
      assert.equal(basket.isBasket, false);
      assert.equal(basket.productName, "Lacto Advanced 1", "no items means the old output, exactly");
      assert.equal(basket.qty, 72, "no items means the old quantity, exactly");
    }
  }

  // ── 4. Three or more products still compose, each with its own units ────────────────────
  {
    const three = summarizeDirectOrderBasket(HEAD, [
      ...REAL_BASKET,
      { productCode: "LA003", productName: "Lacto Advanced 3", qty: 10 },
    ]);
    assert.equal(three.productName, "Lacto Advanced 1 + Lacto Advanced 2 + Lacto Advanced 3");
    assert.equal(three.qty, null, "still no single quantity at three products — 106 would be a made-up number");
    assert.deepEqual(
      three.lines.map((line) => line.qty),
      [72, 24, 10],
    );
  }

  // ── 5. The on-screen label: every product with ITS OWN units, never a sum ───────────────
  {
    assert.equal(
      describeDirectOrderBasketUnits({ productName: "Lacto Advanced 1 + Lacto Advanced 2", qty: null }, REAL_BASKET),
      "Lacto Advanced 1 × 72 + Lacto Advanced 2 × 24",
      "a basket reads one product × its own units, joined — the shape the approval window header uses",
    );
    assert.equal(
      describeDirectOrderBasketUnits({ productName: "Lacto Advanced 1", qty: 72 }, undefined),
      "Lacto Advanced 1 × 72",
      "a one-product order reads exactly as before: name × units",
    );
    assert.equal(
      describeDirectOrderBasketUnits(
        { productName: "Lacto Advanced 1", qty: 72 },
        [{ productName: "Lacto Advanced 1", qty: 72 }],
      ),
      "Lacto Advanced 1 × 72",
      "one item row is still a one-product order",
    );
    assert.equal(
      describeDirectOrderBasketUnits({ productName: "Royafloxacin", qty: 1234 }),
      "Royafloxacin × 1,234",
      "units are grouped the en-US way, as on the approval window",
    );
    assert.equal(
      describeDirectOrderBasketQuantities({ qty: null }, REAL_BASKET),
      "72 + 24",
      "the column beside a composed product name lists units per product in the same order",
    );
    assert.equal(describeDirectOrderBasketQuantities({ qty: 72 }, undefined), "72");
    assert.equal(joinDirectOrderBasketUnits([40, 0]), "40 + 0", "a bonus per product is joined, never added");
    assert.ok(
      !/96/.test(describeDirectOrderBasketUnits({ productName: "x", qty: null }, REAL_BASKET)),
      "the basket's label must never carry the sum of its units",
    );
  }

  // ── 6. The Needs Action inbox titles a basket per product, not "name × sum" ─────────────
  {
    const groups = buildDirectOrderNeedsAction({
      awaitingMyApproval: [
        queueRow({ id: "basket", productName: "Lacto Advanced 1 + Lacto Advanced 2", qty: null, items: REAL_BASKET, salesValue: 25_344 }),
        queueRow({ id: "single" }),
      ],
      myOrders: [],
      awaitingFinanceMonth: [],
      pendingCustomerValidations: 0,
      basePath: "/admin/direct-orders",
    });
    const titles = groups.flatMap((group) => group.items.map((item) => item.title));
    assert.ok(
      titles.includes("Taha · Lacto Advanced 1 × 72 + Lacto Advanced 2 × 24"),
      `a basket's inbox title must list each product's own units; got ${JSON.stringify(titles)}`,
    );
    assert.ok(
      titles.includes("Taha · Lacto Advanced 1 × 72"),
      "a one-product order's inbox title is unchanged",
    );
    assert.ok(!titles.some((title) => title.includes("96")), "no inbox title may carry a summed basket quantity");
  }

  // ── 7. THE REPORT keeps its columns; a basket's Qty and Bonus become per-product text ───
  {
    const qtyAt = directOrderReportColumnIndex("Qty (units)");
    const bonusAt = directOrderReportColumnIndex("Bonus (units)");
    assert.ok(qtyAt >= 0 && bonusAt === qtyAt + 1, "the Qty and Bonus columns must still sit where the sheet reads them");

    const single = reportRow();
    const singleCells = directOrderReportRowCells(single);
    assert.equal(singleCells[qtyAt], 72, "a one-product order keeps its NUMBER in Qty — the sheet sums it");
    assert.equal(singleCells[bonusAt], 0, "a one-product order keeps its NUMBER in Bonus");

    const basket = reportRow({
      productCode: "LA001 + LA002",
      productName: "Lacto Advanced 1 + Lacto Advanced 2",
      qty: null,
      bonus: null,
      basketUnits: { qty: "72 + 24", bonus: "0 + 0" },
      salesValue: 25_344,
    });
    const basketCells = directOrderReportRowCells(basket);
    assert.equal(basketCells.length, DIRECT_ORDER_REPORT_COLUMNS.length, "the basket row still has one cell per column");
    assert.equal(basketCells.length, singleCells.length, "no column was added or removed");
    assert.equal(basketCells[qtyAt], "72 + 24", "a basket's Qty cell lists each product's own units");
    assert.equal(basketCells[bonusAt], "0 + 0", "a basket's Bonus cell lists each product's own bonus");
    assert.notEqual(basketCells[qtyAt], 96, "the report must never print the summed 96");

    // The cover sheet's "Total units" and the sheet's unit totals add Qty down the column. A basket's
    // text cell is skipped by the sheet's SUM; the workbook total skips it the same way, so the two
    // can never quote different totals.
    const summary = summariseDirectOrderReport([single, basket, reportRow({ id: "req-2", qty: 10 })]);
    assert.equal(summary.totalUnits, 82, "totalUnits counts the single-product orders only: 72 + 10, never the basket's 96");
    assert.equal(summary.totalValue, 19_008 + 25_344 + 19_008, "money still includes the whole basket");
  }

  // ── 8. The rule has ONE home ────────────────────────────────────────────────────────────
  // Before this fix, getDirectOrderReport carried the join inline and four other surfaces carried
  // nothing. If a surface goes back to composing names itself, this catches it.
  {
    const service = read("../src/lib/direct-orders/service.ts");
    assert.ok(
      !/isBasket \? items\.map\(\(item\) => item\.productName\)\.join\(" \+ "\)/.test(service),
      "the inline join must be gone from service.ts — basket-label.ts is the single definition",
    );
    assert.ok(
      !/items\.reduce\(\(total, item\) => total \+ item\.(qty|bonus)/.test(service),
      "service.ts must never add a basket's units together",
    );

    const callSites = service.match(/summarizeDirectOrderBasket\(/g) ?? [];
    assert.ok(
      callSites.length >= 6,
      `every list surface must read the shared rule; found ${callSites.length} call sites, expected at least 6 ` +
        "(report, approvals list, Orders list, Held Desk, approval-exception desk, returned-order desk)",
    );
  }

  // ── 9. The lists actually LOAD the items they now name ───────────────────────────────────
  // The helper degrades to single-product output when items are absent, which is correct but would
  // make the fix invisible if a caller forgot the read. Pin the paths that were added.
  {
    const service = read("../src/lib/direct-orders/service.ts");
    const loads = service.match(/loadDirectOrderItemsForRequests\(/g) ?? [];
    assert.ok(
      loads.length >= 9,
      `each list path needs its own batched item read; found ${loads.length} uses, expected at least 9 ` +
        "(the declaration, the cleanup pass, the report, workspace data, listMyDirectOrders, " +
        "decorateDirectOrderPage, the Held Desk, the exception desk and the returned-order desk)",
    );
    const returnedDesk = service.slice(service.indexOf("export async function listReturnedDirectOrdersAgeing"));
    assert.ok(
      /loadDirectOrderItemsForRequests\(/.test(returnedDesk.slice(0, returnedDesk.indexOf("\nexport ", 10))),
      "the returned-order desk (and Stuck Approvals, which reads it) must load the order's lines",
    );
  }

  // ── 10. Every list SCREEN prints each product's own units, and none adds them ───────────
  {
    const workspace = read("../src/components/direct-orders/workspace/direct-orders-workspace.tsx");
    assert.ok(
      /orderRowLines\(row\)\.map/.test(workspace) && /row\.items \?\? \[/.test(workspace),
      "OrderRow must render from row.items so every product in a basket gets its own line",
    );
    assert.ok(
      !/\{row\.productName\} × \{row\.qty\.toLocaleString\("en-US"\)\}/.test(workspace),
      "OrderRow must no longer print the request's single productName against the basket's value",
    );
    assert.ok(
      /describeDirectOrderBasketUnits\(item\)/.test(workspace),
      "each rendered line must pair a product with ITS OWN quantity, not the basket total",
    );

    const surfaces: Array<[string, string]> = [
      ["the Held Desk", "../src/components/direct-orders/held-desk.tsx"],
      ["the approval-exceptions desk", "../src/components/direct-orders/approval-exceptions-desk.tsx"],
      ["the returned-ageing desk", "../src/components/direct-orders/returned-ageing-desk.tsx"],
      ["the Stuck Approvals panel", "../src/components/approvals-hub/stuck-approvals-panel.tsx"],
    ];
    for (const [name, path] of surfaces) {
      const source = read(path);
      assert.ok(
        /describeDirectOrderBasketUnits\(/.test(source),
        `${name} must print each product with its own units through the shared label`,
      );
      assert.ok(
        !/\{(row|order)\.productName\} × \{/.test(source),
        `${name} must not pair the composed product name with one quantity — a basket has no single quantity`,
      );
      assert.ok(
        !/\b(row|order)\.qty\b/.test(source),
        `${name} must not read the request's quantity at all — it is null on a basket`,
      );
    }
    // A basket's label is longer than a one-product header, so it WRAPS: `truncate` would hand the
    // second product straight to an ellipsis, which is the one thing that must never happen here.
    assert.ok(
      /break-words text-sm font-bold text-slate-900">\s*\{describeDirectOrderBasketUnits\(row, row\.items\)\}/.test(
        read("../src/components/direct-orders/approval-exceptions-desk.tsx"),
      ),
      "the exception desk's header must wrap a basket's label, never truncate it",
    );

    const submitForm = read("../src/components/direct-orders/direct-order-submit-form.tsx");
    assert.ok(
      /describeDirectOrderBasketQuantities\(r, r\.items\)/.test(submitForm),
      "My orders must list a basket's units per product",
    );
    assert.ok(
      !/\{r\.qty\.toLocaleString\("en-US"\)\}/.test(submitForm),
      "My orders must not print the request's quantity beside a composed product name",
    );

    const actionCenter = read("../src/lib/action-center/service.ts");
    assert.ok(
      /describeDirectOrderBasketQuantities\(row, row\.items\)/.test(actionCenter) && !/String\(row\.qty\)/.test(actionCenter),
      "Actions > My requests must list a basket's units per product; String(null) would print the word null",
    );
  }

  // ── 11. The report screens and the approval email read the per-product text ─────────────
  {
    const reportWorkspace = read("../src/components/direct-orders/direct-order-report-workspace.tsx");
    assert.ok(
      /r\.basketUnits\?\.qty \?\? units\(r\.qty\)/.test(reportWorkspace) && /r\.basketUnits\?\.bonus \?\? units\(r\.bonus\)/.test(reportWorkspace),
      "the on-screen report's Qty and Bonus columns must show a basket's per-product text",
    );
    const sharedView = read("../src/components/direct-orders/shared-report-view.tsx");
    assert.ok(/r\.basketUnits\?\.qty/.test(sharedView), "the shared read-only report must show a basket's per-product Qty");
    const email = read("../src/lib/direct-orders/approved-email.ts");
    assert.ok(
      /row\.basketUnits\?\.qty \?\? units\(row\.qty\)/.test(email) && /row\.basketUnits\?\.bonus \?\? units\(row\.bonus\)/.test(email),
      "the CEO approval email must state a basket's units per product, never a blank or a sum",
    );
  }
}
