import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  SALES_TRUTH_TOLERANCE_EGP,
  UNATTRIBUTED_AREA,
  UNLINED,
  type SalesAreaTotals,
  achievementAreaTotals,
  closingAreaTotals,
  describeSurfaceResult,
  reconcileAreaTotals,
  salesTruthKey,
} from "../src/lib/sales/sales-truth-reconciliation.ts";

// ONE AREA, ONE NUMBER — the owner's rule, 2026-09-01: "make sure hundred percent that all numbers
// doesn't differ ... from report to another report. And your source of trust is the monthly
// closing."
//
// Monthly Closing is the truth. Sales vs Target and Source of Sales are measured against it, per
// area, in money. This test pins the comparator that does the measuring, and it pins it with the
// REAL defect that was live in production on the day it was written, to the piastre.
//
// ── THE FIXTURE IS A REAL PRODUCTION READING ────────────────────────────────────────────────
// Anti Infective, 2026-07: 149,288.50 EGP of direct orders sits on a BLANK area_code in
// source_of_sales_fact_rollup. Monthly Closing spreads it across 12 real areas from the owner's
// hand-mapped overlay; every surface reading phx_sales_vs_target_range leaves it unattributed.
// Kafr El-Sheikh 1 (D16) reads 30,123.30 on one screen and 3,651.30 on the other — same area, same
// month, 8x apart. Pedia's equivalent money was stamped into the database on 2026-08-07 and
// reconciles perfectly, which is exactly why the defect stayed invisible: two of three lines look
// right, and the COMPANY TOTAL is correct, because the money is not missing — it is misfiled.
//
// That last point is the whole reason this file exists. Every total-level check ever written here
// passes on this month. Only a per-area comparison sees it.
//
// ── WHY VALUE AND NOT UNITS ─────────────────────────────────────────────────────────────────
// Units of different products are never added in this company (owner's rule), so an area's unit
// total is not a number anybody may quote and comparing one would manufacture findings out of it.
// Money is additive across products. A source pin below keeps it that way.

const RECONCILIATION_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/sales-truth-reconciliation.ts", import.meta.url)),
  "utf8",
);

const REPORT_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/sales-truth-report.ts", import.meta.url)),
  "utf8",
);

/** [area, what Monthly Closing says, what the achievement engine says] — production, 2026-07. */
const ANTI_INFECTIVE_JULY: ReadonlyArray<readonly [string, number, number]> = [
  ["D16", 30_123.3, 3_651.3],
  ["D23", 29_957.25, 5_357.25],
  ["D26", 28_544.95, 11_776.95],
  ["D13", 47_543.15, 31_359.15],
  ["UE1", 20_319.0, 6_642.0],
  ["CA4", 22_435.8, 11_395.8],
  ["UE2", 31_702.5, 21_663.0],
  ["D21", -11_833.2, -21_733.2],
  ["AB5", 19_815.05, 10_615.05],
  ["UE8", 8_789.8, 2_809.8],
  ["D22", 10_808.65, 5_380.65],
];

/** The money the closing placed on those areas and the database left in the blank bucket. */
const UNATTRIBUTED_JULY = 149_288.5;

function totalsFrom(rows: ReadonlyArray<readonly [string, string, number]>): SalesAreaTotals {
  const totals: SalesAreaTotals = new Map();
  for (const [lineCode, areaCode, salesValue] of rows) {
    const key = salesTruthKey(lineCode, areaCode);
    const existing = totals.get(key);
    if (existing) {
      existing.salesValue += salesValue;
      continue;
    }
    const [line, area] = key.split("|");
    totals.set(key, { lineCode: line, areaCode: area, salesValue });
  }
  return totals;
}

