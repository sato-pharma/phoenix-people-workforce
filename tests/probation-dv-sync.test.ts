import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

export function runProbationDvSyncTests() {
  const sync = source("src/lib/probation/intelligence/dv-sync.ts");

  // Cohort scoping: cases are loaded first and detection is scoped to probation employees,
  // so non-probation double visits never enter the probation tables.
  assert.match(sync, /loadCases\(supabase\)/, "cases loaded before detection");
  assert.match(sync, /detectDvDaysForWindow\(supabase, input\.dateFrom, input\.dateTo, caseEmployeeHrIds\)/,
    "detection scoped to the probation cohort");
  assert.match(sync, /partitioned\.needsReview\.filter\(\(d\) => d\.caseId\)/,
    "review-status days without a case are dropped, not persisted");

  // Idempotency guards on every write.
  assert.match(sync, /onConflict: "evaluator_hr_id,employee_hr_id,dv_date", ignoreDuplicates: true/,
    "DV-Days inserted idempotently (no dupes, no clobbering feedback lifecycle)");
  assert.match(sync, /upsertVisits\("crm_visit_id,dv_day_id"\)/,
    "a CRM visit attaches to one DV-Day per evaluator — a chain visit to each manager's day (owner, 2026-10-08)");
  assert.match(sync, /upsert\(visitRows, \{ onConflict, ignoreDuplicates: true \}\)/,
    "the visit rows are written idempotently under whichever key the table holds");
  // The days are written BEFORE their visits and a later run skips an existing day, so a visit write
  // that throws strands those days with no visits for good. Under the pre-20261008141330 table the new
  // key answers 42P10, so the write must fall back to the old key rather than throw.
  assert.match(sync, /if \(vErr\?\.code === "42P10"\) \(\{ data: insVisits, error: vErr \} = await upsertVisits\("crm_visit_id"\)\);/,
    "before the migration lands, the visit write falls back to UNIQUE (crm_visit_id) instead of stranding the days");
  assert.match(sync, /onConflict: "crm_visit_id,reason,employee_hr_id,evaluator_hr_id,dv_date", ignoreDuplicates: true/,
    "ingest issues deduped by a NULL-aware content key (missing-crm rows don't pile up)");

  // Visits attached only for newly-inserted days (existing days keep their visits).
  assert.match(sync, /if \(!dvDayId\) continue;/, "skip attaching visits to already-existing days");

  // Sync health (P3-T10): last_crm_sync_at bumped on touched cases.
  assert.match(sync, /last_crm_sync_at: syncedAt/, "sync-health timestamp bumped on touched cases");

  // Nothing dropped silently: ingest issues surfaced for identity-less rows.
  assert.match(sync, /toIngestIssueRows\(detection\.unresolved\)/, "unresolved rows surfaced to the review queue");

  // Empty cohort short-circuits (no work when there are no probation cases).
  assert.match(sync, /if \(caseEmployeeHrIds\.length === 0\)/, "short-circuit when no probation cases");
}
