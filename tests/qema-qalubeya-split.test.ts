import assert from "node:assert/strict";

import {
  isStoreCustomerForPeriod,
  isWholesaleOnlyDistributor,
  WHOLESALE_ONLY_DISTRIBUTORS,
} from "../src/lib/sales/customer-channel.ts";
import {
  DISTRIBUTOR_SPLIT_TARGETS,
  isSplitEligible,
  splitStoreSalesAcrossCityAreas,
  splitTargetsFor,
  type StoreSplitRow,
} from "../src/lib/sales/store-sales-city-split.ts";

/**
 * EL QEMA'S QALUBEYA RULE — owner, 2026-09-07.
 *
 * "سوف يتم تقسيم بيع القليوبية على مندوب القليوبية بالإضافة إلى كل مندوبين القاهرة بالتساوى"
 *
 * El Qema's Qalubeya sales divide across Qalubeya AND all six Cairo areas, evenly. Asked the two
 * questions that decide the shape, he answered "one way only, only for el qema".
 *
 * BOTH HALVES OF THAT ANSWER ARE TESTED HERE, because both are silent when wrong:
 *
 *   ONE WAY — a Cairo warehouse must NOT reach Qalubeya. If this rule were expressed as city
 *   membership (moving D11 into "Cairo" in AREA_CITY) that assertion is what would fail: city
 *   membership is symmetric, so Qalubeya would start drawing a share of every Cairo wholesaler, from
 *   every distributor, in the same edit. Nothing else would report it — the split preserves each
 *   line's unit total while moving units between areas, so the publication drift check sees nothing.
 *
 *   EL QEMA ONLY — the same warehouse, same area, sold through Overseas must behave exactly as it
 *   did before: Qalubeya is a one-area governorate, so it does not split at all.
 *
 * THE DIVISOR IS AREAS, NOT REPS, and Qalubeya is where that matters most: on Pedia all six Cairo
 * areas are VACANT (verified live 2026-09-07), so six of the seven shares land on empty seats and
 * wait there. That is the owner's rule — "حتى لو فيها فاكانت" — not a defect to fix.
 */

const BASE: StoreSplitRow = {
  areaCode: "D11",
  clientCode: "QM-9001",
  clientName: "مخزن القليوبية للأدوية",
  distributorCode: "QM",
  includedInClosing: true,
  isDirect: false,
  officialLine: "Pedia",
  productCode: "LA001",
  qty: 700,
  salesValue: 189_000,
};

const row = (over: Partial<StoreSplitRow> = {}): StoreSplitRow => ({ ...BASE, ...over });

const CAIRO = ["CA1", "CA2", "CA3", "CA4", "CA5", "CA6"] as const;

