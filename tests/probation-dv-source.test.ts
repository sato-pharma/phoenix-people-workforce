import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DV_SOURCE_TABLE,
  DV_VISIT_TYPE_CODES,
  dvDayKey,
  mapRawDvVisit,
  type RawDvVisitRow,
} from "../src/lib/probation/intelligence/dv-source.ts";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

export function runProbationDvSourceTests() {
  // Canonical source + predicate must match double-visit-analytics exactly.
  assert.equal(DV_SOURCE_TABLE, "ireports360_visits", "source is the CRM visits mirror");
  assert.deepEqual([...DV_VISIT_TYPE_CODES], [0, -8], "only Regular(0)/Campaign(-8) are DV types");

  const dvAnalytics = source("src/lib/double-visit-analytics/service.ts");
  assert.match(dvAnalytics, /DOUBLE_VISIT_TYPE_CODES = \[0, -8\]/, "codes stay in sync with DV analytics");

  // Attribution: visited party (agent) = probation employee; double = evaluator; crm_visit_id = source id.
  const raw: RawDvVisitRow = {
    id: "row-1",
    crm_visit_id: 90210,
    visit_date: "2026-06-01",
    visit_type: 0,
    visit_type_description: "Regular",
    agent_hr_id: "B-178",
    agent_name: "Fathy Fawzy",
    double_crm_id: 555,
    double_hr_id: "A-12",
    double_name: "NSM Person",
    contact_name: "Dr X",
    customer_name: null,
    comment: "good call",
    ampm: "am",
  };
  const mapped = mapRawDvVisit(raw);
  assert.equal(mapped.employeeHrId, "B-178", "agent_hr_id is the probation employee");
  assert.equal(mapped.evaluatorHrId, "A-12", "double_hr_id is the evaluator");
  assert.equal(mapped.crmVisitId, 90210, "crm_visit_id is the source id");
  assert.equal(mapped.ampm, "AM", "ampm normalized to upper-case AM/PM");
  assert.equal(mapped.dvDate, "2026-06-01");
  assert.equal(mapped.contactName, "Dr X");

  // ampm outside AM/PM normalizes to null (no clock time exists in CRM).
  assert.equal(mapRawDvVisit({ ...raw, ampm: "" }).ampm, null);
  assert.equal(mapRawDvVisit({ ...raw, ampm: "morning" }).ampm, null);

  // DV-Day dedup key: one field day per (evaluator, employee, date), case-insensitive.
  assert.equal(dvDayKey("A-12", "B-178", "2026-06-01"), "a-12|b-178|2026-06-01");
  assert.equal(
    dvDayKey("a-12", "b-178", "2026-06-01"),
    dvDayKey("A-12", "B-178", "2026-06-01"),
    "key is case-insensitive so identity casing can't split a day",
  );
  assert.notEqual(
    dvDayKey("A-12", "B-178", "2026-06-01"),
    dvDayKey("A-12", "B-178", "2026-06-02"),
    "different dates are different DV-Days",
  );

  // The unique constraint backing this key exists in the domain migration.
  const migration = source("supabase/migrations/20260713130000_probation_intelligence_domain.sql");
  assert.match(migration, /unique \(evaluator_hr_id, employee_hr_id, dv_date\)/i, "DV-Day uniqueness enforced in DB");
  assert.match(migration, /crm_visit_id bigint unique/i, "per-visit CRM id unique (no cross-DV-Day double count)");
}
