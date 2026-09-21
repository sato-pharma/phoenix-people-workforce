import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { applyAchievementAreaMerges } from "../src/lib/sales/closing-area-merges.ts";
import {
  type SalesAreaTotals,
  achievementAreaTotals,
  applyStoreSplitNetToTotals,
  reconcileAreaTotals,
  salesTruthKey,
} from "../src/lib/sales/sales-truth-reconciliation.ts";
import {
  type SplitRegions,
  type StoreSplitRow,
  areaProductKey,
  isStoreCitySplitActive,
  netStoreSplitByAreaProduct,
  splitStoreSalesAcrossCityAreas,
} from "../src/lib/sales/store-sales-city-split.ts";

// THE SOURCE OF SALES SIDE MUST CARRY THE CLOSING'S OWN STORE SPLIT.
//
// The sales-truth guard compares every surface with Monthly Closing, area by area, and it is meant
// to normalise away the transforms the owner declared, so that only undeclared differences survive.
// From 2026-08 the closing moves two kinds of money after it was filed: a wholesaler's sales over
// its own city's areas, and El Qema's warehouse sales by its bands and its Upper Egypt pass. The
// Source of Sales side read the rows AS FILED and never applied that move, so on 2026-09-21
// `scripts/check-sales-truth.ts 2026-08` reported 105 areas and 4,599,761.25 EGP misplaced. The
// biggest single line, read from production that day: Pedia Qalubeya files 1,833,347.25 EGP of
// distributor sales, 1,797,120.00 of it El Qema's, which the closing spreads over the republic —
// closing 124,698.72 against the surface's 1,836,621.00. July agreed only because the split starts
// in August.
//
// The same run also asked the Fayoum/Beni Suef merge "as of now". Every merge rule is dated and
// Pedia's fold ends with August, so from September the guard stopped folding Beni Suef (79,140.38
// EGP filed that month) into the August row the closing still folds, and reported both halves.
//
// What this pins: the closing's net closes the gap exactly (driven through the REAL splitter, never
// a re-derivation), the report calls the closing's own loader rather than the rule, the merge is
// asked about the month being checked, and the one difference the closing genuinely has — Beni
// Suef's El Qema share, dropped because the split lands after the fold — is still reported.

const REPORT_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/sales-truth-report.ts", import.meta.url)),
  "utf8",
);

/** Pedia's Others and regions as production holds them for August 2026 (tests/qema-warehouse-split.test.ts). */
const PEDIA_AUGUST_OTHERS: ReadonlySet<string> = new Set([
  "CA5", "D17", "UE8", "OT1", "OT2", "OT4", "OT5", "OT6", "OT7", "OT8", "OT9", "OT10",
]);

const PEDIA_AUGUST_REGIONS: SplitRegions = {
  areasByRegion: new Map<string, ReadonlySet<string>>([
    ["AB", new Set(["AB1", "AB2", "AB3", "AB4", "AB5", "D16"])],
    ["CA", new Set(["CA1", "CA2", "CA3", "CA4", "CA6"])],
    ["D1", new Set(["D11", "D12", "D13", "D14", "D15"])],
    ["D2", new Set(["D21", "D22", "D23", "D24", "D25", "D26"])],
    ["GZ", new Set(["GZ1", "GZ2", "GZ3", "GZ4", "GZ5", "GZ6", "GZ7", "UE9"])],
    ["OT", PEDIA_AUGUST_OTHERS],
    ["UE", new Set(["UE1", "UE2", "UE3", "UE4", "UE5", "UE6", "UE7"])],
  ]),
  others: PEDIA_AUGUST_OTHERS,
};

const EL_QEMA_QALUBEYA: StoreSplitRow = {
  areaCode: "D11",
  clientCode: "QM-9001",
  clientName: "مخزن القليوبية للأدوية",
  distributorCode: "QM",
  includedInClosing: true,
  isDirect: false,
  officialLine: "Pedia",
  productCode: "LA001",
  qty: 1_000,
  salesValue: 270_000,
};

/**
 * One Pedia August book: El Qema filed on Qalubeya in two bands (flat over the republic, and half at
 * home), plus a pharmacy the split must never touch.
 */
