import assert from "node:assert/strict";

import {
  isSplitEligible,
  nonReceivingAreas,
  splitStoreSalesAcrossCityAreas,
  splitTargetsFor,
  SPLIT_NON_RECEIVING_AREAS,
  type StoreSplitRow,
} from "../src/lib/sales/store-sales-city-split.ts";

/**
 * DOWN TOWN RECEIVES NO SPLIT SHARE ON PEDIA — owner, 2026-09-07:
 * "no split to downtown ... originally it belongs to pedia but it keeps in others".
 *
 * WHY IT IS WRONG TO CREDIT IT. Down town (CA5) is Cairo geographically, so it sits in AREA_CITY and
 * drew a share of every Cairo wholesaler — and, from this morning, a seventh of El Qema's whole
 * Qalubeya book. But on PEDIA au.line_area_map parks it in Others: `other_line_specific`, staffed in
 * CNS, NO rep seat, `carries_target = false`. Measured on Pedia 2026-08 before this rule, Down town
 * sold 15 units (3,570.75 EGP) and was credited 1,027.4 units (272,713.74) — 269,142.99 EGP handed to
 * an area with nobody in it, of which 268,636.73 came from El Qema.
 *
 * This does NOT contradict "the divisor is AREAS even when the seat is VACANT" (see
 * qema-qalubeya-split.test.ts). CA1-CA4 and CA6 on Pedia are vacant SEATS — real, waiting to be
 * filled. Down town on Pedia is not a seat at all.
 *
 * THREE THINGS ARE PINNED HERE AND EACH FAILS SILENTLY IF BROKEN:
 *
 *   1. Its own sales STAY. The ruling forbids Down town being credited someone else's money, not
 *      Down town keeping its own. A row originating there must not be scattered across Cairo.
 *   2. The exclusion reaches BOTH rules. The El Qema override and the ordinary city list are two
 *      different code paths to the same area set; an exclusion applied to one only would leave the
 *      Matrix and the Detail sheet disagreeing about the same customer.
 *   3. PUBLISHED MONTHS ARE UNTOUCHED. This layer is recomputed live, so an ungated change restates
 *      every month at once. Pedia July and August Anti Infective are published; both must be
 *      unaffected, and the drift check cannot see it if they are not — it compares UNITS, and this
 *      moves units between areas while preserving each line's total.
 */

const BASE: StoreSplitRow = {
  areaCode: "D11",
  clientCode: "QM-1",
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

export function runDowntownReceivesNoSplitShareTests() {
  // ── The gate itself ──────────────────────────────────────────────────────────────────────────
  const entry = SPLIT_NON_RECEIVING_AREAS.get("pedia");
  assert.ok(entry, "Pedia has a non-receiving entry");
  assert.equal(entry.fromPeriod, "2026-08", "and it starts in August 2026, the month still open");
  assert.ok(entry.areas.has("CA5"), "Down town is the excluded area");

  assert.ok(nonReceivingAreas("Pedia", "2026-08").has("CA5"), "excluded on Pedia from August");
  assert.ok(nonReceivingAreas("pedia", "2026-09").has("CA5"), "and every month after");
  assert.equal(
    nonReceivingAreas("Pedia", "2026-07").has("CA5"), false,
    "PUBLISHED PEDIA JULY IS UNTOUCHED — the whole reason this is period-gated",
  );
  for (const line of ["CNS", "Anti Infective", "anti_infective", "Head Office", "", null]) {
    assert.equal(
      nonReceivingAreas(line, "2026-08").size, 0,
      `${line || "(blank)"} is not affected — August Anti Infective is published and must not restate`,
    );
  }
  for (const bad of ["", null, undefined, "2026", "August", "26-08"]) {
    assert.equal(
      nonReceivingAreas("Pedia", bad).size, 0,
      "an unreadable period excludes NOTHING — leaving a number where it was is the safe direction",
    );
  }

  // ── 2. The exclusion reaches the EL QEMA override ────────────────────────────────────────────
  const qema = splitTargetsFor(row(), "2026-08");
  assert.ok(qema, "El Qema's Qalubeya book still splits");
  assert.deepEqual(
    [...qema.areas].sort(),
    ["CA1", "CA2", "CA3", "CA4", "CA6", "D11"],
    "SIX areas — the five staffed Cairo areas plus Qalubeya itself. Down town is not among them",
  );
  assert.equal(qema.areas.includes("CA5"), false, "THE HEADLINE: Down town receives no El Qema share");
  assert.equal(
    [...(splitTargetsFor(row(), "2026-07")?.areas ?? [])].includes("CA5"),
    true,
    "and July, which is published, still divides across all seven",
  );

  // ── 2b. The exclusion reaches the ORDINARY Cairo city rule too ───────────────────────────────
  const cairo = splitTargetsFor(row({ areaCode: "CA3", distributorCode: "PS", clientCode: "PS-1" }), "2026-08");
  assert.ok(cairo, "an ordinary Cairo wholesaler still splits");
  assert.deepEqual(
    [...cairo.areas].sort(),
    ["CA1", "CA2", "CA3", "CA4", "CA6"],
    "five areas, not six — the ruling is about Down town, not about El Qema",
  );

  // ── 1. A row ORIGINATING in Down town keeps its own money ────────────────────────────────────
  const fromDowntown = row({ areaCode: "CA5", distributorCode: "PS", clientCode: "PS-2", qty: 60, salesValue: 16_200 });
  assert.equal(
    splitTargetsFor(fromDowntown, "2026-08"), null,
    "a Down town row has nothing to divide across, so it is left exactly where it is",
  );
  assert.equal(isSplitEligible(fromDowntown, "2026-08"), false, "and it is not eligible to split");

  // ── End to end: Down town receives nothing, and no units are lost ────────────────────────────
  const result = splitStoreSalesAcrossCityAreas([row(), fromDowntown], "2026-08");
  const byArea = new Map<string, number>();
  for (const r of result.rows) byArea.set(r.areaCode, (byArea.get(r.areaCode) ?? 0) + r.qty);
  assert.equal(byArea.get("CA5"), 60, "Down town holds its OWN 60 units and not one unit more");
  assert.equal(
    Number([...byArea.values()].reduce((a, b) => a + b, 0).toFixed(6)), 760,
    "and the 700 + 60 units are all still there — a split never creates or destroys units",
  );
  assert.equal(
    Number((byArea.get("D11") ?? 0).toFixed(6)),
    Number((700 / 6).toFixed(6)),
    "Qalubeya keeps a SIXTH of its own book now, not a seventh",
  );

  // ── 3. Anti Infective in the same month is untouched ─────────────────────────────────────────
  const ai = splitTargetsFor(row({ officialLine: "Anti Infective" }), "2026-08");
  assert.equal(
    [...(ai?.areas ?? [])].includes("CA5"), true,
    "AUGUST ANTI INFECTIVE IS PUBLISHED AND LOCKED — it must still divide across all seven areas",
  );
}
