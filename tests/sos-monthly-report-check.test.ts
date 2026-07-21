import assert from "node:assert/strict";

import { computeFullyPublishedPeriods } from "../src/lib/sales/sos-report-delivery.ts";

export function runSosMonthlyReportCheckTests() {
  // No active lines at all — nothing can ever be "fully published".
  assert.deepEqual(computeFullyPublishedPeriods([], [{ normalizedLine: "cns", period: "2026-06" }]), []);

  // A period with only SOME of the active lines published is not yet ready.
  assert.deepEqual(
    computeFullyPublishedPeriods(
      ["CNS", "Anti Infective", "Vaccines"],
      [
        { normalizedLine: "cns", period: "2026-06" },
        { normalizedLine: "anti infective", period: "2026-06" },
      ],
    ),
    [],
  );

  // Every active line published for a period marks it ready. activeLines are raw display
  // names (normalized internally); publishedClosings[].normalizedLine is contractually
  // already normalized (produced by normalizeClosingLine() at write time in the real
  // PublishedClosing rows) — case-insensitive matching comes from normalizing the active
  // side to meet it, not from re-normalizing already-normalized input.
  assert.deepEqual(
    computeFullyPublishedPeriods(
      ["CNS", "Anti Infective"],
      [
        { normalizedLine: "cns", period: "2026-06" },
        { normalizedLine: "anti infective", period: "2026-06" },
      ],
    ),
    ["2026-06"],
  );

  // Multiple periods: only the one with full coverage is returned, not the partial one.
  assert.deepEqual(
    computeFullyPublishedPeriods(
      ["CNS", "Anti Infective"],
      [
        { normalizedLine: "cns", period: "2026-05" },
        { normalizedLine: "anti infective", period: "2026-05" },
        { normalizedLine: "cns", period: "2026-06" },
      ],
    ),
    ["2026-05"],
  );

  // A period with no published rows at all never appears — nothing to check, not a false
  // "fully published" from an empty every() over an empty published-line set.
  assert.deepEqual(
    computeFullyPublishedPeriods(["CNS"], []),
    [],
  );

  // Extra lines published beyond the active set (e.g. a retired line with stale rows) don't
  // block or duplicate-count — only active lines are required.
  assert.deepEqual(
    computeFullyPublishedPeriods(
      ["CNS"],
      [
        { normalizedLine: "cns", period: "2026-06" },
        { normalizedLine: "retired line", period: "2026-06" },
      ],
    ),
    ["2026-06"],
  );
}
