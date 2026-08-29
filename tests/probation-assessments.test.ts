import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEFAULT_PROBATION_CONFIG } from "../src/lib/probation/intelligence/config.ts";
import { computeSfeEvidence } from "../src/lib/probation/intelligence/sfe-evidence.ts";
import {
  canSubmitSfeAssessment,
  canSubmitHrAssessment,
  canSeeConfidentialNote,
} from "../src/lib/probation/intelligence/assessments.ts";

function src(p: string) { return readFileSync(p, "utf8"); }

export function runProbationAssessmentsTests() {
  // ── SFE evidence aggregation (P5-T01) ──
  {
    const visits = [
      { visit_date: "2026-06-01", contact_crm_id: 1 },
      { visit_date: "2026-06-01", contact_crm_id: 2 },
      { visit_date: "2026-06-01", contact_crm_id: 2 },
      { visit_date: "2026-06-02", contact_crm_id: 3 },
      { visit_date: "2026-06-02", contact_crm_id: null },
    ];
    const checkins = [
      { check_date: "2026-06-01T06:30:00Z", contact_crm_id: 1 },
      { check_date: "2026-06-01T09:00:00Z", contact_crm_id: 2 },
      { check_date: "2026-06-02T07:15:00Z", contact_crm_id: 3 },
      { check_date: "2026-06-02T10:00:00Z", contact_crm_id: 3 },
    ];
    const ev = computeSfeEvidence(visits, checkins, { from: "2026-06-01", to: "2026-06-10" }, "2026-07-13T00:00:00Z");

    assert.equal(ev.totalVisits, 5);
    assert.equal(ev.activeVisitDays, 2, "distinct visit days");
    assert.equal(ev.distinctCustomers, 3, "distinct contact ids (null excluded)");
    assert.equal(ev.unmappedContactVisits, 1, "the 1 null-contact visit is counted as unmapped");
    assert.equal(ev.checkinCount, 4);
    assert.equal(ev.daysWithCheckin, 2);

    const byKey = Object.fromEntries(ev.metrics.map((m) => [m.key, m]));
    assert.equal(byKey.call_rate.value, 2.5, "5 visits / 2 active days");
    assert.equal(byKey.checkin_compliance.value, 0.8, "4 check-ins / 5 visits");
    assert.equal(byKey.customer_coverage.value, 3);
    // Window 2026-06-01..2026-06-10 = 10 days; 2 active → 20%.
    assert.equal(byKey.activity_consistency.value, 20);
    assert.ok(byKey.start_time.available && byKey.start_time.value !== null, "start-time computed from check-ins");
    // Plan adherence is honestly unavailable, not faked.
    assert.equal(byKey.plan_adherence.available, false);
    assert.equal(byKey.plan_adherence.value, null);
    assert.match(byKey.customer_coverage.note ?? "", /1 of 5 visits have an unmapped contact/, "coverage note surfaces the unmapped count");
  }

  // Owner-reported SFE bug (2026-07-17): contact_crm_id = 0 is the CRM "unmapped/unspecified contact"
  // sentinel — it must NOT count as a real customer (matches crm/master.ts). A rep whose visits are
  // entirely unmapped previously read "1 distinct customer"; it must read 0.
  {
    const allUnmapped = [
      { visit_date: "2026-06-01", contact_crm_id: 0 },
      { visit_date: "2026-06-02", contact_crm_id: 0 },
      { visit_date: "2026-06-03", contact_crm_id: 0 },
    ];
    const ev = computeSfeEvidence(allUnmapped, [], { from: "2026-06-01", to: "2026-06-10" }, "t");
    assert.equal(ev.distinctCustomers, 0, "the 0 unmapped-contact sentinel is NOT a customer (was mis-counted as 1)");
    assert.equal(ev.unmappedContactVisits, 3, "all-zero-contact visits are all unmapped");
    const byKey = Object.fromEntries(ev.metrics.map((m) => [m.key, m]));
    assert.equal(byKey.customer_coverage.value, 0);
    assert.match(byKey.customer_coverage.note ?? "", /3 of 3 visits have an unmapped contact/, "note explains the 0 coverage");
  }

  // Mixed real + unmapped: only the real (non-zero) contacts count.
  {
    const mixed = [
      { visit_date: "2026-06-01", contact_crm_id: 7 },
      { visit_date: "2026-06-01", contact_crm_id: 0 },
      { visit_date: "2026-06-02", contact_crm_id: 9 },
      { visit_date: "2026-06-02", contact_crm_id: null },
    ];
    const ev = computeSfeEvidence(mixed, [], { from: "2026-06-01", to: "2026-06-10" }, "t");
    assert.equal(ev.distinctCustomers, 2, "only 7 and 9 are real customers");
    assert.equal(ev.unmappedContactVisits, 2, "the 0 and null contacts are unmapped");
  }

  // Empty data → metrics null/unavailable, never throws.
  {
    const ev = computeSfeEvidence([], [], { from: "2026-06-01", to: "2026-06-10" }, "t");
    const byKey = Object.fromEntries(ev.metrics.map((m) => [m.key, m]));
    assert.equal(ev.totalVisits, 0);
    assert.equal(byKey.call_rate.value, null);
    assert.equal(byKey.start_time.available, false);
  }

  // ── Role auth (P5-T05) ──
  const sfe = { role: "SFE Manager" as const, scope: "company" as const };
  const admin = { role: "Super Admin" as const, scope: "company" as const };
  const dm = { role: "District Manager" as const, scope: "team" as const };
  const ceo = { role: "CEO" as const, scope: "company" as const };

  assert.equal(canSubmitSfeAssessment(sfe), true, "SFE Manager submits SFE");
  assert.equal(canSubmitSfeAssessment(admin), true, "admin submits SFE");
  assert.equal(canSubmitSfeAssessment(dm), false, "DM cannot submit SFE");

  assert.equal(canSubmitHrAssessment(admin), true, "HR admin submits HR");
  assert.equal(canSubmitHrAssessment(sfe), false, "SFE Manager cannot submit HR");
  assert.equal(canSubmitHrAssessment(dm), false, "DM cannot submit HR");

  // ── Confidential redaction (P5-T04) ──
  assert.equal(canSeeConfidentialNote(ceo), true, "CEO sees confidential notes");
  assert.equal(canSeeConfidentialNote(admin), true, "HR admin sees confidential notes");
  assert.equal(canSeeConfidentialNote(sfe), false, "SFE Manager does not see confidential notes");
  assert.equal(canSeeConfidentialNote(dm), false, "DM does not see confidential notes");

  // ── HR available by default for this field-force module (P5-T03) ──
  // Field reps (Med Reps + DMs) have no fingerprint attendance, so HR is NOT attendance-gated.
  assert.equal(DEFAULT_PROBATION_CONFIG.hrAssessmentEnabled, true, "HR assessment enabled by default");
  const svc = src("src/lib/probation/intelligence/assessments.ts");
  // The admin switch still guards submission (disable path).
  assert.match(svc, /if \(!config\.hrAssessmentEnabled\)[\s\S]*?Blocked: the HR assessment is currently disabled/,
    "HR submit refused when an admin disables it");
  assert.match(svc, /status: config\.hrAssessmentEnabled \? "pending" : "unavailable"/,
    "HR component reports pending when enabled, unavailable when disabled");
  // Confidential redaction happens in the mapper based on the viewer.
  assert.match(svc, /confidentialNote: redactConfidential \? null : row\.confidential_note/,
    "confidential note redacted for non-HR/CEO");
  // System evidence kept separate from the human score.
  assert.match(svc, /an override reason is required when overriding system evidence/,
    "overrides require a reason (calculated vs manual separation)");

  // HR evidence: field-relevant auto signals + honest N/A for head-office attendance.
  const hrEv = src("src/lib/probation/intelligence/hr-evidence.ts");
  assert.match(hrEv, /not applicable to field roles/, "fingerprint attendance marked N/A for field roles");
  assert.match(hrEv, /HR judgment \(manual entry\)/, "conduct/documentation/warnings are manual HR judgment");
  // Deduction decisions read the UNIFIED module post-cutover, NOT the legacy governance table.
  // A regression back to `deduction_decisions` would silently freeze the count at the pre-cutover
  // total (see the Track C / mossy-ocean cutover), so pin the repoint hard.
  assert.doesNotMatch(hrEv, /\.from\("deduction_decisions"\)/,
    "deduction count must not read the legacy deduction_decisions table");
  assert.match(hrEv, /\.from\("deductions_decisions"\)/,
    "deduction count reads the unified deductions_decisions table");
  // Employee is keyed by the alias-aware COMPACT key on the joined candidate — a plain .eq/.ilike on
  // the mixed-case raw HR id under-returns.
  assert.match(hrEv, /compactDeductionsHrId\(hrId\)/, "deduction count resolves the alias-aware compact HR key");
  assert.match(hrEv, /deductions_candidates!inner\(/, "deduction count inner-joins its candidate");
  assert.match(hrEv, /employee_hr_id_compact/, "deduction count filters candidates by employee_hr_id_compact");
  // Only ACTUAL decisions count — a fresh candidate's auto "Pending" row is "detected", not "decided".
  assert.match(hrEv, /\.neq\("decision_status", "Pending"\)/, "Pending decisions excluded from the count");
  // Superseded (corrected/retired) candidates are excluded so a re-collect cannot double-count.
  assert.match(hrEv, /\.is\("deductions_candidates\.superseded_at", null\)/,
    "only live (non-superseded) candidates counted");

  // Routes gate + CSRF.
  const sfeRoute = src("app/api/probation/cases/[caseId]/assessments/sfe/route.ts");
  assert.match(sfeRoute, /assertSameOriginMutation/, "SFE submit CSRF-guarded");
  const hrRoute = src("app/api/probation/cases/[caseId]/assessments/hr/route.ts");
  assert.match(hrRoute, /assertSameOriginMutation/, "HR submit CSRF-guarded");
}
