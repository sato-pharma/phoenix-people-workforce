import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Guards the Phase 11 completion report: all 6 migrations documented + all 45 acceptance criteria
// present, so the deliverable can't silently drift out of sync with the code.

export function runProbationCompletionReportTests() {
  const doc = readFileSync("docs/probation-decision-intelligence.md", "utf8");

  for (const migration of [
    "20260713130000_probation_intelligence_domain",
    "20260713131000_probation_provision_trigger",
    "20260713132000_probation_dv_ingest_issues",
    "20260713133000_probation_scorecard_config",
    "20260713134000_probation_hr_assessment_flag",
    "20260713135000_probation_decision_snapshot_and_extend_teardown",
  ]) {
    assert.ok(doc.includes(migration), `report documents migration ${migration}`);
  }

  // All 45 acceptance criteria rows present (| 1 | … | 45 |).
  for (let n = 1; n <= 45; n++) {
    assert.match(doc, new RegExp(`\\|\\s*${n}\\s*\\|`), `acceptance criterion ${n} present in the matrix`);
  }

  // Key sections exist.
  for (const section of [
    "Executive summary", "Database changes", "Security & data integrity",
    "Acceptance-criteria evidence matrix", "Production rollout checklist", "Rollback plan",
    "Known limitations",
  ]) {
    assert.ok(doc.includes(section), `report has the "${section}" section`);
  }
}
