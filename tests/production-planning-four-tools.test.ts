import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { perThousandBoxesToBase } from "../src/lib/production-planning/display-units.ts";
import { dataGapsFor } from "../src/lib/production-planning/gaps.ts";
import { moveStockRows } from "../src/lib/production-planning/stock.ts";
import {
  PRODUCTION_PLANNING_ERRORS,
  PRODUCTION_PLANNING_ERRORS_EN,
} from "../src/lib/production-planning/strings.ts";
import type { WireMaterial } from "../src/lib/production-planning/wire.ts";

/**
 * Production Planner — the four tools the owner chose on 2026-11-11, after one night needed each of
 * them done by hand:
 *
 *  1. **Move stock between stores.** Saginkgo's stock went partly to the factory and the rest to
 *     Sato's store, and there was no way to say so but two counted balances typed by hand.
 *  2. **Fix a wrong material.** 576.885 kg of Saginkgo's foil had been entered on Guamusin's sachet
 *     film, and moving it took direct SQL.
 *  3. **A missing-data warning.** Saginkgo's foil had no amount in production for eight days and
 *     Saginkgo had no stock at all, and both read as ordinary on every screen.
 *  4. **Enter it the way he says it.** "2.285 kg per 1,000 boxes, a box is 3 strips" had to be turned
 *     into 0.761667 g a strip by hand; units and strips per box had no edit anywhere.
 */
