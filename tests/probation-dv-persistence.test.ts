import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { toDvDayRow, toDvVisitRows } from "../src/lib/probation/intelligence/dv-persistence.ts";
import { toIngestIssueRows } from "../src/lib/probation/intelligence/dv-review.ts";
import { detectDvDays } from "../src/lib/probation/intelligence/dv-detection.ts";
import type { ValidatedDvDay } from "../src/lib/probation/intelligence/dv-validation.ts";
import type { RawDvVisitRow } from "../src/lib/probation/intelligence/dv-source.ts";
import type { SourceDvVisit } from "../src/lib/probation/intelligence/dv-source.ts";

function visit(id: number, over: Partial<SourceDvVisit> = {}): SourceDvVisit {
  return {
    crmVisitId: id,
    employeeHrId: "B-178",
    employeeName: "Emp",
    evaluatorHrId: "A-12",
    evaluatorName: "Eval",
    dvDate: "2026-06-01",
    ampm: "AM",
    visitType: 0,
    visitTypeDescription: "Regular",
    contactName: `Dr ${id}`,
    customerName: null,
    comment: null,
    ...over,
  };
}

function validated(over: Partial<ValidatedDvDay> = {}): ValidatedDvDay {
  return {
    key: "a-12|b-178|2026-06-01",
    employeeHrId: "B-178",
    evaluatorHrId: "A-12",
    dvDate: "2026-06-01",
    visitCount: 3,
    periods: over.periods ?? ["AM"],
    crmVisitIds: over.crmVisitIds ?? [3, 1, 2],
    visits: over.visits ?? [visit(1), visit(2), visit(3)],
    caseId: "case-1",
    evaluatorRole: "dm",
    dvStatus: "validated",
    validationReason: null,
    ...over,
  };
}

export function runProbationDvPersistenceTests() {
  // Parent row: one DV-Day carries a visit_count + sorted crm_source_ids.
  {
    const row = toDvDayRow(validated(), "2026-07-13T00:00:00.000Z");
    assert.equal(row.case_id, "case-1");
    assert.equal(row.evaluator_role, "dm");
    assert.equal(row.visit_count, 3);
    assert.deepEqual(row.crm_source_ids, [1, 2, 3], "crm ids stored sorted for stable payloads");
    assert.equal(row.dv_status, "validated");
  }

  // Day ampm: single half keeps the marker; a day spanning AM+PM stores null.
  assert.equal(toDvDayRow(validated({ periods: ["AM"] }), "t").ampm, "AM");
  assert.equal(toDvDayRow(validated({ periods: ["AM", "PM"] }), "t").ampm, null);

  // Child rows: every underlying visit becomes one probation_dv_visits row (P3-T07).
  {
    const rows = toDvVisitRows(validated({ visits: [visit(1), visit(2)] }));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].crm_visit_id, 1);
    assert.equal(rows[0].contact_name, "Dr 1");
    assert.equal(rows[0].visit_type, 0);
  }

  // P3-T08: identity-less detection rows map to ingest-issue rows (surfaced, not dropped).
  {
    function raw(over: Partial<RawDvVisitRow>): RawDvVisitRow {
      return {
        id: "r", crm_visit_id: 10, visit_date: "2026-06-01", visit_type: 0,
        visit_type_description: "Regular", agent_hr_id: "B-178", agent_name: "E",
        double_crm_id: 9, double_hr_id: "A-12", double_name: "V",
        contact_name: "Dr", customer_name: null, comment: null, ampm: "AM", ...over,
      };
    }
    const { unresolved } = detectDvDays([raw({ crm_visit_id: 10, agent_hr_id: null })]);
    const issues = toIngestIssueRows(unresolved);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].reason, "unresolved_employee");
    assert.equal(issues[0].crm_visit_id, 10);
  }

  // The ingest-issues table backing P3-T08 exists in the migration.
  const migration = readFileSync("supabase/migrations/20260713132000_probation_dv_ingest_issues.sql", "utf8");
  assert.match(migration, /create table if not exists public\.probation_dv_ingest_issues/i);
  assert.match(migration, /enable row level security/i, "ingest issues table is service-role-only");
}
