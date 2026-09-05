import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { groupClosingCorrections, type ClosingCorrectionRow } from "../src/lib/sales/closing-corrections.ts";

// ONE RETURN IS ONE SITUATION, HOWEVER MANY DETECTORS SEE IT.
//
// SoS audit, confirmed. The headline chip was
// `reversalPairs.length + netNegatives.length + lateReturns.length`, and the three sections are
// built independently with no shared key — so a return that trips two or three detectors was
// counted two or three times.
//
// Measured on production for 2026-07 (after the net-negative fix in #3224): the page listed 17
// rows over 12 distinct cells, announcing "17 situations found". Two cells —
// Anti Infective/D21/RO001 and Anti Infective/D21/SA001 — appear in ALL THREE sections, and a
// third, AB4/RO001, in two. Worse than the count: nothing said they were the same event, so the
// same money was printed three times at three different magnitudes. Summing the sentences for
// D21/SA001 suggested roughly 62,000 EGP of July distortion for a return whose real effect on the
// closing's cell is -12,559.95.
//
// The page exists to size how far a month reads wrong before sign-off. An inflated headline
// inflates exactly the judgement it is there to inform.

const VIEW_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/components/sales/closing-corrections-view.tsx", import.meta.url)),
  "utf8",
);

function row(overrides: Partial<ClosingCorrectionRow>): ClosingCorrectionRow {
  return {
    kind: "late_return",
    period: "2026-07",
    otherPeriod: null,
    line: "Anti Infective",
    distributorCode: "IS-S",
    distributorName: "Ibn Sina-Sato",
    areaCode: "D21",
    areaName: "Damietta",
    productCode: "SA001",
    productName: "Saginko",
    clientName: "Reunion",
    units: -200,
    value: -22230,
    otherUnits: null,
    otherValue: null,
    ...overrides,
  };
}

export async function runClosingCorrectionsOneEventTests(): Promise<void> {
  // ── The production 2026-07 shape: D21/SA001 tripping all three detectors ────────────────────
  const threeWays: ClosingCorrectionRow[] = [
    row({ kind: "late_return", otherPeriod: "2026-06", otherUnits: 234 }),
    row({ kind: "net_negative", units: -13, value: -2660, clientName: null }),
    row({
      kind: "reversal_pair",
      period: "2026-06",
      otherPeriod: "2026-07",
      units: 234,
      value: 26009.1,
      otherUnits: -179,
      otherValue: -19895.85,
      clientName: null,
    }),
    // A genuinely separate situation, different product, one detector only.
    row({ kind: "late_return", productCode: "RO001", productName: "Royafloxacin", clientName: "El-Borg" }),
  ];

  const grouped = groupClosingCorrections(threeWays, "2026-07");

  // ── 1. the headline counts SITUATIONS, not rows ─────────────────────────────────────────────
  assert.equal(
    grouped.reversalPairs.length + grouped.netNegatives.length + grouped.lateReturns.length,
    4,
    "four rows arrive, as before — the sections themselves are unchanged",
  );
  assert.equal(
    grouped.situationCount,
    2,
    "but they are TWO situations: one return seen three ways, plus one separate late return. " +
      "Adding the three section lengths is what announced 17 for 12 on production.",
  );

  // ── 2. each row says where else its own cell appears ────────────────────────────────────────
  const [saginkoLate] = grouped.lateReturns.filter((entry) => entry.productName === "Saginko");
  assert.ok(saginkoLate, "the Saginko late return survives grouping");
  assert.deepEqual(
    [...saginkoLate!.alsoSeenIn].sort(),
    ["Corrections that span two months", "Returns bigger than the month's sales"],
    "the late return must name the other two sections its cell appears in, by their printed headings",
  );

  const [saginkoNegative] = grouped.netNegatives;
  assert.deepEqual(
    [...saginkoNegative!.alsoSeenIn].sort(),
    ["Corrections that span two months", "Returns landing long after their sale"],
    "the net-negative row must cross-reference the other two",
  );

  const [saginkoPair] = grouped.reversalPairs;
  assert.deepEqual(
    [...saginkoPair!.alsoSeenIn].sort(),
    ["Returns bigger than the month's sales", "Returns landing long after their sale"],
    "the reversal pair must cross-reference the other two",
  );

  // A row that stands alone must claim nothing — a false cross-reference is worse than none.
  const [royaLate] = grouped.lateReturns.filter((entry) => entry.productName === "Royafloxacin");
  assert.deepEqual(
    royaLate!.alsoSeenIn,
    [],
    "a situation seen by ONE detector must carry no cross-reference",
  );

  // ── 3. a cell is (line, area, product) — not area alone, and not product alone ──────────────
  // Same area, different product, is a different situation; same product in a different area too.
  const distinctCells = groupClosingCorrections(
    [
      row({ kind: "late_return", areaCode: "D21", productCode: "SA001" }),
      row({ kind: "late_return", areaCode: "D21", productCode: "RO001" }),
      row({ kind: "late_return", areaCode: "AB4", productCode: "SA001" }),
      row({ kind: "late_return", line: "CNS", areaCode: "D21", productCode: "SA001" }),
    ],
    "2026-07",
  );
  assert.equal(
    distinctCells.situationCount,
    4,
    "line, area and product each separate a situation — collapsing on any one of them would " +
      "under-count real, distinct problems, which is the opposite failure",
  );

  // ── 4. an empty month is zero, not undefined ────────────────────────────────────────────────
  const none = groupClosingCorrections([], "2026-07");
  assert.equal(none.situationCount, 0);
  assert.equal(none.isEmpty, true);

  // ── 5. the view must read the distinct count and print the cross-reference ──────────────────
  assert.ok(
    VIEW_SOURCE.includes("data?.situationCount"),
    "the headline chip must read the distinct situation count from the grouping",
  );
  assert.ok(
    !/reversalPairs\.length \+ data\.netNegatives\.length/.test(VIEW_SOURCE),
    "the headline must NOT add the three section lengths together — that is the defect: it counts " +
      "one return as up to three situations",
  );
  const crossRefCalls = (VIEW_SOURCE.match(/withCrossReference\(/g) ?? []).length;
  assert.ok(
    crossRefCalls >= 4,
    `all three tables must render the cross-reference (plus its definition); found ${crossRefCalls} occurrences`,
  );
}
