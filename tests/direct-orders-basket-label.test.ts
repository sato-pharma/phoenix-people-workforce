import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { summarizeDirectOrderBasket } from "../src/lib/direct-orders/basket-label.ts";

// ─────────────────────────────────────────────────────────────────────────────
// "The total is calculated, but showing one product."
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
// WHY IT HAPPENED. A direct order used to be one product, so the request's singular columns WERE
// the order. Baskets made those columns line 1 only, while `sales_value` stayed the basket total
// (collection's remaining_amount derives from it and must never under-count). `getDirectOrderReport`
// was fixed for its own columns; the five LIST surfaces were not.
//
// This file guards three things:
//   · ONE DEFINITION — the join/sum rule lives in basket-label.ts, not copied per surface.
//   · A ONE-PRODUCT ORDER IS UNTOUCHED — the report's 39 columns are positional twins read by the
//     owner's Google Sheet every 60 seconds, so this refactor must not move a single one of them.
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
    assert.equal(basket.qty, 96, "quantity must be SUMMED across the basket: 72 + 24");
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
  // live; if this refactor changed a single-line order at all, it would shift the owner's formulas.
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
    }
  }

  // ── 4. Three or more products still compose ─────────────────────────────────────────────
  {
    const three = summarizeDirectOrderBasket(HEAD, [
      ...REAL_BASKET,
      { productCode: "LA003", productName: "Lacto Advanced 3", qty: 10 },
    ]);
    assert.equal(three.productName, "Lacto Advanced 1 + Lacto Advanced 2 + Lacto Advanced 3");
    assert.equal(three.qty, 106, "72 + 24 + 10");
  }

  // ── 5. The rule has ONE home ────────────────────────────────────────────────────────────
  // Before this fix, getDirectOrderReport carried the join inline and four other surfaces carried
  // nothing. If a surface goes back to composing names itself, this catches it.
  {
    const service = read("../src/lib/direct-orders/service.ts");
    assert.ok(
      !/isBasket \? items\.map\(\(item\) => item\.productName\)\.join\(" \+ "\)/.test(service),
      "the inline join must be gone from service.ts — basket-label.ts is the single definition",
    );

    const callSites = service.match(/summarizeDirectOrderBasket\(/g) ?? [];
    assert.ok(
      callSites.length >= 5,
      `every list surface must read the shared rule; found ${callSites.length} call sites, expected at least 5 ` +
        "(report, approvals list, Orders list, Held Desk, approval-exception desk)",
    );
  }

  // ── 6. The lists actually LOAD the items they now name ───────────────────────────────────
  // The helper degrades to single-product output when items are absent, which is correct but would
  // make the fix invisible if a caller forgot the read. Pin the four that were added.
  {
    const service = read("../src/lib/direct-orders/service.ts");
    const loads = service.match(/loadDirectOrderItemsForRequests\(/g) ?? [];
    assert.ok(
      loads.length >= 6,
      `each list path needs its own batched item read; found ${loads.length} uses, expected at least 6 ` +
        "(the declaration, the cleanup pass, the report, workspace data, listMyDirectOrders, " +
        "decorateDirectOrderPage, the Held Desk and the exception desk)",
    );
  }

  // ── 7. The card renders PER PRODUCT, and never with an ellipsis ─────────────────────────
  {
    const workspace = read("../src/components/direct-orders/workspace/direct-orders-workspace.tsx");
    assert.ok(
      /\(row\.items \?\? \[/.test(workspace),
      "OrderRow must render from row.items so every product in a basket gets its own line",
    );
    assert.ok(
      !/\{row\.productName\} × \{row\.qty\.toLocaleString\("en-US"\)\}/.test(workspace),
      "OrderRow must no longer print the request's single productName against the basket's value",
    );
    assert.ok(
      /item\.productName\} × \{item\.qty\.toLocaleString\("en-US"\)/.test(workspace),
      "each rendered line must pair a product with ITS OWN quantity, not the basket total",
    );
  }
}
