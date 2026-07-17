import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { computeProbationScore } from "../src/lib/probation/intelligence/scoring.ts";
import { DEFAULT_PROBATION_CONFIG } from "../src/lib/probation/intelligence/config.ts";

function src(p: string) { return readFileSync(p, "utf8"); }

// Regression guards for the confirmed pre-merge audit findings (F1–F13).
export function runProbationAuditFixesTests() {
  // ── F5: a role requirement of 0 must NOT permanently block decision-readiness ──
  const zeroReqConfig = {
    ...DEFAULT_PROBATION_CONFIG,
    requirements: { dm: 0, tm: 0, pm_gpm: 0, nsm: 0 },
    hrAssessmentEnabled: true,
  };
  const readyWithZeroReqs = computeProbationScore(
    { feedbacks: [], sfeScore: 8, hrScore: 7 },
    zeroReqConfig,
  );
  assert.equal(readyWithZeroReqs.decisionReady, true, "F5: required=0 roles are satisfied, case is decision-ready");

  // ── F6: disabling the HR assessment drops HR as a requirement (does not block readiness) ──
  const hrDisabledConfig = {
    ...DEFAULT_PROBATION_CONFIG,
    requirements: { dm: 0, tm: 0, pm_gpm: 0, nsm: 0 },
    hrAssessmentEnabled: false,
  };
  const readyWithHrDisabled = computeProbationScore(
    { feedbacks: [], sfeScore: 8, hrScore: null },
    hrDisabledConfig,
  );
  assert.equal(readyWithHrDisabled.decisionReady, true, "F6: HR disabled => HR not required, case can be decision-ready");
  // And when HR IS enabled but missing, HR still blocks readiness (the fix is scoped).
  const blockedByHr = computeProbationScore(
    { feedbacks: [], sfeScore: 8, hrScore: null },
    { ...DEFAULT_PROBATION_CONFIG, requirements: { dm: 0, tm: 0, pm_gpm: 0, nsm: 0 }, hrAssessmentEnabled: true },
  );
  assert.equal(blockedByHr.decisionReady, false, "F6: HR enabled + missing still blocks readiness");

  // ── F1: dev-action PATCH requires company-wide read (not bare probation:read), and is audited ──
  const devRoute = src("app/api/probation/development-actions/[id]/route.ts");
  assert.match(devRoute, /canDecideProbation\(access\)/, "F1/R4: dev-action PATCH gated to decision authority");
  const devSvc = src("src/lib/probation/intelligence/dev-actions.ts");
  assert.match(devSvc, /entityType: "probation_development_action"/, "F1: dev-action update is audited");

  // ── F4: case report/score/assessments GET require company-wide read or SFE Manager ──
  for (const p of ["report", "score", "assessments"]) {
    const r = src(`app/api/probation/cases/[caseId]/${p}/route.ts`);
    assert.match(r, /!canReadAllProbation\(access\) && !canSubmitSfeAssessment\(access\)/, `F4: ${p} GET enforces scope`);
  }

  // ── F2: probation Telegram is generic-only ──
  const gov = src("src/lib/notifications/telegram-governance.ts");
  assert.match(gov, /genericOnly: true, module: "probation"/, "F2: probation Telegram genericOnly");

  // ── F7/F8: decision confirms the write landed, and releases the slot on failure for recovery ──
  const decision = src("src/lib/probation/intelligence/decision.ts");
  assert.match(decision, /if \(!decidedRow\)/, "F7: aborts side effects if the decision write changed no row");
  assert.match(decision, /side_effects_applied_at: null/, "F8: releases the side-effect slot on mutation failure");
  assert.match(decision, /re-drive/i, "F8: recovery path re-drives stranded side effects");

  // ── F9: confidential note preserved for non-privileged submitters ──
  const assess = src("src/lib/probation/intelligence/assessments.ts");
  assert.match(assess, /resolveConfidentialNote/, "F9: confidential note is preserved, not blindly nulled");

  // ── F10: milestone email only within the recent grace window ──
  const emails = src("src/lib/probation/intelligence/probation-emails.ts");
  assert.match(emails, /day > m\.day \+ MILESTONE_GRACE_DAYS/, "F10: milestone emails gated to a recent window");

  // ── F11: probation termination suppresses the resignation-workflow notification ──
  assert.match(decision, /suppressWorkflowNotification: true/, "F11: terminate suppresses the resignation notification");
  const resign = src("src/lib/resignations/service.ts");
  assert.match(resign, /options\?\.suppressWorkflowNotification/, "F11: resign honors the suppression flag");

  // ── F12: ingest-issue dedup is NULL-aware on a content key ──
  const mig = src("supabase/migrations/20260713132000_probation_dv_ingest_issues.sql");
  assert.match(mig, /unique nulls not distinct \(crm_visit_id, reason, employee_hr_id, evaluator_hr_id, dv_date\)/, "F12: null-aware content-key dedup");
  const dvSync = src("src/lib/probation/intelligence/dv-sync.ts");
  assert.match(dvSync, /onConflict: "crm_visit_id,reason,employee_hr_id,evaluator_hr_id,dv_date"/, "F12: upsert targets the content key");

  // ── F13: owner name, provisioning-failure surface, cron guards ──
  const control = src("src/components/probation/development-actions-control.tsx");
  assert.match(control, /action\.ownerName \?\? action\.ownerHrId/, "F13: dev-action owner shown by name");
  const prov = src("src/lib/probation/provisioning.ts");
  assert.match(prov, /countUnresolvedProvisioningFailures/, "F13: provisioning failures have a reader");
  assert.match(dvSync, /isProbationSchemaMissing/, "F13: dv-sync skips quietly when tables are missing");
  const sla = src("src/lib/probation/intelligence/feedback-sla-reminders.ts");
  assert.match(sla, /isProbationSchemaMissing/, "F13: SLA sweep skips quietly when tables are missing");

  // ── F3: go-live backfill is wired behind a probation-admin route (dry-run by default) ──
  const backfillRoute = src("app/api/probation/backfill/route.ts");
  assert.match(backfillRoute, /isProbationAdministrator\(access\)/, "F3: backfill route is admin-gated");
  assert.match(backfillRoute, /dryRun: !confirm/, "F3: backfill is dry-run unless confirmed");
}