export function runQemaQalubeyaSplitTests() {
  // ── The registry entry itself ────────────────────────────────────────────────────────────────
  const entry = DISTRIBUTOR_SPLIT_TARGETS.get("QM|D11");
  assert.ok(entry, "the El Qema Qalubeya rule is registered under QM|D11");
  assert.deepEqual(
    [...entry.areas].sort(),
    ["CA1", "CA2", "CA3", "CA4", "CA5", "CA6", "D11"],
    "seven areas: Qalubeya plus all six of Cairo",
  );
  assert.ok(
    entry.areas.includes("D11"),
    "Qalubeya keeps its own share — the origin is never emptied out entirely",
  );
  // 🔴 DOWN TOWN (CA5) STAYS, and it is the one a future session will be tempted to drop.
  // It is the ONLY Cairo area with no Pedia rep seat at all — not a vacant seat, no seat — and the
  // owner's OWN manual closing for August 2026 divides this warehouse SIX ways, leaving it out.
  // Measured against that sheet on 2026-09-07: his الفرسان بنها جملة(ت2) sits at 755.333 in each of
  // six areas (4,532/6) where Phoenix books 647.43 in each of seven. He was shown the gap and ruled
  // for seven — "down town should be included because we split in reference to areas not actual
  // reps". So the divisor is AREAS whether the seat is vacant OR does not exist, and making Phoenix
  // agree with that spreadsheet would reverse an owner decision rather than fix a bug.
  assert.ok(
    entry.areas.includes("CA5"),
    "Down town is in the split — owner 2026-09-07, the divisor is areas and not actual reps",
  );

  // ── El Qema, Qalubeya: splits seven ways ─────────────────────────────────────────────────────
  assert.equal(isSplitEligible(row(), "2026-09"), true, "an El Qema Qalubeya warehouse splits");
  const qema = splitStoreSalesAcrossCityAreas([row()], "2026-09");
  const shares = qema.rows.filter((r) => r.clientCode === "QM-9001");
  assert.equal(shares.length, 7, "one row becomes seven, one per target area");
  assert.deepEqual(
    shares.map((r) => r.areaCode).sort(),
    ["CA1", "CA2", "CA3", "CA4", "CA5", "CA6", "D11"],
    "and they are exactly the seven target areas",
  );
  for (const share of shares) {
    assert.equal(Number(share.qty.toFixed(6)), 100, "700 units / 7 areas = 100 each, evenly");
    assert.equal(Number(share.salesValue.toFixed(2)), 27_000, "189,000 / 7 = 27,000 each");
  }
  assert.equal(
    Number(shares.reduce((sum, r) => sum + r.qty, 0).toFixed(6)),
    700,
    "the total is preserved exactly — the split moves money, it never creates or destroys any",
  );
  assert.equal(
    Number(shares.reduce((sum, r) => sum + r.salesValue, 0).toFixed(2)),
    189_000,
    "and the same for value",
  );

  // ── ONE WAY: El Qema in CAIRO must not reach Qalubeya ────────────────────────────────────────
  const cairoTargets = splitTargetsFor(row({ areaCode: "CA3", clientCode: "QM-9002" }));
  assert.ok(cairoTargets, "a Cairo warehouse still splits");
  assert.deepEqual(
    [...cairoTargets.areas].sort(),
    [...CAIRO].sort(),
    "a Cairo warehouse divides across Cairo's six areas ONLY — Qalubeya gets nothing",
  );
  assert.equal(
    cairoTargets.areas.includes("D11"),
    false,
    "THE ONE-WAY ASSERTION: if this ever includes D11 the rule has been turned into city membership, "
      + "and Qalubeya has started drawing on every Cairo wholesaler from every distributor",
  );

  // ── EL QEMA ONLY: the same warehouse through another distributor is untouched ─────────────────
  for (const distributor of ["PS", "IS", "IS-S", "EP-PHS", undefined]) {
    const other = row({ distributorCode: distributor, clientCode: "PS-9003" });
    const targets = splitTargetsFor(other);
    assert.deepEqual(
      targets?.areas ? [...targets.areas] : null,
      ["D11"],
      `Qalubeya through ${distributor ?? "no distributor"} targets ITSELF ALONE — the ordinary one-area governorate`,
    );
    assert.equal(
      isSplitEligible(other, "2026-09"),
      false,
      `and a single target means nothing moves, so it does not split at all through ${distributor ?? "no distributor"}`,
    );
  }

  // ── El Qema everywhere else behaves like any other distributor ────────────────────────────────
  const alex = splitTargetsFor(row({ areaCode: "AB2", clientCode: "QM-9004" }));
  assert.ok(alex, "El Qema in Alexandria still splits");
  assert.deepEqual(
    [...alex.areas].sort(),
    ["AB1", "AB2", "AB3"],
    "Alexandria's three areas — the override is keyed on the ORIGIN area, not on the distributor alone",
  );
  assert.equal(alex.group, "Alexandria", "and it is labelled as the ordinary city, not the override");

  // ── The movement carries a label that says WHICH rule moved the money ────────────────────────
  const movement = qema.movements.find((m) => m.outQty > 0);
  assert.ok(movement, "the split reports a movement out of the origin");
  assert.equal(
    movement.city,
    "Qalubeya + Cairo (El Qema)",
    "the Store Split sheet names the override, so a reader is never left guessing why Cairo gained",
  );

  // ── A pharmacy is untouched by any of this ───────────────────────────────────────────────────
  assert.equal(
    isSplitEligible(row({ clientName: "صيدلية النور", clientCode: "QM-9005" }), "2026-09"),
    false,
    "the override decides WHERE a store's money goes — it never makes a pharmacy into a store",
  );

  // ── EVERY El Qema customer is a wholesaler — owner, 2026-09-07 ───────────────────────────────
  //
  // "all here are wholeslars to be splitted". El Qema sells ON to other wholesalers rather than to
  // pharmacies, so the name test has nothing to add: of their 30 customers the six keywords catch
  // only 10, and the other 20 would have stayed put.
  assert.ok(isWholesaleOnlyDistributor("QM"), "El Qema is a wholesale-only distributor");
  assert.ok(isWholesaleOnlyDistributor("qm"), "and the check is case-insensitive");
  assert.equal(WHOLESALE_ONLY_DISTRIBUTORS.size, 1, "El Qema is the ONLY one — adding another is his call");

  // Real names from their August book that carry NO store keyword and no trade phrase. Each one is
  // a store through QM and a pharmacy through anyone else, which is the whole point of the rule.
  for (const name of ["كيان قنا", "دلة الفيوم", "رويال الاسماعيليه", "هانى براعى المنيا", "الدكتور محمد شعير"]) {
    assert.equal(
      isStoreCustomerForPeriod(name, null, "QM", "2026-09", "Pedia"),
      true,
      `${name} is a wholesaler because El Qema sold it, not because of its name`,
    );
    assert.equal(
      isStoreCustomerForPeriod(name, null, "PS", "2026-09", "Pedia"),
      false,
      `${name} through Overseas is unchanged — the rule is about the DISTRIBUTOR, not the customer`,
    );
  }

  // A hospital or a government depot still does not split, whoever sold it. Deliberately below the
  // "never a store" words: 17 of the owner's 2026-09-06 rulings say a government store supplies its
  // own institutions wherever it bought from.
  for (const name of ["مستشفى المنزله العام", "ت.ص.مخازن السيوف", "صيدلية النور"]) {
    assert.equal(
      isStoreCustomerForPeriod(name, null, "QM", "2026-09", "Pedia"),
      false,
      `${name} does not become a wholesaler just because El Qema invoiced it`,
    );
  }

  // ── And the period gate still governs ─────────────────────────────────────────────────────────
  assert.equal(
    isSplitEligible(row(), "2026-07"),
    true,
    "isSplitEligible itself is period-aware only for the WAREHOUSE rule; the month gate that stops "
      + "July splitting at all lives in isStoreCitySplitActive, at the apply points",
  );
}
