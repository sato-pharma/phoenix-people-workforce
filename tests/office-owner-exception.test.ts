import assert from "node:assert/strict";

import { buildOfficeRespread, type OfficeRespreadRow } from "../src/lib/sales/closing-office-respread.ts";
import { OFFICE_DISTRIBUTOR_CODE } from "../src/lib/sales/office-distributor.ts";
import {
  OFFICE_OWNER_EXCEPTIONS,
  applyOfficeOwnerException,
  officeOwnerExceptionFor,
} from "../src/lib/sales/office-owner-exception.ts";

/**
 * THE OWNER'S CNS · OCTOBER 2026 OFFICE EXCEPTION (owner, 2026-11-11) — the five highest reps capped at
 * 123 / 121 / 119 / 117 / 115%, the 323,188.24 EGP freed lifting the twelve lowest to 47.6%.
 *
 *   1. The approved table sums to zero and names exactly the seventeen areas he approved.
 *   2. On CNS 2026-10 each area's Office VALUE moves by exactly its approved amount, against the same
 *      month spread by the bare rule — and every product total is unchanged.
 *   3. Every other month and line is the bare rule: September CNS and October Pedia move nothing.
 *   4. All or nothing: a taking area the rule gave no share leaves the rule's shares untouched.
 */

const PERIOD = "2026-10";
const OCTOBER = OFFICE_OWNER_EXCEPTIONS.find((entry) => entry.line === "CNS" && entry.period === PERIOD);

const AREAS = [
  // the seventeen in the table, plus three that are in neither list
  "UE4", "UE5", "CA1", "GZ5", "AB1",
  "CA3", "GZ2", "GZ7", "D25", "D23", "GZ4", "UE3", "GZ1", "D22", "D24", "D11", "UE1",
  "AB2", "D12", "UE6",
];

function row(overrides: Partial<OfficeRespreadRow>): OfficeRespreadRow {
  return {
    areaCode: "D12",
    clientCode: "C-1",
    clientName: "صيدلية",
    distributorCode: "IS",
    effectiveUnits: 0,
    includedInClosing: true,
    isDirect: false,
    officialLine: "CNS",
    productCode: "TE002",
    qty: 0,
    salesValue: 0,
    ...overrides,
  } as OfficeRespreadRow;
}

/** A month shaped like CNS October: every area sells, and Office is spread on the rule's shares. */
function monthRows(line: string): OfficeRespreadRow[] {
  const rows: OfficeRespreadRow[] = [];
  AREAS.forEach((areaCode, index) => {
    const value = 150_000 + index * 9_000;
    rows.push(row({ areaCode, clientCode: `C-${index}`, officialLine: line, qty: value / 100, effectiveUnits: value / 100, salesValue: value }));
  });
  const total = rows.reduce((sum, r) => sum + r.salesValue, 0);
  // Office: two products, 6.8M EGP in all, stamped on the rule's own shares (an aligned month).
  for (const [productCode, price, units] of [["TE002", 111.375, 40_254], ["TE003", 81, 26_004]] as const) {
    for (const base of [...rows]) {
      if (base.distributorCode === OFFICE_DISTRIBUTOR_CODE) continue;
      const share = base.salesValue / total;
      rows.push(row({
        areaCode: base.areaCode,
        clientCode: "",
        clientName: "",
        distributorCode: OFFICE_DISTRIBUTOR_CODE,
        officialLine: line,
        productCode,
        qty: units * share,
        effectiveUnits: units * share,
        salesValue: units * share * price,
      }));
    }
  }
  return rows;
}

function valueByArea(net: Map<string, { qty: number; value: number }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, cell] of net) {
    const areaCode = key.split("|")[0];
    out.set(areaCode, (out.get(areaCode) ?? 0) + cell.value);
  }
  return out;
}

export function runOfficeOwnerExceptionTests() {
  // 1. The table.
  {
    assert.ok(OCTOBER, "CNS 2026-10 carries the owner's exception");
    const moves = Object.entries(OCTOBER!.moves);
    assert.equal(moves.length, 17, "seventeen areas: five taken from, twelve given to");
    assert.equal(moves.filter(([, egp]) => egp < 0).length, 5, "five areas give");
    const total = moves.reduce((sum, [, egp]) => sum + egp, 0);
    assert.ok(Math.abs(total) < 0.005, `the moves sum to zero, got ${total}`);
    const given = moves.filter(([, egp]) => egp > 0).reduce((sum, [, egp]) => sum + egp, 0);
    assert.ok(Math.abs(given - 323_188.24) < 0.005, `323,188.24 EGP is moved, got ${given}`);
    assert.equal(officeOwnerExceptionFor("cns", "2026-10"), OCTOBER, "the line is matched folded");
  }

  // 2. October CNS moves each area by exactly its approved amount, and no product total moves.
  {
    const respread = buildOfficeRespread(monthRows("CNS"), PERIOD, "CNS");
    const byArea = valueByArea(respread.net);
    for (const areaCode of AREAS) {
      const approved: number = OCTOBER!.moves[areaCode] ?? 0;
      const moved: number = byArea.get(areaCode) ?? 0;
      assert.ok(
        Math.abs(moved - approved) < 0.05,
        `${areaCode}: Office value moved ${moved.toFixed(2)} EGP, approved ${approved.toFixed(2)}`,
      );
    }
    const perProduct = new Map<string, { qty: number; value: number }>();
    for (const [key, cell] of respread.net) {
      const product = key.split("|")[1];
      const held = perProduct.get(product) ?? { qty: 0, value: 0 };
      perProduct.set(product, { qty: held.qty + cell.qty, value: held.value + cell.value });
    }
    for (const [product, sum] of perProduct) {
      assert.ok(Math.abs(sum.qty) < 1e-4 && Math.abs(sum.value) < 1e-3, `${product} total unchanged: ${sum.qty} units, ${sum.value} EGP`);
    }
  }

  // 3. Every other month and line is the bare rule: an aligned month nets to zero.
  {
    for (const [line, period] of [["CNS", "2026-09"], ["CNS", "2026-11"], ["Pedia", "2026-10"]] as const) {
      const respread = buildOfficeRespread(monthRows(line), period, line);
      const moved = [...respread.net.values()].reduce((sum, cell) => sum + Math.abs(cell.value), 0);
      assert.ok(moved < 0.01, `${line} ${period} moves nothing, moved ${moved}`);
    }
  }

  // 4. All or nothing.
  {
    const shares = new Map([["D12", 0.5], ["AB2", 0.5]]);
    const result = applyOfficeOwnerException(shares, OCTOBER!, 6_818_392.35);
    assert.equal(result.applied, false, "a taking area with no share stops the whole exception");
    assert.deepEqual([...result.areaShare], [...shares], "and the rule's shares are returned untouched");
    assert.equal(applyOfficeOwnerException(shares, null, 1).applied, false, "no exception, no change");
  }
}
