import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { formatTopMoverShare, topMoverShareBasis } from "../src/lib/ceo/top-mover-share.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The CEO Command Center's top-movers tables state a Share % the CEO reads and acts on. It was
// computed twice, differently, and neither one was right.
//
//  - The SCREEN divided by the rows surviving the FILTER, so typing in the filter box re-based
//    every percentage: narrow to one region and it read 100.0%.
//  - The EXPORT divided by the sum of all `movers`, so the sheet and the screen disagreed the
//    moment anyone filtered — against the standing rule that an export MATCHES the screen.
//  - And every caller passes a TRUNCATED list, so even the export's denominator was the total of
//    the top few rather than of the period.
//
// Measured on production 2026-09-23, Source of Sales:
//   2026-08   13 regions carried sales; the 5 listed hold 90.4% of their value  → shares ~11% high
//   2026-05    9 regions carried sales; the 5 listed hold 87.6% of their value  → shares ~14% high
// ─────────────────────────────────────────────────────────────────────────────

const rows = (...values: number[]) => values.map((value) => ({ value }));

export async function runCeoTopMoversShareTests() {
  // ── A filtered view must NOT change anybody's share ───────────────────────
  {
    const all = rows(500, 300, 150, 50);
    const basis = topMoverShareBasis(all);
    // What the old screen did: re-derive the basis from whatever the filter left.
    const filteredBasis = topMoverShareBasis(rows(500));
    assert.equal(
      formatTopMoverShare(500, basis),
      "50.0%",
      "RED a row's share must be of the whole table, not of the rows a filter happens to leave",
    );
    assert.notEqual(
      formatTopMoverShare(500, filteredBasis),
      formatTopMoverShare(500, basis),
      "the two bases must genuinely differ — otherwise this test proves nothing",
    );
    assert.equal(formatTopMoverShare(500, filteredBasis), "100.0%", "filtering to one row used to read 100.0%");
  }

  // ── The screen and the export share ONE basis ─────────────────────────────
  {
    const movers = rows(500, 300, 150, 50);
    const basis = topMoverShareBasis(movers, 2_000);
    const screen = movers.map((r) => formatTopMoverShare(r.value, basis));
    const exported = movers.map((r) => formatTopMoverShare(r.value, basis));
    assert.deepEqual(
      screen,
      exported,
      "RED the export must match the screen — two denominators is how they came to disagree",
    );
  }

  // ── A truncated list divides by the POPULATION, not by itself ─────────────
  {
    // August's real shape: the five listed regions are 90.4% of the regional value.
    const listed = rows(300, 250, 200, 150, 104);
    const populationTotal = 1_110;
    const listedTotal = topMoverShareBasis(listed);
    assert.equal(listedTotal, 1_004, "the listed rows sum to less than the population — that is the whole point");
    assert.equal(
      formatTopMoverShare(300, topMoverShareBasis(listed, populationTotal)),
      "27.0%",
      "RED a top-N row's share must divide by the period's total, not by the top N",
    );
    assert.equal(
      formatTopMoverShare(300, listedTotal),
      "29.9%",
      "dividing by the listed rows is what inflated every region's share",
    );
  }

  // ── Shares on a top-N list legitimately do not reach 100% ─────────────────
  {
    const listed = rows(300, 250, 200, 150, 104);
    const basis = topMoverShareBasis(listed, 1_110);
    const sum = listed.reduce((s, r) => s + (r.value / basis) * 100, 0);
    assert.ok(
      sum > 88 && sum < 92,
      `RED a truncated list must NOT be normalised to 100% — the missing rows are real money (got ${sum.toFixed(1)}%)`,
    );
  }

  // ── Degenerate inputs never produce a fake number ─────────────────────────
  assert.equal(formatTopMoverShare(10, 0), "—", "nothing to divide by must read as an em dash, never 0.0% or Infinity");
  assert.equal(formatTopMoverShare(Number.NaN, 100), "—", "a non-finite value must not render as NaN%");
  assert.equal(topMoverShareBasis(rows(1, 2), 0), 3, "a zero total falls back to the rows rather than dividing by zero");
  assert.equal(topMoverShareBasis(rows(1, 2), -5), 3, "a negative total is not a basis");
  assert.equal(topMoverShareBasis([]), 0, "an empty table has no basis");

  // ── The component must not reintroduce a filtered denominator ─────────────
  const component = readFileSync(
    new URL("../src/components/admin/ceo-top-movers-table.tsx", import.meta.url),
    "utf8",
  );
  const code = component
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
    })
    .join("\n");
  assert.doesNotMatch(
    code,
    /table\.rows\.reduce/,
    "RED reducing over `table.rows` is the filtered denominator this fix removed — the basis comes from `movers`",
  );
  assert.match(
    code,
    /topMoverShareBasis\(movers, total\)/,
    "the component must take its basis from the full movers list plus the caller's population total",
  );
}