const AUGUST_ROWS: readonly StoreSplitRow[] = [
  EL_QEMA_QALUBEYA,
  { ...EL_QEMA_QALUBEYA, productCode: "LA002", qty: 400, salesValue: 64_000 },
  {
    ...EL_QEMA_QALUBEYA,
    areaCode: "GZ3",
    clientCode: "PH-1204",
    clientName: "صيدلية الشفاء",
    distributorCode: "IBS",
    qty: 10,
    salesValue: 2_700,
  },
];

/** Per-area money for one line, through the same key builder the guard compares on. */
function pediaTotals(rows: readonly { areaCode: string; salesValue: number }[]): SalesAreaTotals {
  return achievementAreaTotals(
    rows.map((row) => ({ lineCode: "pedia", areaCode: row.areaCode, actualValue: row.salesValue })),
  );
}

export async function runSalesTruthStoreSplitTests(): Promise<void> {
  // ── 1. The split is live for August and not for July ───────────────────────────────────────────
  // loadClosingStoreSplitNet answers empty for every month before 2026-08, which is why July always
  // reconciled and the gap only opened when August closed.
  assert.equal(isStoreCitySplitActive("2026-07"), false, "July keeps the numbers it was published with");
  assert.equal(isStoreCitySplitActive("2026-08"), true, "the city split and El Qema's rule start in August");

  // ── 2. THE REGRESSION: filed rows against the closing's split, with and without its net ───────
  const split = splitStoreSalesAcrossCityAreas(AUGUST_ROWS, "2026-08", PEDIA_AUGUST_REGIONS);
  const net = netStoreSplitByAreaProduct(split.movements);
  // Without this the rest of the section proves nothing: a splitter that moved no money would
  // reconcile both ways.
  assert.ok(
    split.splitRowCount > 0 && net.size > 0,
    "precondition: the real splitter must move El Qema's Qalubeya book in August",
  );

  // What the Source of Sales rows file, and what the closing's own redistributed rows book.
  const filed = pediaTotals(AUGUST_ROWS);
  const closing = pediaTotals(split.rows);

  const unnormalised = reconcileAreaTotals({ surface: "Source of Sales", truth: closing, candidate: filed });
  assert.equal(
    unnormalised.ok,
    false,
    "the rows as filed MUST disagree with the split closing — this is the 105-area report of 2026-09-21",
  );
  const qalubeya = unnormalised.findings.find((finding) => finding.areaCode === "D11");
  assert.ok(qalubeya, "Qalubeya carries El Qema's whole book as filed and must be named");
  assert.equal(qalubeya.surfaceValue, 334_000, "as filed, Qalubeya holds every pound El Qema sold there");
  assert.ok(qalubeya.diff > 0, "and the closing books less there once the split spreads it");
  // Compared on the raw totals, never on netDiff: netDiff sums per-area diffs already rounded to the
  // piastre, and El Qema's even shares (270,000 over 33 areas) leave a rounding residue there.
  assert.ok(
    Math.abs(unnormalised.closingTotal - unnormalised.surfaceTotal) < 0.01,
    `the split moves money between areas and never changes the line total ` +
      `(closing ${unnormalised.closingTotal}, filed ${unnormalised.surfaceTotal})`,
  );

  const normalised = reconcileAreaTotals({
    surface: "Source of Sales",
    truth: closing,
    candidate: applyStoreSplitNetToTotals(filed, "pedia", net),
  });
  // THE HEADLINE. Break applyStoreSplitNetToTotals and this is the line that goes red.
  assert.equal(
    normalised.ok,
    true,
    "THE HEADLINE: the filed rows plus the closing's OWN store-split net must equal the closing on " +
      `every area — ${normalised.findings.length} still disagree. If this fails, the guard reports ` +
      "the owner's own El Qema and city-split decisions as misplaced money.",
  );

  // The pharmacy was never a store: the split leaves its own row where it was filed (its area still
  // receives a share of El Qema, which the net carries).
  assert.deepEqual(
    split.rows.filter((row) => row.clientCode === "PH-1204").map((row) => [row.areaCode, row.salesValue]),
    [["GZ3", 2_700]],
  );

  // The input is not mutated: the report reads `totals` once, but a helper that edits its argument
  // in place double-counts the moment a second caller shares the map.
  assert.equal(filed.get(salesTruthKey("pedia", "D11"))?.salesValue, 334_000);

  // ── 3. The net is read by area, through the closing's own key ─────────────────────────────────
  {
    const cells = new Map([
      [areaProductKey(" ue9", "la001"), { qty: 125, value: 33_736 }],
      [areaProductKey("UE9", "LA002"), { qty: 50, value: 13_494.22 }],
    ]);
    const onUe9 = applyStoreSplitNetToTotals(new Map(), "pedia", cells);
    assert.equal(
      Math.round((onUe9.get(salesTruthKey("pedia", "UE9"))?.salesValue ?? 0) * 100) / 100,
      47_230.22,
      "every product's net for an area lands on that one area, whatever the spelling of the code",
    );
  }

  // ── 4. The merge is asked about the MONTH BEING CHECKED, never about today ─────────────────────
  // Pedia folds Beni Suef into Fayoum up to and including August. A row with no period is resolved
  // as of today, which is past August for ever now — exactly the phantom pair the guard reported.
  {
    const [august] = applyAchievementAreaMerges([{ lineCode: "pedia", areaCode: "UE9", period: "2026-08" }]);
    assert.equal(august?.areaCode, "GZ6", "August's Beni Suef folds into Fayoum, as the closing folds it");
    const [undated] = applyAchievementAreaMerges([{ lineCode: "pedia", areaCode: "UE9" }]);
    assert.equal(
      undated?.areaCode,
      "UE9",
      "an undated row is resolved as of today and loses August's fold — so the report must pass the month",
    );
  }

  // ── 5. What the closing genuinely drops is still reported ──────────────────────────────────────
  // KNOWN AND DECIDED, left as published (memory fayoum-beni-suef-golden-rule-per-line): the August
  // Pedia matrix folds Beni Suef into Fayoum BEFORE the split lands, so Beni Suef's El Qema share
  // finds no row and leaves the closing — 47,230.22 EGP, the same row Sales vs Target reports. A
  // guard that skipped unlandable cells to go green would hide it. Never alter the closing for it.
  {
    const filedAugust = pediaTotals([
      { areaCode: "GZ6", salesValue: 6_287.63 },
      { areaCode: "UE9", salesValue: 79_140.38 },
    ]);
    const splitNet = new Map([
      [areaProductKey("GZ6", "LA001"), { qty: 175, value: 47_230.22 }],
      [areaProductKey("UE9", "LA001"), { qty: 175, value: 47_230.22 }],
    ]);
    // The closing's one folded row: both halves as filed, plus only the share that found a row.
    const closingAugust = pediaTotals([{ areaCode: "GZ6", salesValue: 6_287.63 + 79_140.38 + 47_230.22 }]);

    const withSplit = applyStoreSplitNetToTotals(filedAugust, "pedia", splitNet);
    const folded = achievementAreaTotals(
      applyAchievementAreaMerges(
        [...withSplit.values()].map((total) => ({
          lineCode: total.lineCode,
          areaCode: total.areaCode,
          period: "2026-08",
          actualValue: total.salesValue,
        })),
      ),
    );
    const residue = reconcileAreaTotals({ surface: "Source of Sales", truth: closingAugust, candidate: folded });
    assert.equal(residue.findings.length, 1, "exactly one row survives: the share the closing drops");
    assert.equal(residue.findings[0].areaCode, "GZ6");
    assert.equal(residue.findings[0].diff, 47_230.22);
  }

  // ── 6. The report uses the closing's loader, never the rule ────────────────────────────────────
  // Substring pins over the whole file, never a byte window.
  assert.ok(
    REPORT_SOURCE.includes("await loadClosingStoreSplitNet(input.line, input.period)") &&
      REPORT_SOURCE.includes("applyStoreSplitNetToTotals(totals, input.lineCode, storeSplitNet)"),
    "THE HEADLINE PIN: the Source of Sales side must add the closing's own store-split net " +
      "(loadClosingStoreSplitNet, the net the matrix adds). Remove it and August reports El Qema's " +
      "Qalubeya book as 105 misplaced areas again.",
  );
  assert.equal(
    /splitStoreSalesAcrossCityAreas|netStoreSplitByAreaProduct/.test(REPORT_SOURCE),
    false,
    "the guard must never run the split rule itself — a re-derivation proves only that it agrees with itself",
  );
  assert.ok(
    REPORT_SOURCE.includes("applyMergesToTotals(sourceOfSales, selectedPeriod)") &&
      /areaCode: total\.areaCode,\s+period,\s+salesValue: total\.salesValue/.test(REPORT_SOURCE),
    "the Source of Sales merge must be asked about the month being checked, row by row",
  );
}
