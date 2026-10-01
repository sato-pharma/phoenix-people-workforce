import assert from "node:assert/strict";
import { diffStoreSplitNet, type StoreSplitNetCell } from "../src/lib/sales/store-split-drift.ts";

// The drift detector's whole reason to exist is that the EXISTING check cannot see this class of
// change: the split is unit-preserving, so a units-only comparison reads clean while the money has
// moved between areas. Every assertion below is built around that one fact.

const PRICE = 111.15;
const priceFor = (productCode: string): number | null => (productCode === "SA001" ? PRICE : 60.7);

function cell(
  lineCode: string,
  areaCode: string,
  productCode: string,
  netQty: number,
  netEffectiveUnits = netQty,
): StoreSplitNetCell {
  return { areaCode, lineCode, netEffectiveUnits, netQty, productCode };
}

export function runStoreSplitDriftTests() {
  // ── 1. THE REGRESSION: a drift that a units-only check is blind to ──────────────────────────────
  // Both nets are internally balanced (they sum to zero per product, which is what
  // phx_write_monthly_store_split_net refuses to write without), so every line's total units agree
  // and the publication drift check — one scalar per line — reports nothing. The money has still
  // moved 100 units' worth from Mahalla to Tanta.
  const frozen = [cell("anti_infective", "D15", "SA001", -100), cell("anti_infective", "D14", "SA001", 100)];
  const live = [cell("anti_infective", "D15", "SA001", -200), cell("anti_infective", "D14", "SA001", 200)];
  const report = diffStoreSplitNet({ frozen, live, period: "2026-08", priceFor });

  assert.equal(report.drifted, true, "the detector must see a redistribution the units check cannot");
  assert.equal(
    report.lineUnitTotalsAgree,
    true,
    "both nets total zero units per line BY CONSTRUCTION — this is exactly why comparing a line's "
      + "total units can never surface this drift, and why the report says so out loud",
  );
  assert.equal(report.byArea.length, 2, "one giver and one receiver");
  const tanta = report.byArea.find((area) => area.areaCode === "D14");
  const mahalla = report.byArea.find((area) => area.areaCode === "D15");
  assert.equal(tanta?.valueDelta, 100 * PRICE, "Tanta is owed 100 more units' value than the frozen net gave it");
  assert.equal(mahalla?.valueDelta, -100 * PRICE, "and Mahalla holds that much more in the frozen net");
  assert.equal(
    Math.abs(report.valueDeltaSum) < 0.005,
    true,
    "the differences sum to zero — proof the drift is a redistribution, never money appearing; a "
      + "non-zero sum would mean one of the two nets does not balance, a worse fault",
  );
  assert.equal(
    report.absoluteValueDelta,
    200 * PRICE,
    "the absolute total counts both sides, so it is twice the money that actually changed hands",
  );

  // ── 2. An identical net is not drift, and must not be reported as any ─────────────────────────
  const same = diffStoreSplitNet({ frozen, live: [...frozen], period: "2026-08", priceFor });
  assert.equal(same.drifted, false, "a frozen net that still matches the rule is not drift");
  assert.equal(same.cells.length, 0, "and it names no cells");
  assert.equal(same.byArea.length, 0, "nor any areas");
  assert.equal(same.absoluteValueDelta, 0, "nothing moved");

  // ── 3. A cell present on ONE side only is drift, in either direction ───────────────────────────
  // This is the shape an owner ruling makes: a customer that was not a warehouse when the net was
  // frozen becomes one, so a pair of cells appears that the frozen photograph never had.
  const appeared = diffStoreSplitNet({
    frozen: [],
    live: [cell("cns", "AB1", "RO001", -50), cell("cns", "AB2", "RO001", 50)],
    period: "2026-08",
    priceFor,
  });
  assert.equal(appeared.drifted, true, "a new ruling that creates a movement the frozen net never had is drift");
  assert.equal(appeared.frozenCells, 0, "the frozen side is empty");
  assert.equal(appeared.liveCells, 2, "and the live side has the pair");
  const vanished = diffStoreSplitNet({
    frozen: [cell("cns", "AB1", "RO001", -50), cell("cns", "AB2", "RO001", 50)],
    live: [],
    period: "2026-08",
    priceFor,
  });
  assert.equal(vanished.drifted, true, "a movement the rule no longer makes is drift too — it runs both ways");

  // ── 4. A PRICE change is NOT split drift, and valuing one side differently would invent some ───
  // Both sides are valued with the same price on purpose: a repriced product restates the closing
  // through its own path, and reporting it here would send someone hunting a split that never moved.
  const repriced = diffStoreSplitNet({
    frozen,
    live: [...frozen],
    period: "2026-10",
    priceFor: () => 170.52,
  });
  assert.equal(repriced.drifted, false, "the same net at a different price is a price restatement, not split drift");

  // ── 5. Float noise below the floor is not a movement ───────────────────────────────────────────
  const noise = diffStoreSplitNet({
    frozen: [cell("pedia", "GZ1", "SA001", 10)],
    live: [cell("pedia", "GZ1", "SA001", 10, 10 + 1e-12)],
    period: "2026-08",
    priceFor,
  });
  assert.equal(noise.drifted, false, "a 1e-12 unit difference is float arithmetic, not a drifted area");

  // ── 6. Duplicate cells on one side are folded, never double-counted ───────────────────────────
  // The frozen table is one row per cell, but a live recompute hands back one payload per LINE and a
  // caller concatenates them; a key arriving twice must add up rather than shadow.
  const folded = diffStoreSplitNet({
    frozen: [cell("cns", "CA1", "SA001", 30)],
    live: [cell("cns", "CA1", "SA001", 10), cell("cns", "CA1", "SA001", 20)],
    period: "2026-08",
    priceFor,
  });
  assert.equal(folded.drifted, false, "10 + 20 on the live side equals the frozen 30 — folding, not shadowing");

  // ── 7. The report carries the period it was asked about, so a log line cannot misattribute ─────
  assert.equal(report.period, "2026-08", "the period travels with the report");
}
