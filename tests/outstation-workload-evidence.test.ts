import assert from "node:assert/strict";
import { mergeWorkloadEvidence } from "../src/lib/outstation/workload-evidence.ts";
import type { DoubleVisitExpenseWorkloadEvidence } from "../src/lib/double-visit-analytics/types.ts";
import type { RepVisitWorkload } from "../src/lib/crm/visit-workload.ts";

const doubleVisit: DoubleVisitExpenseWorkloadEvidence = {
  amWorkload: 0,
  campaignVisits: 1,
  dateBreakdown: [],
  importId: "import-1",
  matchStatus: "no_activity",
  matchedDates: [],
  missingDates: ["2026-06-15", "2026-06-16"],
  pmWorkload: 0,
  regularVisits: 2,
  source: "double_visit_import",
  sourceLabel: "Double Visit import",
};

const repWorkload: RepVisitWorkload = {
  amWorkload: 3,
  campaignVisits: 9,
  dateBreakdown: [
    { am: 3, campaign: 9, checkins: [], date: "2026-06-15", other: 1, pm: 4, regular: 2, total: 7, visits: [] },
  ],
  idleDates: ["2026-06-16"],
  matchStatus: "matched",
  matchedDates: ["2026-06-15"],
  otherVisits: 1,
  pmWorkload: 4,
  regularVisits: 5,
  sourceLabel: "Live iReports360 Visits Report.",
};

export function runOutstationWorkloadEvidenceTests() {
  const merged = mergeWorkloadEvidence(doubleVisit, repWorkload);

  // --- the bug being fixed: solo field days must count as worked ---

  assert.equal(merged.amWorkload, 3, "AM workload comes from the CRM read, which sees the rep's solo field days");
  assert.equal(merged.pmWorkload, 4, "PM workload comes from the CRM read");
  assert.equal(
    merged.matchStatus,
    "matched",
    "a rep who worked must not stay flagged no_activity — that false flag is what made the engine judge real trips against a workload of zero",
  );
  assert.deepEqual(merged.matchedDates, ["2026-06-15"], "matched dates come from the corrected read");
  assert.deepEqual(merged.missingDates, ["2026-06-16"], "idle dates from the corrected read become missingDates");

  // --- the risk being contained: the campaign cap MUST keep double-visit counts ---

  assert.equal(
    merged.campaignVisits,
    1,
    "campaignVisits MUST stay the double-visit count (1), never the CRM read's 9 — the cap rejects on 'campaign DOUBLE-visits', so feeding it solo campaign visits would spuriously auto-reject legitimate trips",
  );
  assert.equal(
    merged.regularVisits,
    2,
    "regularVisits MUST stay the double-visit count — totalDvVisits gates a live rejection rule, and counting solo visits there would silently fail-open it",
  );
  assert.equal(merged.source, "double_visit_import", "provenance of the campaign counts is unchanged");
  assert.equal(merged.importId, "import-1", "the double-visit import id survives for traceability");

  // --- the stored snapshot stays compact ---

  assert.deepEqual(
    merged.dateBreakdown,
    [{ am: 3, date: "2026-06-15", evidenceRows: 7, pm: 4, total: 7 }],
    "the persisted breakdown is the compact projection — per-visit and per-check-in detail must not be written into the snapshot column",
  );

  // --- failure of the corrected read must never block a write path ---

  const fallback = mergeWorkloadEvidence(doubleVisit, null);
  assert.deepEqual(
    fallback,
    doubleVisit,
    "when the CRM read fails we keep the previous evidence unchanged rather than blocking an expense submission",
  );
}
