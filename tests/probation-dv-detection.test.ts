import assert from "node:assert/strict";

import { detectDvDays } from "../src/lib/probation/intelligence/dv-detection.ts";
import type { RawDvVisitRow } from "../src/lib/probation/intelligence/dv-source.ts";

let seq = 0;
function row(over: Partial<RawDvVisitRow>): RawDvVisitRow {
  seq += 1;
  return {
    id: `r${seq}`,
    crm_visit_id: over.crm_visit_id ?? 1000 + seq,
    visit_date: "2026-06-01",
    visit_type: 0,
    visit_type_description: "Regular",
    agent_hr_id: "B-178",
    agent_name: "Emp",
    double_crm_id: 9,
    double_hr_id: "A-12",
    double_name: "Eval",
    contact_name: "Dr",
    customer_name: null,
    comment: null,
    ampm: "AM",
    ...over,
  };
}

export function runProbationDvDetectionTests() {
  // Many customer visits on one field day collapse to ONE DV-Day with a visit_count.
  {
    const { dvDays, unresolved } = detectDvDays([
      row({ ampm: "AM" }), row({ ampm: "AM" }), row({ ampm: "PM" }),
      row({}), row({}), row({}), row({}), row({}), row({}), row({}), // 10 visits total
    ]);
    assert.equal(dvDays.length, 1, "10 visits, same (evaluator,employee,date) => 1 DV-Day");
    assert.equal(dvDays[0].visitCount, 10, "visit_count reflects all underlying visits");
    assert.deepEqual([...dvDays[0].periods].sort(), ["AM", "PM"], "distinct AM/PM captured");
    assert.equal(dvDays[0].crmVisitIds.length, 10, "all CRM ids retained for traceability");
    assert.equal(dvDays[0].visits.length, 10, "per-visit detail retained for probation_dv_visits");
    assert.equal(unresolved.length, 0);
  }

  // Different evaluator, or different date, or different employee => separate DV-Days.
  {
    const { dvDays } = detectDvDays([
      row({ crm_visit_id: 1 }),
      row({ crm_visit_id: 2, double_hr_id: "A-99" }),       // different evaluator
      row({ crm_visit_id: 3, visit_date: "2026-06-02" }),   // different date
      row({ crm_visit_id: 4, agent_hr_id: "B-188" }),       // different employee
    ]);
    assert.equal(dvDays.length, 4, "distinct evaluator/date/employee each form their own DV-Day");
  }

  // A repeated crm_visit_id is counted once (a CRM activity belongs to exactly one DV-Day).
  {
    const { dvDays } = detectDvDays([
      row({ crm_visit_id: 500 }),
      row({ crm_visit_id: 500 }),
      row({ crm_visit_id: 501 }),
    ]);
    assert.equal(dvDays.length, 1);
    assert.equal(dvDays[0].visitCount, 2, "duplicate crm_visit_id ignored; 2 distinct visits");
  }

  // Rows missing employee / evaluator / crm id are surfaced (not dropped).
  {
    const { dvDays, unresolved } = detectDvDays([
      row({ crm_visit_id: 10, agent_hr_id: null }),
      row({ crm_visit_id: 11, double_hr_id: "  " }),
      row({ crm_visit_id: null }),
      row({ crm_visit_id: 12 }),
    ]);
    assert.equal(dvDays.length, 1, "only the one valid row forms a DV-Day");
    const reasons = unresolved.map((u) => u.reason).sort();
    assert.deepEqual(reasons, ["missing_crm_visit_id", "unresolved_employee", "unresolved_evaluator"],
      "each bad row surfaced with a specific reason");
  }

  // Deterministic ordering (date, employee, evaluator).
  {
    const { dvDays } = detectDvDays([
      row({ crm_visit_id: 1, visit_date: "2026-06-03" }),
      row({ crm_visit_id: 2, visit_date: "2026-06-01" }),
      row({ crm_visit_id: 3, visit_date: "2026-06-02" }),
    ]);
    assert.deepEqual(dvDays.map((d) => d.dvDate), ["2026-06-01", "2026-06-02", "2026-06-03"]);
  }
}
