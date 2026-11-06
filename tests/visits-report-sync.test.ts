import assert from "node:assert/strict";

import { mapVisitRow } from "../src/lib/crm/reads.ts";

// The vendor sync engine these tests also pinned (row shaping, dedupe, delete-reconciliation, the
// wide reconcile and the check-in address backfill) was removed when iReports360 was retired on
// 6 November 2026. What stays is the read side: the stored rows it wrote are still mapped here.
export function runVisitsReportSyncTests() {
  // ── mapVisitRow: attendance + crmSaveDate round-trip (items 5 & 6) ───────────────
  const dbRow = {
    agent_crm_id: 100,
    agent_hr_id: "M-1",
    agent_name: "Some Rep",
    ampm: "AM",
    attendance: 1,
    call_type: null,
    comment: null,
    contact_name: null,
    crm_save_date: "2026-06-20T09:00:00Z",
    crm_visit_id: 555,
    customer_name: null,
    double_crm_id: null,
    double_hr_id: null,
    double_name: null,
    id: "row-uuid",
    visit_date: "2026-07-01",
    visit_date_time: "2026-07-01T09:00:00Z",
    visit_type: 0,
    visit_type_description: "Regular Visit",
  };
  const mapped = mapVisitRow(dbRow);
  assert.equal(mapped.attendance, 1, "attendance is read back into VisitsReportRow, not dropped");
  assert.equal(mapped.crmSaveDate, "2026-06-20T09:00:00Z", "crmSaveDate round-trips unchanged");

  const mappedNullAttendance = mapVisitRow({ ...dbRow, attendance: null });
  assert.equal(mappedNullAttendance.attendance, null, "a null attendance stays null, not NaN/0");
}
