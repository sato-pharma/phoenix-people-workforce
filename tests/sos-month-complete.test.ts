import assert from "node:assert/strict";
import {
  buildSosCoverageReport,
  type SosCoverageBatch,
} from "../src/lib/sales/sos-coverage.ts";
import {
  describeMonthCompleteness,
  summarizeMonthCompleteness,
} from "../src/lib/sales/sos-month-complete.ts";

// The one question this module answers — "are the last books in for THIS month?" — is the gate the
// owner put the September store-split rebuild behind (2026-10-09). Every assertion below covers a
// way a simpler rule gets it wrong: a merged file read as a hole, a long-retired source read as a
// hole for ever, an empty month read as a complete one.

function batch(period: string, distributorCode: string, distributorName: string): SosCoverageBatch {
  return { distributorCode, distributorName, period, totalValue: 1_000 };
}

function summarize(batches: SosCoverageBatch[], period: string) {
  return summarizeMonthCompleteness({ batches, period, report: buildSosCoverageReport(batches) });
}

export function runSosMonthCompleteTests() {
  // ── 1. THE REGRESSION: EPDA-BULK is quiet on purpose in July/August and a REAL hole in September ─
  // MERGED_SOURCE_WINDOWS carries EP-BK into EP-PHS for 2026-07..2026-08 only, precisely so the
  // September-onward absence the EPDA-BULK contribution rule depends on stays visible. Last month's
  // present set does NOT contain EP-BK (its file was folded in), so an expectation built from that
  // set alone would drop the one book that rule needs.
  const bulkBatches: SosCoverageBatch[] = [
    batch("2026-06", "EP-BK", "EPDA-BULK"),
    batch("2026-06", "EP-PHS", "EPDA-Pharmacies"),
    batch("2026-06", "IS", "Ibn sina"),
    batch("2026-07", "EP-PHS", "EPDA-Pharmacies"),
    batch("2026-07", "IS", "Ibn sina"),
    batch("2026-08", "EP-PHS", "EPDA-Pharmacies"),
    batch("2026-08", "IS", "Ibn sina"),
    batch("2026-09", "EP-PHS", "EPDA-Pharmacies"),
    batch("2026-09", "IS", "Ibn sina"),
  ];

  const august = summarize(bulkBatches, "2026-08");
  assert.equal(august.complete, true, "August is COMPLETE — EPDA-BULK's file was carried by EPDA-Pharmacies");
  assert.deepEqual(
    august.mergedExplained,
    [{ into: "EPDA-Pharmacies", name: "EPDA-BULK" }],
    "the quiet source is explained, not silently dropped",
  );

  const september = summarize(bulkBatches, "2026-09");
  assert.equal(september.complete, false, "September is INCOMPLETE — the merge window ended in August");
  assert.deepEqual(
    september.missing.map((entry) => entry.name),
    ["EPDA-BULK"],
    "a source carried last month is still expected this month, and it is named, never coded",
  );
  assert.match(
    describeMonthCompleteness(september),
    /still missing 1 source that fed 2026-08: EPDA-BULK/,
    "the one-line description names what is still owed and the month it is measured against",
  );

  // ── 2. A SOURCE THAT STOPPED MONTHS AGO IS NOT THIS MONTH'S HOLE ───────────────────────────────
  // chimipharm last supplied 2026-05 on production. Judged against the whole history it would make
  // every month since incomplete for ever and this gate would never fire once.
  const retired = summarize(
    [
      batch("2026-05", "CP", "chimipharm"),
      batch("2026-05", "IS", "Ibn sina"),
      batch("2026-08", "IS", "Ibn sina"),
      batch("2026-09", "IS", "Ibn sina"),
    ],
    "2026-09",
  );
  assert.equal(retired.complete, true, "September is complete — chimipharm did not feed August either");
  assert.equal(retired.missing.length, 0);
  assert.match(describeMonthCompleteness(retired), /2026-09 is COMPLETE/);

  // ── 3. WHAT FED LAST MONTH AND NOT THIS ONE IS THE HOLE ────────────────────────────────────────
  const dropped = summarize(
    [
      batch("2026-08", "IS", "Ibn sina"),
      batch("2026-08", "Office", "Marcyrl"),
      batch("2026-09", "IS", "Ibn sina"),
    ],
    "2026-09",
  );
  assert.equal(dropped.complete, false);
  assert.deepEqual(dropped.missing.map((entry) => entry.name), ["Marcyrl"]);

  // ── 4. AN EMPTY MONTH IS NOT A COMPLETE ONE ────────────────────────────────────────────────────
  // "nothing uploaded yet" and "everything uploaded" produce the same empty missing-list, and
  // reading this one as complete would fire the rebuild on a month holding no data at all.
  const untouched = summarize(bulkBatches, "2026-10");
  assert.equal(untouched.started, false, "October has no validated batch");
  assert.equal(untouched.complete, false, "so it is NOT complete");
  assert.match(describeMonthCompleteness(untouched), /no validated upload at all yet/);
}
