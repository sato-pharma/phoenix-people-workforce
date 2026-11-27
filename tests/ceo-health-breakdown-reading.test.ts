import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { healthBreakdownReading } from "../src/lib/ceo/health-breakdown.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The Company Health Breakdown printed each bar's PROGRESS toward its goal (rate ÷ goal) under the
// rate's own label. Sales achievement's goal is 90%, so on 27 Nov 2026 the published closing's
// July–October achievement — EGP 58,304,862.83 sold against EGP 78,001,861.19 of target, 74.75% —
// read "83%". The printed figure is now the rate; only the bar and its colour measure progress.
//
// And the top-movers table (Spend by Area, Top Spenders) scrolled sideways on a 375px phone: its
// "SHARE" header needed 56px in an 18% column of 48px.
// ─────────────────────────────────────────────────────────────────────────────

export async function runCeoHealthBreakdownReadingTests() {
  // ── The printed figure is the rate, never rate ÷ goal ──────────────────────
  {
    const reading = healthBreakdownReading(58_304_862.83 / 78_001_861.19, 0.9);
    assert.equal(reading.printedPct, 75, "sales achievement prints the achievement itself (74.75% → 75%)");
    assert.equal(reading.progressPct, 83, "the bar still fills to the progress toward the 90% goal");
  }

  // ── A goal of 100% prints and fills the same ───────────────────────────────
  {
    const reading = healthBreakdownReading(0.99, 1);
    assert.deepEqual(reading, { printedPct: 99, progressPct: 99 });
  }

  // ── Above the goal: the figure is the real rate, the bar is full ───────────
  {
    const reading = healthBreakdownReading(1.12, 0.9);
    assert.equal(reading.printedPct, 112, "an over-achievement is printed as it is, never capped");
    assert.equal(reading.progressPct, 100, "the bar caps at full");
  }

  // ── Unmeasured stays unmeasured ────────────────────────────────────────────
  {
    assert.deepEqual(healthBreakdownReading(null, 0.9), { printedPct: null, progressPct: null });
    assert.deepEqual(healthBreakdownReading(Number.NaN, 1), { printedPct: null, progressPct: null });
  }

  // ── The breakdown prints `printedPct` and no longer divides by the goal itself ──
  {
    const source = stripComments(readFileSync("src/components/admin/ceo-phase-b.tsx", "utf8"));
    assert.match(source, /healthBreakdownReading\(value, target\)/, "the breakdown reads its figures through healthBreakdownReading");
    assert.match(source, /printedPct === null \? "—" : `\$\{printedPct\}%`/, "the printed figure is printedPct");
    assert.doesNotMatch(source, /\(value as number\) \/ target/, "the breakdown does not divide the rate by its goal for the printed figure");
  }

  // ── The Share column is wide enough for its header on a phone ──────────────
  {
    const source = stripComments(readFileSync("src/components/admin/ceo-top-movers-table.tsx", "utf8"));
    const cols = [...source.matchAll(/<col className="w-\[(\d+)%\]" \/>/g)].map((match) => Number(match[1]));
    assert.deepEqual(cols, [10, 46, 22, 22], "#, label, value and Share columns: Share holds its 56px header at 375px");
    assert.equal(cols.reduce((sum, width) => sum + width, 0), 100, "the columns add to the table's full width");
  }
}
