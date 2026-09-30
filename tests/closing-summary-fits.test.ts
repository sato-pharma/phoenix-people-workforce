import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripComments } from "./support/comment-strip.ts";

import {
  buildClosingFamilySummary,
  pivotClosingSummaryByFamily,
} from "../src/lib/sales/closing-family-summary.ts";
import type {
  MonthlyClosingCell,
  MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";

// THE CLOSING SUMMARY THAT FITS — and must never disagree with the matrix beside it.
//
// The full closing matrix cannot fit a screen and never will: areas × PRODUCTS × six metrics, with
// CNS carrying 14 products plus its Office column. Measured 2026-09-05, the width model validated
// against the live page (predicted 1,558px for Anti Infective, measured 1,559):
//
//     Anti Infective   2 products    1,558px  vs 1,144px container   1.4x over
//     Pedia            4 products   ~2,490px                          2.2x over
//     CNS             14 products   ~9,600px                          8.4x over
//
// Forcing CNS to fit leaves 29px per product, so the fits-the-screen rule's own remedy — merge
// columns, never shrink type — does not reach it. The matrix therefore keeps its scroll as the
// auditor's detail view, and this family-grain summary ships BESIDE it, per the owner's standing
// instruction that anything new sits beside the old closing rather than changing it.
//
// THE DANGER THIS TEST GUARDS. A second view of the same money is exactly how "one area, one
// number" gets broken. The summary is FOLDED from the same matrix object and carries the matrix's
// own row totals through untouched, so the two cannot drift — not even by a rounding step.

const COMPONENT_RAW = readFileSync(
  fileURLToPath(new URL("../src/components/sales/closing-summary-fits.tsx", import.meta.url)),
  "utf8",
);

/**
 * The component with COMMENTS STRIPPED.
 *
 * The file explains at length what it deliberately does NOT use — "no overflow-x-auto", "no
 * min-width floor" — so a check against the raw text matches its own prose and fails on a file that
 * is correct. Caught exactly that way on the first run.
 */
const COMPONENT = stripComments(COMPONENT_RAW);

const cell = (
  salesValue: number,
  targetValue: number | null = null,
  achievement: number | null = null,
): MonthlyClosingCell => ({ achievement, salesUnits: 0, salesValue, targetUnits: null, targetValue });

/** Two families over three products, so folding is a real fold and not a rename. */
function matrixFixture(): MonthlyClosingMatrix {
  const columns = [
    { family: "Saginko", productCode: "SA001", productName: "Saginko 40mg" },
    { family: "Saginko", productCode: "SA002", productName: "Saginko 80mg" },
    { family: "Royafloxacin", productCode: "RO001", productName: "Royafloxacin 500" },
  ];
  const areaCells = [cell(100, 50), cell(200, 150), cell(700, null)];
  return {
    availableLines: ["CNS"],
    availablePeriods: ["2026-08"],
    columns,
    grandTotal: { cells: areaCells, kind: "grandTotal", rowTotal: cell(1000, 200, 500) },
    line: "CNS",
    period: "2026-08",
    regions: [
      {
        areas: [
          { areaCode: "GZ6", areaName: "Fayoum", cells: areaCells, rowTotal: cell(1000, 200, 500) },
        ],
        regionCode: "UE",
        regionName: "Upper Egypt",
        subtotal: {
          cells: areaCells,
          kind: "regionSubtotal",
          regionCode: "UE",
          regionName: "Upper Egypt",
          rowTotal: cell(1000, 200, 500),
        },
      },
    ],
  } as MonthlyClosingMatrix;
}

export async function runClosingSummaryFitsTests(): Promise<void> {
  const summary = buildClosingFamilySummary(matrixFixture());

  // ── 1. families come from the matrix's own columns, in order, deduped ──────────────────────
  assert.deepEqual(
    summary.families,
    ["Saginko", "Royafloxacin"],
    "families read left-to-right exactly as the matrix presents them, each once",
  );

  const [area] = summary.regions[0]!.areas;
  const saginko = area!.byFamily.find((f) => f.family === "Saginko")!;
  const royaflox = area!.byFamily.find((f) => f.family === "Royafloxacin")!;

  // ── 2. IT FOOTS TO THE MATRIX — the whole point ────────────────────────────────────────────
  assert.equal(saginko.value + royaflox.value, 1000, "the families sum to the area's own row total");
  assert.equal(
    area!.total.salesValue,
    1000,
    "and the total shown is the matrix's rowTotal, carried through — not a re-addition that could " +
      "round differently from the matrix beside it",
  );
  assert.equal(saginko.value, 300, "Saginko folds its two products (100 + 200)");
  assert.equal(royaflox.value, 700, "a single-product family passes through unchanged");

  // ── 3. achievement is recomputed on the SUMMED slice, never averaged ───────────────────────
  // Saginko: 300 value over 200 target = 150%. Averaging the two products' own percentages
  // (100/50 = 200% and 200/150 = 133%) would give ~167% — a number belonging to no money.
  assert.equal(saginko.targetValue, 200, "family target is the sum of the targets that exist");
  assert.ok(
    Math.abs((saginko.achievement ?? 0) - 150) < 0.001,
    `Saginko must read 150% (300/200), recomputed on the slice. Got ${saginko.achievement}`,
  );

  // ── 4. no target reads as a DASH, never 0% and never Infinity ──────────────────────────────
  assert.equal(
    royaflox.targetValue,
    null,
    "a family whose products carry no target has no target — summing nulls as zeros would invent one",
  );
  assert.equal(
    royaflox.achievement,
    null,
    "and its achievement must be null so the screen prints a dash. 0% would read as total failure " +
      "on an area that simply has no target, and value/0 would render Infinity",
  );

  // ── 5. a column with no family label is kept, never dropped ────────────────────────────────
  // Dropping it would understate the area against the matrix beside it — the exact disagreement
  // this view exists not to create.
  const unlabelled = matrixFixture();
  unlabelled.columns = [{ family: "", productCode: "XX001", productName: "Unfamilied" }];
  unlabelled.regions[0]!.areas[0]!.cells = [cell(42)];
  const kept = buildClosingFamilySummary(unlabelled);
  assert.deepEqual(kept.families, ["XX001"], "an unlabelled column falls back to its product code");
  assert.equal(kept.regions[0]!.areas[0]!.byFamily[0]!.value, 42, "and keeps its money");

  // ── 6. the view FITS BY CONSTRUCTION, and must keep doing so ───────────────────────────────
  assert.match(
    COMPONENT,
    /className="w-full table-fixed/,
    "the summary table must be w-full table-fixed — the shape the golden rule prescribes",
  );
  assert.match(COMPONENT, /<colgroup>/, "with a colgroup, so the columns are declared not discovered");
  assert.match(
    COMPONENT,
    /width: `\$\{\w+Pct\}%`/,
    "column widths must be PERCENTAGES: a percentage table cannot exceed its container whatever " +
      "the family count, which is what makes this fit by construction rather than by tuning",
  );
  assert.doesNotMatch(
    COMPONENT,
    /colSpan/,
    "depth is carried by INDENT inside the first column, never by spanning or adding columns — " +
      "that is what keeps the width fixed at three columns however deep the tree is opened",
  );
  assert.doesNotMatch(
    COMPONENT,
    /overflow-x-auto|overflow-auto|min-w-\[/,
    "no horizontal scroll container and no min-width floor — per the golden rule, that IS the bug " +
      "rather than the fix, and it is what the full matrix already does",
  );
  assert.doesNotMatch(
    COMPONENT,
    /truncate|text-ellipsis/,
    "nothing is truncated — the ellipsis ban stands; long names WRAP instead (break-words)",
  );
  assert.match(COMPONENT, /break-words/, "long area and family names must wrap rather than overflow");
  assert.doesNotMatch(
    COMPONENT,
    /\brounded-/,
    "square-edge golden rule: no rounded corners on a new surface",
  );

  // ── 7. mobile gets cards, never this table ─────────────────────────────────────────────────
  assert.match(COMPONENT, /hidden md:block/, "the table is desktop-only");
  assert.match(COMPONENT, /md:hidden/, "and a card list stands in on mobile");

  // ── 8. THE FAMILY-FIRST TREE IS A PIVOT, NOT A SECOND CALCULATION ──────────────────────────
  // The owner asked for a screen that starts collapsed: families, then regions inside a family,
  // then that region's areas. The danger is the same one section 2 guards — a second view of the
  // same money that quietly disagrees. So every node must carry the SAME cell object the folded
  // summary already holds, never a re-addition of its children.
  const tree = pivotClosingSummaryByFamily(summary);
  assert.deepEqual(
    tree.map((node) => node.family),
    ["Saginko", "Royafloxacin"],
    "the tree's top level is the families, in the matrix's own column order",
  );

  const saginkoNode = tree[0]!;
  assert.equal(
    saginkoNode.total,
    summary.grandTotal.byFamily[0],
    "a family's headline number IS the folded grand-total cell — the same object, not a copy that " +
      "could be computed differently",
  );
  assert.equal(
    saginkoNode.regions[0]!.cell,
    summary.regions[0]!.subtotal.byFamily[0],
    "and a region's is that region's own folded subtotal cell, which came from the matrix's " +
      "subtotal row rather than from re-adding the areas",
  );
  assert.equal(
    saginkoNode.regions[0]!.areas[0]!.cell,
    summary.regions[0]!.areas[0]!.byFamily[0],
    "and an area's is that area's own folded cell",
  );
  assert.equal(saginkoNode.total.value, 300, "so Saginko still reads 300 at the top of the tree");
  assert.equal(
    tree[1]!.total.achievement,
    null,
    "and a family with no target still reads a dash at every level, never 0%",
  );
  assert.equal(
    saginkoNode.regions[0]!.areas.length,
    1,
    "each region carries its own areas, so opening one cannot show another region's",
  );

  // A family the fold never produced must not invent a 0% achievement.
  const missing = pivotClosingSummaryByFamily({ ...summary, families: [...summary.families, "Ghost"] });
  const ghost = missing.at(-1)!;
  assert.equal(ghost.total.value, 0, "an unknown family reads as no money");
  assert.equal(ghost.total.achievement, null, "with a NULL achievement, so the screen prints a dash");

  // ── 9. IT STARTS COLLAPSED — the whole point of the owner's request ────────────────────────
  // EVERY level, not merely one of them. A plain `assert.match` here passed while the family level
  // was seeded wide open, because the region level still carried the empty form it was looking for
  // — caught by breaking the component on purpose. So read all the initialisers and check each.
  const disclosureState = COMPONENT.match(/useState<ReadonlySet<string>>\([^\n]*\)/g) ?? [];
  assert.equal(
    disclosureState.length,
    2,
    "two disclosure levels: the family and the region inside it",
  );
  for (const initialiser of disclosureState) {
    assert.equal(
      initialiser,
      "useState<ReadonlySet<string>>(() => new Set<string>())",
      "every disclosure level starts as an EMPTY set: collapsed by default, per the owner's " +
        "instruction. Seeding either one would put the old full-height view back",
    );
  }
  assert.match(
    COMPONENT,
    /aria-expanded=\{/,
    "every disclosure control reports its state, so the rows are reachable by keyboard and screen " +
      "reader rather than by mouse alone",
  );

  // ── 10. THE GRAND TOTAL IS A PERCENT, in the same unit as the family rows above it ─────────
  // A matrix cell's own `achievement` is a RATIO — `closingAchievement` in
  // monthly-closing-matrix-cells.ts returns `salesValue / targetValue` — while every family cell
  // here is a PERCENT, because `achievementOf` multiplies by 100. The Grand total row rendered the
  // cell's ratio through the same formatter, so on production 2026-10-01 Pedia's September closing
  // printed "0.1%" where the matrix's own National Grand Total row read 9.2%, with Lacto Advanced
  // showing a correct 10.4% two rows above it. Anti Infective misread the same way (6.9% as 0.1%).
  // That is the summary disagreeing with the matrix beside it — the one failure this file exists
  // to prevent — and it is invisible whenever value is 0, which is why CNS looked fine.
  const ratioMatrix = matrixFixture();
  // Pedia, September 2026: the exact row that misread.
  const pediaValue = 483_516.15;
  const pediaTarget = 5_277_055.73;
  ratioMatrix.grandTotal.rowTotal = cell(pediaValue, pediaTarget, pediaValue / pediaTarget);
  const ratioSummary = buildClosingFamilySummary(ratioMatrix);

  assert.ok(
    Math.abs((ratioSummary.grandTotal.achievementPct ?? 0) - 9.1626) < 0.01,
    "the Grand total must carry a PERCENT (483,516.15 / 5,277,055.73 = 9.16%), the same unit the " +
      `family rows use. Got ${ratioSummary.grandTotal.achievementPct} — a value near 0.09 means ` +
      "the cell's RATIO is being carried, which the screen prints as 0.1%",
  );
  assert.ok(
    Math.abs((ratioSummary.grandTotal.total.achievement ?? 0) - 0.0916) < 0.001,
    "and the matrix's own cell keeps ITS unit untouched — the summary re-derives, it never rewrites " +
      "the cell it carries through",
  );
  assert.match(
    stripComments(
      readFileSync(
        fileURLToPath(new URL("../src/lib/sales/closing-family-summary.ts", import.meta.url)),
        "utf8",
      ),
    ),
    /achievementPct: achievementOf\(row\.rowTotal\.salesValue, row\.rowTotal\.targetValue\)/,
    "the percent must come from achievementOf on the row total's OWN two numbers, so it can never " +
      "disagree with the cell beside it — only the unit differs",
  );
  assert.match(
    COMPONENT,
    /achievement\(summary\.grandTotal\.achievementPct\)/,
    "and the Grand total row must render that percent",
  );
  assert.doesNotMatch(
    COMPONENT,
    /achievement\(summary\.grandTotal\.total\.achievement\)/,
    "never the cell's ratio — that is the defect, and it renders as a plausible-looking 0.1%",
  );

  // ── 11. ONE PERCENT FORMATTER, AND IT NAMES ITS UNIT ───────────────────────────────────────
  // Section 10 fixed the value that was passed in. This closes the class: the defect was possible
  // only because this file kept a PRIVATE formatter that appended a bare "%" to whatever it was
  // handed, with no unit anywhere, while every other closing surface goes through
  // `formatPercent(value, { input })` — the one formatter in the repo that states which unit it is
  // being given. A second unit-less formatter is how two units meet silently, so there must not be
  // one here.
  assert.match(
    COMPONENT,
    /import \{ formatPercent \} from "@\/lib\/sales\/format"/,
    "the summary must use the shared percent formatter, the same one closing-matrix-table.tsx uses",
  );

  const percentCalls = COMPONENT.match(/formatPercent\([^;]*?\)/g) ?? [];
  assert.ok(percentCalls.length > 0, "and must actually call it");
  for (const call of percentCalls) {
    assert.match(
      call,
      /input: "(ratio|percent)"/,
      `every formatPercent call must NAME its unit rather than lean on the default. Got: ${call}. ` +
        "The default is 'ratio', so an already-percent value passed bare is multiplied by 100 — " +
        "the same defect as #4989 in the opposite direction, printing 9.2% as 920%",
    );
  }

  assert.doesNotMatch(
    COMPONENT,
    /minimumFractionDigits/,
    "and no private percent formatter may come back — that constant existed only to serve the " +
      "bare-% append this section exists to keep out",
  );
}
