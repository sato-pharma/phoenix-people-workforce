import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { totalValueDelta } from "../src/lib/sales/portal-sos-dashboard.ts";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// The portal Source of Sales "Total Value" arrow (SoS re-measure 2026-09-18, #86). The tile showed
// the PICKED month's value, but its arrow came from the last two points of the trend, which are
// always the newest month and the one before it. A manager reviewing March read July-vs-June's
// percentage beside March's number. The arrow now compares the picked month with the calendar
// month before it, from the same comparison that fills "Δ vs last month".
export function runPortalTotalValueDeltaTests() {
  // ── The arrow pairs the picked month with the month before it, and nothing else ──
  assert.equal(totalValueDelta("2026-03", 1_200_000, "2026-02", 1_000_000), 0.2, "March against February");
  assert.equal(totalValueDelta("2026-03", 800_000, "2026-02", 1_000_000), -0.2, "a fall reads as a fall");
  assert.equal(totalValueDelta("2026-01", 1_500_000, "2025-12", 1_000_000), 0.5, "January against the December before it");

  // July against June is the arrow the bug showed beside March. It must never be accepted for March.
  assert.equal(totalValueDelta("2026-03", 1_200_000, "2026-06", 1_000_000), null, "a month that is not the one before is refused");
  assert.equal(totalValueDelta("2026-03", 1_200_000, "2026-03", 1_000_000), null, "the picked month against itself is refused");
  assert.equal(totalValueDelta("2026-03", 1_200_000, "2026-01", 1_000_000), null, "two months back is refused");

  // Nothing to divide by, or nothing to compare: no arrow, rather than a made-up one.
  assert.equal(totalValueDelta("2026-03", 1_200_000, "2026-02", 0), null, "a month with no sales before it gets no arrow");
  assert.equal(totalValueDelta("2026-03", 1_200_000, "2026-02", -5), null, "a negative prior total gets no arrow");
  assert.equal(totalValueDelta(null, 1_200_000, "2026-02", 1_000_000), null, "no picked month, no arrow");
  assert.equal(totalValueDelta("2026-03", 1_200_000, null, 1_000_000), null, "no prior month, no arrow");
  assert.equal(totalValueDelta("2026-03", Number.NaN, "2026-02", 1_000_000), null, "an unreadable total gets no arrow");

  // ── The server fills the arrow from the picked month and the month it actually fetched ──
  const domain = readSource("../src/lib/sales/portal-sos-dashboard.ts");
  assert.match(
    domain,
    /totalValueDelta: totalValueDelta\(current\.period, current\.summary\.totalValue, prev\.period, previousTotalValue\)/,
    "computeComparison must set the arrow from the picked month's total and the previous month's total",
  );
  assert.match(domain, /const previousTotalValue = prev\.summary\.totalValue;/, "the prior total must be the previous month's own summary");

  // ── The tile reads that arrow, never the trend ──
  const component = readSource("../src/components/sales/portal/portal-sos-dashboard-impl.tsx");
  const tile = /<StatTile[^>]*label="Total Value"[^>]*delta=\{(\w+)\}/.exec(component);
  assert.ok(tile, "the Total Value tile must pass an arrow");
  const deltaName = tile[1];
  const definition = new RegExp(`const ${deltaName} = ([^;]+);`).exec(component);
  assert.ok(definition, `the Total Value arrow (${deltaName}) must be defined in the component`);
  assert.equal(
    definition[1].trim(),
    "comparison?.totalValueDelta ?? null",
    "the Total Value arrow must come from the server's comparison of the picked month with the month before it",
  );
  assert.doesNotMatch(
    component,
    /\.length - 2\]/,
    "the dashboard must not pair the last two trend points; they are the newest months, not the picked one",
  );
}
