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

  // Routes gate + CSRF.
  const sfeRoute = src("app/api/probation/cases/[caseId]/assessments/sfe/route.ts");
  assert.match(sfeRoute, /assertSameOriginMutation/, "SFE submit CSRF-guarded");
  const hrRoute = src("app/api/probation/cases/[caseId]/assessments/hr/route.ts");
  assert.match(hrRoute, /assertSameOriginMutation/, "HR submit CSRF-guarded");
}
