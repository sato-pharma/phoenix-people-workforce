import assert from "node:assert/strict";
import {
  buildSosCoverageReport,
  type SosCoverageBatch,
} from "../src/lib/sales/sos-coverage.ts";
import {
  describeMonthCompleteness,
  SOURCE_QUIET_PERIODS,
  sourceQuietIn,
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

  // ── 5. A SOURCE THE OWNER SAYS IS NOT FILING THIS MONTH IS NOT OWED ────────────────────────────
  // 2026-10-09, his words: "ebda and mec are not comming this month". Both fed August, so the
  // last-month rule expected both and the gate would have waited for ever — and the September
  // store-split rebuild parked behind this gate could never have fired.
  const quietBatches: SosCoverageBatch[] = [
    batch("2026-08", "EP", "epda"),
    batch("2026-08", "MC", "mec"),
    batch("2026-08", "IS", "Ibn sina"),
    batch("2026-08", "Office", "Marcyrl"),
    batch("2026-09", "IS", "Ibn sina"),
    batch("2026-09", "Office", "Marcyrl"),
  ];
  const quiet = summarize(quietBatches, "2026-09");
  assert.deepEqual(quiet.missing, [], "epda and mec are declared quiet for 2026-09, so nothing is owed");
  assert.equal(quiet.complete, true, "September is COMPLETE — the two books are not coming");
  assert.deepEqual(
    quiet.quietExplained.map((entry) => entry.name),
    ["epda", "mec"],
    "and both are NAMED as quiet, so a complete month never reads as if their books arrived",
  );
  assert.match(describeMonthCompleteness(quiet), /epda and mec file nothing this month/);
  assert.doesNotMatch(
    describeMonthCompleteness(quiet),
    /every source that fed 2026-08 has landed/,
    "and it must NOT claim they landed — two of August's sources did not",
  );
  assert.match(describeMonthCompleteness(quiet), /not comming this month/, "his own words travel to the reader");

  // The declaration is PERIOD-scoped, never a retirement: October expects both files again.
  const october = summarize([...quietBatches, batch("2026-10", "IS", "Ibn sina")], "2026-10");
  assert.deepEqual(
    october.missing.map((entry) => entry.name),
    ["Marcyrl"],
    "October's expectation is September's present set — epda and mec were not in it, so they are not owed there either",
  );
  assert.equal(sourceQuietIn("EP", "2026-10"), null, "but the DECLARATION itself stops at September");
  assert.equal(sourceQuietIn("MC", "2026-10"), null);

  // 🔴 THE DATA OUTVOTES THE DECLARATION. A book that does arrive is present, so a late upload can
  // never be hidden by the line in SOURCE_QUIET_PERIODS that said it was not coming.
  const lateArrival = summarize([...quietBatches, batch("2026-09", "EP", "epda")], "2026-09");
  assert.equal(lateArrival.complete, true);
  assert.deepEqual(
    lateArrival.quietExplained.map((entry) => entry.name),
    ["mec"],
    "epda filed after all, so only mec is reported quiet",
  );

  // Every declaration carries his words, so a reader can always tell who decided it.
  for (const declared of SOURCE_QUIET_PERIODS) {
    assert.match(declared.reason, /owner, \d{4}-\d{2}-\d{2}/, `${declared.code}'s declaration must cite the owner and the date`);
    assert.ok(declared.periods.length > 0, `${declared.code} must name at least one period`);
  }
}