export function runProductionPlanningFourToolsTests() {
  // ── 1 and 2: the two rows of a move ──────────────────────────────────────────────────────────────
  const from = { asOfDate: "2026-11-03", qty: BigInt(576885) };
  const whole = moveStockRows({ asOfDate: "2026-11-11", from, qty: BigInt(576885), target: null });
  assert.deepEqual(
    whole,
    { from: { asOfDate: "2026-11-11", qty: BigInt(0) }, to: { asOfDate: "2026-11-11", qty: BigInt(576885) } },
    "moving a whole lot leaves the source at zero and the target with all of it",
  );
  const part = moveStockRows({
    asOfDate: "2026-11-11",
    from,
    qty: BigInt(100000),
    target: { asOfDate: "2026-11-05", qty: BigInt(230950) },
  });
  assert.deepEqual(
    part,
    { from: { asOfDate: "2026-11-11", qty: BigInt(476885) }, to: { asOfDate: "2026-11-11", qty: BigInt(330950) } },
    "a part move subtracts from the source and ADDS to what the target already holds",
  );
  // A back-dated move must not lose to the newer report it replaces: the load reads the newest date.
  const backDated = moveStockRows({
    asOfDate: "2026-11-01",
    from,
    qty: BigInt(1),
    target: { asOfDate: "2026-11-09", qty: BigInt(0) },
  });
  assert.equal(backDated?.from.asOfDate, "2026-11-09", "both rows are dated no earlier than the newest report on either lot");
  assert.equal(backDated?.to.asOfDate, "2026-11-09");
  assert.equal(
    moveStockRows({ asOfDate: "2026-11-11", from, qty: BigInt(576886), target: null }),
    null,
    "moving more than the lot holds is refused, never a negative in one place and invented stock in the other",
  );
  assert.equal(moveStockRows({ asOfDate: "2026-11-11", from, qty: BigInt(0), target: null }), null, "a zero move is refused");

  // ── 3: the missing-data warning ──────────────────────────────────────────────────────────────────
  const material = (over: Record<string, unknown>) =>
    ({
      id: "m",
      nameAr: "م",
      nameEn: "M",
      supplier: "sato",
      composition: {
        basis: "per_strip",
        qtyPerBasis: "0.761667",
        supplier: "sato",
        overagePct: null,
        effectiveFrom: "2026-11-03",
        notes: null,
      },
      heldByLocation: [
        { locationId: "SATO_STORE", lots: 1, newestAsOfDate: "2026-11-03", qty: "576885", qtyDisplay: "576.885" },
      ],
      ...over,
    }) as unknown as WireMaterial;
  const gaps = dataGapsFor([
    material({ id: "complete" }),
    material({ id: "no-amount", composition: null }),
    material({
      id: "no-stock",
      heldByLocation: [{ locationId: "SATO_STORE", lots: 1, newestAsOfDate: "2026-11-11", qty: "0", qtyDisplay: "0" }],
    }),
    material({ id: "both", composition: null, heldByLocation: [] }),
    material({ id: "factory", supplier: "factory", composition: null, heldByLocation: [] }),
  ]);
  assert.deepEqual(
    gaps.map((gap) => [gap.materialId, gap.missing]),
    [
      ["no-amount", ["amount"]],
      ["no-stock", ["stock"]],
      ["both", ["amount", "stock"]],
    ],
    "the warning names Sato's materials with no amount or no stock (a zero balance is no stock), and never a factory material",
  );

  // ── 4: per 1,000 boxes, the way the factory gives it ─────────────────────────────────────────────
  const kg = { basePerDisplay: "1000" };
  assert.equal(
    perThousandBoxesToBase({ basis: "per_strip", material: kg, stripsPerBox: "3", typed: "2.285", unitsPerBox: "30" }),
    "0.761667",
    "Saginkgo's foil: 2.285 kg per 1,000 boxes of 3 strips is 0.761667 g a strip, rounded UP as the migration did",
  );
  assert.equal(
    perThousandBoxesToBase({ basis: "per_box", material: kg, stripsPerBox: null, typed: "18", unitsPerBox: "30" }),
    "18",
    "Guamusin's film: 18 kg per 1,000 boxes is 18 g a box",
  );
  assert.equal(
    perThousandBoxesToBase({ basis: "per_packaging_set", material: kg, stripsPerBox: null, typed: "3", unitsPerBox: "30" }),
    "0.1",
    "a per-unit line divides by the units in a box",
  );
  assert.equal(
    perThousandBoxesToBase({ basis: "per_strip", material: kg, stripsPerBox: null, typed: "2.285", unitsPerBox: "30" }),
    null,
    "a per-strip conversion on a product with no strip count is refused, never divided by a guess",
  );
  assert.equal(
    perThousandBoxesToBase({ basis: "per_dose", material: kg, stripsPerBox: "3", typed: "2.285", unitsPerBox: "30" }),
    null,
    "a per-dose line is not a share of a box and is not offered",
  );
  assert.equal(
    perThousandBoxesToBase({ basis: "per_box", material: kg, stripsPerBox: null, typed: "abc", unitsPerBox: "30" }),
    null,
    "a figure that is not a number converts to nothing",
  );

  // ── The wiring: two routes, each registered, each a write behind the planner's own permission ────
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  for (const route of ["/api/production-planning/stock/move", "/api/production-planning/products"]) {
    const line = registry.split("\n").find((candidate) => candidate.includes(`pattern: "${route}"`));
    assert.ok(line, `${route} is in the access registry`);
    assert.match(line, /classification: "mutation"/, `${route} is registered as a mutation`);
    assert.match(line, /action: "update"/, `${route} needs production_planning update`);
    assert.match(line, /csrfRequired: true/, `${route} requires the same-origin check`);
  }
  const service = readFileSync("src/lib/production-planning/service.ts", "utf8");
  for (const fn of ["moveStock", "updateProductPackaging"]) {
    const start = service.indexOf(`export async function ${fn}(`);
    assert.ok(start >= 0, `${fn} exists`);
    const body = service.slice(start, service.indexOf("\nexport async function ", start + 10));
    assert.ok(body.indexOf("await assertWrite(access)") > 0, `${fn} checks write access first`);
    assert.ok(body.includes("writeRequiredAuditLog"), `${fn} refuses to act unrecorded`);
  }

  // Every new refusal reads as a sentence in both languages.
  const newRefusals = [
    "moveDestinationRequired",
    "moveQtyTooLarge",
    "moveUnitKindMismatch",
    "unitsPerBoxInvalid",
    "stripsPerBoxInvalid",
    "stripsInUse",
  ] as const;
  for (const key of newRefusals) {
    assert.ok(PRODUCTION_PLANNING_ERRORS[key].length > 0 && PRODUCTION_PLANNING_ERRORS_EN[key].length > 0, key);
  }
}
