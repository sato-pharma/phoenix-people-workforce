import assert from "node:assert/strict";

import { mapVisitRow as crmMapVisitRow, getVisitsReportData as crmGetVisitsReportData } from "../src/lib/crm/reads.ts";
import { getVisitsReportData, getVisitsReportExportRows, mapVisitRow } from "../src/lib/visits-report/service.ts";

// REC-079 (phase 2): src/lib/visits-report — the Visits Report's own door — run, not read.
//
// The folder is now a re-export of the CRM module (its own comment: kept so older importers keep
// working), and until 19 Nov 2026 a test only ever named its TYPES, which the runner erases. Its main
// rule, called through the folder's own door:
//
//   1. The report table and its download read ONE row mapper — the screen and the file can never say
//      two different things about the same visit.
//   2. A visit's type is the RESOLVED word, never the vendor's raw text: the vendor stores the literal
//      "Unknown" for eight different codes, so Public Holiday must not read the same as Admin Work.
//   3. A visit's time is the save time until a GPS check-in is matched, and a placeholder vendor stamp
//      is no time at all — never a midnight the rep did not work.

function vendorRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    agent_crm_id: 1399,
    agent_hr_id: "MR-41",
    agent_name: "Stand-in Rep ( Sohag 1 / A )",
    ampm: "PM",
    comment: null,
    contact_crm_id: 501,
    contact_name: "Dr Stand-in",
    crm_save_date: "2026-11-02T10:15:00+00:00",
    crm_visit_id: 98001,
    id: "visit-1",
    visit_date: "2026-11-02",
    visit_type: 0,
    visit_type_description: "Visit",
    ...overrides,
  };
}

export function runVisitsReportRowBehaviourTests(): void {
  // ── 1. One mapper for the table and the download ───────────────────────────────────────────────
  assert.equal(mapVisitRow, crmMapVisitRow, "HEADLINE: the Visits Report door hands out the CRM module's one mapper");
  assert.equal(getVisitsReportData, crmGetVisitsReportData, "the report data comes through the same door");
  assert.equal(typeof getVisitsReportExportRows, "function", "and so does the export");

  // ── 2. The resolved type, never the vendor's "Unknown" ─────────────────────────────────────────
  const holiday = mapVisitRow(vendorRow({ visit_type: -5, visit_type_description: "Unknown" }));
  const admin = mapVisitRow(vendorRow({ visit_type: -30, visit_type_description: "Unknown" }));
  assert.notEqual(holiday.visitTypeDescription, "Unknown", "HEADLINE: a public holiday never reads as the vendor's raw Unknown");
  assert.notEqual(
    holiday.visitTypeDescription,
    admin.visitTypeDescription,
    "two codes the vendor both calls Unknown read as two different things",
  );
  assert.equal(holiday.visitType, -5, "the numeric code is kept for the filter, which selects on it");

  // ── 3. Save time until a check-in is matched; a placeholder stamp is no time ───────────────────
  const visit = mapVisitRow(vendorRow({}));
  assert.equal(visit.visitTimeSource, "save_time", "no check-in has been matched yet, so the save time stands");
  assert.equal(visit.visitTime, "2026-11-02T10:15:00+00:00");
  assert.equal(visit.nearestCheckinTime, null);
  const unstamped = mapVisitRow(vendorRow({ crm_save_date: null }));
  assert.deepEqual([unstamped.visitTime, unstamped.visitTimeSource], [null, "none"], "a visit with no save time has no time, never an invented one");

  // The row keeps its people and its contact as numbers and names, never the vendor's strings.
  assert.equal(visit.agentCrmId, 1399);
  assert.equal(visit.crmVisitId, 98001);
  assert.equal(visit.double2CrmId, null, "a vendor row carries one partner column; the chain's second is empty");
}