export async function runSalesTruthNoMismatchTests(): Promise<void> {
  // ── 1. A surface that agrees is silent ─────────────────────────────────────────────────────
  // Stated first because a guard that fires on a healthy month gets switched off, and then the
  // real finding is never read.
  {
    const rows = ANTI_INFECTIVE_JULY.map(
      ([area, closing]) => ["anti_infective", area, closing] as const,
    );
    const result = reconcileAreaTotals({
      surface: "agreeing surface",
      truth: totalsFrom(rows),
      candidate: totalsFrom(rows),
    });
    assert.equal(result.ok, true, "a surface carrying the closing's own numbers must report clean");
    assert.equal(result.findings.length, 0);
    assert.equal(
      describeSurfaceResult(result),
      "agreeing surface: matches Monthly Closing on every area.",
    );
  }

  // ── 2. THE REGRESSION. The live 2026-07 Anti Infective defect must be caught ────────────────
  const truth = totalsFrom(
    ANTI_INFECTIVE_JULY.map(([area, closing]) => ["anti_infective", area, closing] as const),
  );
  const surface = totalsFrom([
    ...ANTI_INFECTIVE_JULY.map(
      ([area, , achievement]) => ["anti_infective", area, achievement] as const,
    ),
    ["anti_infective", "", UNATTRIBUTED_JULY] as const,
  ]);
  const defect = reconcileAreaTotals({ surface: "Sales vs Target", truth, candidate: surface });

  // The headline assertion. Break the comparator and this is the line that goes red.
  assert.equal(
    defect.ok,
    false,
    "THE HEADLINE: 149,288.50 EGP filed on a blank area while the closing spread it across 11 real " +
      "areas MUST be reported. If this passes, the guard is not guarding anything.",
  );

  // Every misfiled area is named, plus the bucket the money actually sits in.
  assert.equal(defect.findings.length, ANTI_INFECTIVE_JULY.length + 1);
  const byArea = new Map(defect.findings.map((finding) => [finding.areaCode, finding]));

  const kafrElSheikh = byArea.get("D16");
  assert.ok(kafrElSheikh, "Kafr El-Sheikh 1 must be named — it is the worst area of the month");
  assert.equal(kafrElSheikh.closingValue, 30_123.3);
  assert.equal(kafrElSheikh.surfaceValue, 3_651.3);
  assert.equal(kafrElSheikh.kind, "value-mismatch");
  assert.ok(kafrElSheikh.diff < 0, "an under-reporting area must show a negative diff, not a size");

  const unattributed = byArea.get(UNATTRIBUTED_AREA);
  assert.ok(unattributed, "the blank-area money must appear as its own finding, not vanish");
  assert.equal(unattributed.kind, "absent-from-closing");
  assert.equal(unattributed.surfaceValue, UNATTRIBUTED_JULY);
  assert.equal(unattributed.closingValue, 0);

  // Worst first: the owner reads the top of this list, so the biggest gap has to be at the top.
  assert.equal(defect.findings[0].areaCode, UNATTRIBUTED_AREA);
  assert.ok(
    Math.abs(defect.findings[0].diff) >= Math.abs(defect.findings[1].diff),
    "findings must be ordered by size of disagreement",
  );

  // ── 3. The shape that defeats every total-level check ──────────────────────────────────────
  // Net zero, gross 2x. The month's total is RIGHT. Only the areas are wrong. Any guard that
  // compares totals — and every one written here before this file did — passes this month.
  assert.ok(
    Math.abs(defect.netDiff) <= SALES_TRUTH_TOLERANCE_EGP,
    `the July defect nets to zero (was ${defect.netDiff}) — that is why nothing noticed it`,
  );
  assert.equal(Math.round(defect.totalAbsDiff * 100) / 100, UNATTRIBUTED_JULY * 2);
  assert.equal(
    Math.round(defect.closingTotal * 100) / 100,
    Math.round(defect.surfaceTotal * 100) / 100,
  );
  assert.match(
    describeSurfaceResult(defect),
    /money sitting on the wrong areas/,
    "the sentence the owner reads must say the total is right and the AREAS are wrong",
  );

  // ── 4. …and it discriminates. Stamp the money onto the same areas and the finding is gone ──
  // This is the other half of "break the fix": the fixture above must fail for the RIGHT reason,
  // not because the comparator reports everything.
  {
    const repaired = totalsFrom(
      ANTI_INFECTIVE_JULY.map(([area, closing]) => ["anti_infective", area, closing] as const),
    );
    const afterFix = reconcileAreaTotals({ surface: "Sales vs Target", truth, candidate: repaired });
    assert.equal(
      afterFix.ok,
      true,
      "once the rows carry the closing's areas the guard must go quiet",
    );
  }

  // ── 5. A total that is genuinely off is described differently ──────────────────────────────
  // The 462.00 EGP of line-less rows phx_sales_vs_target_range returns for 2026-07 belong to no
  // closing line at all, so they are money being reported that the truth never booked.
  {
    const unlined = reconcileAreaTotals({
      surface: "Sales vs Target",
      truth: totalsFrom([["cns", "CA6", 1_000]]),
      candidate: totalsFrom([
        ["cns", "CA6", 1_000],
        ["", "CA6", 210],
        ["", "GZ5", 126],
      ]),
    });
    assert.equal(unlined.ok, false);
    assert.equal(
      unlined.findings.every((finding) => finding.lineCode === UNLINED),
      true,
    );
    assert.equal(
      unlined.findings.every((finding) => finding.kind === "absent-from-closing"),
      true,
    );
    assert.match(
      describeSurfaceResult(unlined),
      /the total is off by 336 EGP as well/,
      "money on no line inflates the company total, and the sentence must say so",
    );
  }

  // ── 6. An area the closing knows and the surface has never heard of ────────────────────────
  {
    const missing = reconcileAreaTotals({
      surface: "Source of Sales",
      truth: totalsFrom([["pedia", "GZ3", 5_000]]),
      candidate: new Map(),
    });
    assert.equal(missing.findings[0].kind, "missing-on-surface");
    assert.equal(missing.findings[0].surfaceValue, 0);
  }

  // ── 7. ONE bucket for unattributed money, however it is spelled ────────────────────────────
  // A null area_code and an empty-string area_code are the same fact. Keying them apart would
  // split the very money this file exists to keep whole, and both spellings occur in production.
  {
    const nullArea = achievementAreaTotals([{ lineCode: "cns", areaCode: null, actualValue: 100 }]);
    const emptyArea = achievementAreaTotals([{ lineCode: "cns", areaCode: "", actualValue: 100 }]);
    assert.deepEqual([...nullArea.keys()], [...emptyArea.keys()]);
    assert.equal([...nullArea.keys()][0], `cns|${UNATTRIBUTED_AREA}`);
    assert.equal(salesTruthKey("CNS", null), salesTruthKey("cns", ""));
    assert.equal(salesTruthKey(null, "ca1"), `${UNLINED}|CA1`);
  }

  // ── 8. The synthetic Direct pseudo-area is unattributed money; a real area that ABSORBED
  //      direct money is not ─────────────────────────────────────────────────────────────────
  // isDirect answers two different questions (closing-direct-area.ts). Reading it alone would
  // rename a real area and drop it out of the comparison entirely — silently.
  {
    const totals = closingAreaTotals(
      {
        regions: [
          {
            areas: [
              {
                areaCode: "DIRECT",
                areaName: "Direct",
                isDirect: true,
                rowTotal: { salesValue: 149_288.5 },
              },
              {
                areaCode: "D16",
                areaName: "Kafr El-Sheikh 1",
                regionName: "Delta (1)",
                isDirect: true,
                rowTotal: { salesValue: 30_123.3 },
              },
              { areaCode: "CA1", areaName: "Cairo 1", rowTotal: { salesValue: 900 } },
            ],
          },
        ],
      },
      "anti_infective",
      "Anti Infective",
    );
    assert.equal(totals.get(`anti_infective|${UNATTRIBUTED_AREA}`)?.salesValue, 149_288.5);
    assert.equal(totals.get("anti_infective|D16")?.salesValue, 30_123.3);
    assert.equal(totals.has("anti_infective|DIRECT"), false, "DIRECT must never survive as an area");
    assert.equal(totals.get("anti_infective|D16")?.areaName, "Kafr El-Sheikh 1");
    assert.equal(totals.get("anti_infective|D16")?.lineName, "Anti Infective");
    // The synthetic row loses its "Direct" label with its code: it is unattributed money, and
    // labelling it as though it were a place is how it got read as one.
    assert.equal(totals.get(`anti_infective|${UNATTRIBUTED_AREA}`)?.areaName, undefined);
  }

  // ── 8b. The owner never reads a bare code ──────────────────────────────────────────────────
  // His standing rule: human-readable names, never raw codes, in the UI and in chat. Names come
  // from the closing because the achievement engine returns codes only — so a finding must carry
  // the closing's name where one exists, and fall back to the code rather than inventing one.
  {
    const named = reconcileAreaTotals({
      surface: "Sales vs Target",
      truth: closingAreaTotals(
        {
          regions: [
            {
              areas: [
                {
                  areaCode: "D16",
                  areaName: "Kafr El-Sheikh 1",
                  regionName: "Delta (1)",
                  rowTotal: { salesValue: 30_123.3 },
                },
              ],
            },
          ],
        },
        "anti_infective",
        "Anti Infective",
      ),
      candidate: achievementAreaTotals([
        { lineCode: "anti_infective", areaCode: "D16", actualValue: 3_651.3 },
        { lineCode: "anti_infective", areaCode: "ZZ9", actualValue: 42 },
      ]),
    });
    const named16 = named.findings.find((finding) => finding.areaCode === "D16");
    assert.equal(named16?.areaName, "Kafr El-Sheikh 1");
    assert.equal(named16?.regionName, "Delta (1)");
    assert.equal(named16?.lineName, "Anti Infective");

    const unknown = named.findings.find((finding) => finding.areaCode === "ZZ9");
    assert.equal(
      unknown?.areaName,
      "ZZ9",
      "an area the closing has never heard of falls back to its code — never to an invented name",
    );
  }

  // ── 9. A piastre is rounding; two is a discrepancy ─────────────────────────────────────────
  {
    const rounding = reconcileAreaTotals({
      surface: "s",
      truth: totalsFrom([["cns", "CA1", 100]]),
      candidate: totalsFrom([["cns", "CA1", 100.01]]),
    });
    assert.equal(rounding.ok, true, "one piastre is rounding, not a finding");

    const real = reconcileAreaTotals({
      surface: "s",
      truth: totalsFrom([["cns", "CA1", 100]]),
      candidate: totalsFrom([["cns", "CA1", 100.02]]),
    });
    assert.equal(real.ok, false, "two piastres is a finding — the tolerance must not drift upward");
    assert.equal(SALES_TRUTH_TOLERANCE_EGP, 0.01);
  }

  // ── 10. Source pins ────────────────────────────────────────────────────────────────────────
  // Substring checks over the whole file, never a byte window — a pinned byte range false-fails
  // the moment anything above it moves.

  // Units are never compared. Adding a unit total here would breach the owner's rule silently.
  assert.equal(
    RECONCILIATION_SOURCE.includes("salesUnits"),
    false,
    "the comparator must never read a units field — units of different products are never added",
  );

  // THE DISHONEST PASS. The guard must not apply the owner's July direct overlay to the database
  // side: the overlay IS the repair the database is missing, so applying it turns the one real
  // defect of the month into a green tick. This was written, run, and caught before shipping.
  assert.equal(
    REPORT_SOURCE.includes("july-2026-direct-orders"),
    false,
    "the guard must not perform the very repair it is checking for — see the comment in " +
      "loadSourceOfSalesAreaTotals",
  );

  // A loader that quietly falls back to its newest month would reconcile two different months and
  // report the whole company as broken.
  assert.ok(
    REPORT_SOURCE.includes("parts.combined.period !== selectedPeriod"),
    "a period fallback must be refused, not compared",
  );

  // Head Office is outside every closing by the owner's golden rule; comparing it would report the
  // whole line as missing on both surfaces, every month, for ever.
  assert.ok(
    REPORT_SOURCE.includes("if (!lineCode) continue;"),
    "a line with no target code (Head Office) must be skipped, not reported",
  );

  // The confidential list must be the shared constant, not a copy that can drift from the SQL.
  assert.ok(
    REPORT_SOURCE.includes("new Set<string>(RESTRICTED_PRODUCT_CODES)"),
    "confidential products must come from the one shared constant",
  );

  // A truncated read must throw rather than be reported as a small month.
  assert.ok(
    REPORT_SOURCE.includes("direct rollup read truncated"),
    "a partial PostgREST page must never be mistaken for the whole month",
  );
}
