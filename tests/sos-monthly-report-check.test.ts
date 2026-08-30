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

  // ── WHY THE ACTIVE-LINE SET MUST EXCLUDE HEAD OFFICE (fixed 2026-08-30) ──────────────────────
  // The gate requires EVERY active line, so one unpublishable line closes it forever. That is not
  // hypothetical — it is what happened. The closing has excluded Head Office since 2026-08-05, so a
  // Head Office publication cannot exist, yet this check was handed the wider set deliberately, via
  // listMonthlyClosingLines({ includeHeadOffice: true }). Measured on production 2026-08-30:
  // 2026-07 published on Anti Infective, CNS and Pedia; monthly_closing_publications held 0 Head
  // Office rows; notification_outbox held 0 `sos-bi-report:%` rows. The report had never fired.
  //
  // The real line set opens the gate.
  assert.deepEqual(
    computeFullyPublishedPeriods(
      ["Anti Infective", "CNS", "Pedia"],
      [
        { normalizedLine: "anti infective", period: "2026-07" },
        { normalizedLine: "cns", period: "2026-07" },
        { normalizedLine: "pedia", period: "2026-07" },
      ],
    ),
    ["2026-07"],
    "the three real sales lines published for a period is what readiness means",
  );

  // The same period, with the unpublishable line added back, is silently never ready. This is the
  // discriminating half: it fails if anyone widens the active set again, and it is the exact shape
  // production was in. No error and no log — just an email that never arrives.
  assert.deepEqual(
    computeFullyPublishedPeriods(
      ["Anti Infective", "CNS", "Head Office", "Pedia"],
      [
        { normalizedLine: "anti infective", period: "2026-07" },
        { normalizedLine: "cns", period: "2026-07" },
        { normalizedLine: "pedia", period: "2026-07" },
      ],
    ),
    [],
    "counting a line that can never be published makes the gate unsatisfiable — do not widen this set",
  );
}
