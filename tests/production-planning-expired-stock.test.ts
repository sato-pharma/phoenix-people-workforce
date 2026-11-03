import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { evaluateExpiry, isIsoDate, splitExpiredLots } from "../src/lib/production-planning/expiry.ts";
import { evaluateExpiryForProduct, type ProductionPlanningData } from "../src/lib/production-planning/service.ts";
import { expiryChangeRows } from "../src/lib/production-planning/stock.ts";

/**
 * Production Planner — what happens when an expiry date comes (owner, 2026-11-03).
 *
 * The quantity leaves stock by itself and goes to an Expired column, where it can still be read for
 * the accounts. The expiry date can be changed on a lot already in stock.
 *
 * What would go wrong quietly: an expired lot left in the held figure covers a batch it cannot go
 * into, so the buy list comes up short while every figure on the row looks ordinary. And a corrected
 * date entered as a new report opens a second lot, so the same material is counted twice.
 */

type Lot = { materialId: string; locationId: string; expiryDate: string | null; qty: bigint };

const lot = (expiryDate: string | null, qty: number, materialId = "m", locationId = "l"): Lot => ({
  expiryDate,
  locationId,
  materialId,
  qty: BigInt(qty),
});

/** The load's own rule: the newest row per lot, by date and then by which was written last. */
function standing(rows: { expiryDate: string | null; qty: bigint; asOfDate: string }[]) {
  const byLot = new Map<string, bigint>();
  const dates = new Map<string, string>();
  for (const row of rows) {
    const key = row.expiryDate ?? "";
    const seen = dates.get(key);
    if (seen !== undefined && seen > row.asOfDate) continue;
    dates.set(key, row.asOfDate);
    byLot.set(key, row.qty);
  }
  return byLot;
}

export function runProductionPlanningExpiredStockTests() {
  // ── The split ──────────────────────────────────────────────────────────────────────────────────
  const today = "2026-12-06";
  const { live, expired } = splitExpiredLots(
    [
      lot("2026-12-05", 1),
      lot("2026-12-06", 2),
      lot("2026-12-07", 3),
      lot(null, 4),
      lot("2026-01-01", 0),
      lot("2027-01-01", 0),
      lot(null, 0),
    ],
    today,
  );
  assert.deepEqual(
    expired.map((row) => row.qty),
    [BigInt(1), BigInt(2)],
    "a lot past its date and a lot ON its date have both expired, the day he said it moves",
  );
  assert.deepEqual(
    live.map((row) => row.qty),
    [BigInt(3), BigInt(4), BigInt(0)],
    "tomorrow's lot and packaging stay, an undated zero stays as a report, and a used-up dated lot is on neither side",
  );

  // ── Date validation ────────────────────────────────────────────────────────────────────────────
  assert.equal(isIsoDate("2027-04-27"), true);
  assert.equal(isIsoDate("2027-02-31"), false, "31 February is refused rather than rolled forward");
  assert.equal(isIsoDate("27/04/2027"), false);

  // ── Moving a lot to another date ───────────────────────────────────────────────────────────────
  const before = [{ asOfDate: "2026-04-19", expiryDate: null, qty: BigInt(131_000) }];
  const moved = expiryChangeRows({
    from: { asOfDate: "2026-04-19", qty: BigInt(131_000) },
    fromExpiryDate: null,
    target: null,
    toExpiryDate: "2026-12-06",
  });
  const after = standing([...before, ...moved]);
  assert.equal(after.get(""), BigInt(0), "the old lot closes at zero, or the material is counted twice");
  assert.equal(after.get("2026-12-06"), BigInt(131_000), "and the whole quantity stands on the new date");
  assert.equal(
    [...after.values()].reduce((sum, qty) => sum + qty, BigInt(0)),
    BigInt(131_000),
    "moving a date never changes how much there is",
  );

  const merged = expiryChangeRows({
    from: { asOfDate: "2026-04-19", qty: BigInt(100) },
    fromExpiryDate: "2027-01-01",
    target: { asOfDate: "2026-10-08", qty: BigInt(50) },
    toExpiryDate: "2028-01-01",
  });
  assert.deepEqual(
    merged[1],
    { asOfDate: "2026-10-08", expiryDate: "2028-01-01", qty: BigInt(150) },
    "a lot already on the new date is one balance, and the row must not be older than the report it replaces",
  );

  // ── An expired lot is off the buy list, and is announced once ──────────────────────────────────
  const material = {
    basePerDisplay: BigInt(1_000_000),
    code: "M",
    displayUnit: "kg",
    id: "m",
    nameAr: "م",
    nameEn: "M",
  };
  const base = {
    locations: [{ code: "F", id: "l", isFactory: true, nameAr: "ف", nameEn: "F" }],
    materialIdsByProductId: new Map([["p", new Set(["m"])]]),
    materials: [material],
    products: [{ factoryLocationId: "l", id: "p" }],
    settings: { expiryWarnDays: 180 },
  };
  const withLots = (stock: Lot[], expiredStock: Lot[]) =>
    ({ ...base, expiredStock, stock }) as unknown as ProductionPlanningData;
  const dying = lot("2026-12-06", 5);
  const verdicts = (data: ProductionPlanningData, on: string) => evaluateExpiryForProduct(data, "p", on);

  assert.equal(verdicts(withLots([], [dying]), "2026-12-06").length, 1, "the morning it expires, it is reported");
  assert.equal(verdicts(withLots([], [dying]), "2026-12-06")[0]?.severity, "expired");
  assert.equal(
    verdicts(withLots([], [dying]), "2026-12-07").length,
    0,
    "🔴 and from the next morning it is not, or the email repeats a written-off lot every day for ever",
  );
  assert.equal(
    evaluateExpiry(
      [{ code: "M", expiryDate: "2026-12-06", locationId: "l", materialId: "m", nameAr: "م", nameEn: "M", qty: BigInt(5) }],
      { today: "2026-12-06", warnDays: 180 },
    )[0]?.daysLeft,
    0,
    "the verdict itself is untouched",
  );

  // Every held figure comes from data.stock, so the split at the load is what moves the buy list.
  const service = readFileSync("src/lib/production-planning/service.ts", "utf8");
  assert.match(
    service,
    /const \{ live: stock, expired: expiredStock \} = splitExpiredLots\(lots, todayCairo\(\)\);/,
    "the load must split the lots, or an expired lot stays in every held figure",
  );

  // ── The route is declared, and writes through the permission check ─────────────────────────────
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(registry, /pattern: "\/api\/production-planning\/stock\/expiry", permission: \{ resource: "production_planning", action: "update" \}/);
  const writerStart = service.indexOf("export async function changeStockLotExpiry");
  assert.notEqual(writerStart, -1, "changeStockLotExpiry has moved or been renamed");
  const writer = service.slice(writerStart, service.indexOf("\n}\n", writerStart));
  assert.match(writer, /await assertWrite\(access\)/, "two of the five named people are read-only");
  assert.match(writer, /expiryChangeRows\(/, "the two rows come from the tested rule");
}
