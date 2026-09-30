import assert from "node:assert/strict";

import {
  buildFrozenNetFromRows,
  synthesizeFrozenMovements,
  type FrozenNetRow,
} from "../src/lib/sales/closing-store-split-net.ts";
import {
  areaProductKey,
  netStoreSplitByAreaProduct,
  summariseStoreSplitByArea,
} from "../src/lib/sales/store-sales-city-split.ts";

// A PUBLISHED month is frozen (owner, 2026-09-27; 2026-09-30 "show the frozen published number").
// The attribution engine already reads the frozen au.monthly_store_split_net, but the Closing tab
// recomputed the split live and drifted off the announced number. loadClosingStoreSplitNet now reads
// the SAME frozen net for a published month, valued exactly as au.f_monthly_attribution values it, so
// the tab equals the keycard. This pins that valuation.
//
// Load-bearing case, 2026-08 Anti Infective / Menoufia 2 (D13) / Saginko (SA001): frozen net
// net_qty 135, net_effective_units 135, factory price 111.15 -> {qty:135, value:15,005.25}. Applied to
// base 145 that gives indirect 280 = the announced 84%, not the drifted live 290 / 85.5%.

const PRICE = { SA001_AUG: 111.15, SA001_OCT: 170.52 };

export function runClosingFrozenSplitNetTests() {
  const key = (area: string, product: string) => areaProductKey(area, product);

  // 1. THE ANNOUNCED CASE. net_qty -> qty, net_effective_units * price -> value.
  {
    const rows: FrozenNetRow[] = [
      { line_code: "anti_infective", area_code: "D13", product_code: "SA001", net_qty: 135, net_effective_units: 135 },
    ];
    const net = buildFrozenNetFromRows(rows, "anti_infective", "2026-08", () => PRICE.SA001_AUG);
    const cell = net.get(key("D13", "SA001"));
    assert.equal(cell?.qty, 135, "units carry net_qty");
    assert.ok(cell && Math.abs(cell.value - 15005.25) < 1e-6, `value = effective_units * price (${cell?.value})`);
  }

  // 2. LINE FILTER. Only the requested line's rows contribute.
  {
    const rows: FrozenNetRow[] = [
      { line_code: "anti_infective", area_code: "D13", product_code: "SA001", net_qty: 135, net_effective_units: 135 },
      { line_code: "cns", area_code: "D13", product_code: "SA001", net_qty: 999, net_effective_units: 999 },
    ];
    const net = buildFrozenNetFromRows(rows, "anti_infective", "2026-08", () => PRICE.SA001_AUG);
    assert.equal(net.size, 1, "the CNS row is excluded when the line is anti_infective");
    assert.equal(net.get(key("D13", "SA001"))?.qty, 135);
  }

  // 3. PERIOD PRICE. The value uses the PERIOD price, not the master, so a repriced product (Saginko
  //    from 2026-10) is valued correctly and matches au.f_monthly_attribution.
  {
    const rows: FrozenNetRow[] = [
      { line_code: "anti_infective", area_code: "D13", product_code: "SA001", net_qty: 10, net_effective_units: 10 },
    ];
    const oct = buildFrozenNetFromRows(rows, "anti_infective", "2026-10", () => PRICE.SA001_OCT);
    assert.ok(Math.abs((oct.get(key("D13", "SA001"))?.value ?? 0) - 10 * 170.52) < 1e-6, "October value uses 170.52");
    const aug = buildFrozenNetFromRows(rows, "anti_infective", "2026-08", () => PRICE.SA001_AUG);
    assert.ok(Math.abs((aug.get(key("D13", "SA001"))?.value ?? 0) - 10 * 111.15) < 1e-6, "August value uses 111.15");
  }

  // 4. BONUS. Value is priced on effective (paid) units, units carry qty (bonus included).
  {
    const rows: FrozenNetRow[] = [
      { line_code: "anti_infective", area_code: "D13", product_code: "SA001", net_qty: 20, net_effective_units: 10 },
    ];
    const net = buildFrozenNetFromRows(rows, "anti_infective", "2026-08", () => PRICE.SA001_AUG);
    const cell = net.get(key("D13", "SA001"));
    assert.equal(cell?.qty, 20, "units carry net_qty including bonus");
    assert.ok(cell && Math.abs(cell.value - 10 * PRICE.SA001_AUG) < 1e-6, "value prices only effective units");
  }

  // 5. A NULL PRICE NEVER NaNs A VALUE.
  {
    const rows: FrozenNetRow[] = [
      { line_code: "anti_infective", area_code: "D13", product_code: "ZZ999", net_qty: 5, net_effective_units: 5 },
    ];
    const net = buildFrozenNetFromRows(rows, "anti_infective", "2026-08", () => null);
    assert.equal(net.get(key("D13", "ZZ999"))?.value, 0, "no price -> value 0, never NaN");
  }

  // 6. SYNTHESIZED MOVEMENTS REPRODUCE THE NET EXACTLY. The export's Channel Breakdown folds
  //    netByArea from movements while the Matrix reads net — they must describe the SAME movement, so
  //    netStoreSplitByAreaProduct(synthesized) must round-trip back to the frozen net.
  {
    const net = new Map([
      [key("D13", "SA001"), { qty: 135, value: 15005.25 }], // a receiver
      [key("D12", "SA001"), { qty: -135, value: -15005.25 }], // a giver (net negative)
    ]);
    const movements = synthesizeFrozenMovements(net, "Anti Infective");
    const refolded = netStoreSplitByAreaProduct(movements);
    for (const [k, cell] of net) {
      assert.ok(Math.abs((refolded.get(k)?.qty ?? 0) - cell.qty) < 1e-9, `qty round-trips for ${k}`);
      assert.ok(Math.abs((refolded.get(k)?.value ?? 0) - cell.value) < 1e-6, `value round-trips for ${k}`);
    }
    const receiver = movements.find((m) => m.areaCode === "D13");
    assert.equal(receiver?.inQty, 135, "a positive net collapses to an IN leg");
    assert.equal(receiver?.outQty, 0);
    const giver = movements.find((m) => m.areaCode === "D12");
    assert.equal(giver?.outQty, 135, "a negative net collapses to an OUT leg");
    assert.equal(giver?.inQty, 0);
    assert.equal(giver?.line, "Anti Infective", "movements carry the exported line");
  }

  // 7. THE SUMMARY SHEET USES THE FROZEN MOVEMENTS OVERRIDE. When movementsOverride is passed,
  //    summariseStoreSplitByArea folds THOSE (the frozen split) instead of recomputing from rows —
  //    so the export's Store Split summary net ties to the frozen Matrix. `before` still comes from
  //    the rows. Proven by passing a NON-store row (which alone recomputes to no split at all).
  {
    const rows = [
      {
        areaCode: "D13",
        clientCode: "C1",
        clientName: "Pharmacy X", // a pharmacy, never split — live recompute would yield nothing
        includedInClosing: true,
        isDirect: false,
        qty: 100,
        salesValue: 11115,
        officialLine: "Anti Infective",
        areaName: "Menoufia 2",
      },
    ] as unknown as Parameters<typeof summariseStoreSplitByArea>[0];

    // Without an override, a pharmacy-only month splits nothing.
    assert.equal(summariseStoreSplitByArea(rows, "2026-08").length, 0, "no store rows -> no live split");

    // With the frozen movements override, the summary is produced from THEM.
    const override = synthesizeFrozenMovements(
      new Map([[areaProductKey("D13", "SA001"), { qty: 135, value: 15005.25 }]]),
      "Anti Infective",
    );
    const summary = summariseStoreSplitByArea(rows, "2026-08", undefined, override);
    assert.equal(summary.length, 1, "the override drives the summary even with no store rows");
    const d13 = summary[0];
    assert.equal(d13.netQty, 135, "net comes from the frozen override");
    assert.ok(Math.abs(d13.netValue - 15005.25) < 1e-6, "net value comes from the frozen override");
    assert.ok(Math.abs(d13.beforeValue - 11115) < 1e-6, "before still comes from the rows");
    assert.ok(Math.abs(d13.afterValue - (11115 + 15005.25)) < 1e-6, "before + net = after reconciles");
  }
}
