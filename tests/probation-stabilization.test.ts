import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";

// The Resignations UI became a self-contained module directory in the 2026-08-10 rebuild.
function readResignationsUiSource() {
  const dir = "src/components/resignations";
  return readdirSync(dir)
    .map((file) => readFileSync(`${dir}/${file}`, "utf8"))
    .join("\n");
}

// sameWorkforceLine is a zero-dependency pure function — safe to import directly
// in the test runner. canReadProbationEmployee lives in the full service (which pulls
// in Supabase, notification, and resignation dependencies that can't load under the
// alias-loader without stubs), so we test the line-matching behaviour via
// sameWorkforceLine directly — that IS the new logic under test.
import { sameWorkforceLine } from "../src/lib/workforce/hierarchy-resolver.ts";

export function runProbationStabilizationTests() {
  const serviceSource = readFileSync("src/lib/probation/service.ts", "utf8");
  const adminPageSource = readFileSync("app/(admin)/probation/page.tsx", "utf8");
  const portalPageSource = readFileSync("app/employee-portals/probation/page.tsx", "utf8");
  const exportRouteSource = readFileSync("app/api/exports/route.ts", "utf8");
  const permissionsSource = readFileSync("src/lib/auth/permissions.ts", "utf8");
  const workflowRouteSource = readFileSync("app/api/probation/[id]/workflow/route.ts", "utf8");
  const notificationProcessRouteSource = readFileSync("app/api/notifications/process/route.ts", "utf8");
  const scheduledNotificationProcessingSource = readFileSync("src/lib/notifications/scheduled-processing.ts", "utf8");
  const contractRenewalsCronSource = readFileSync("app/api/notifications/contract-renewals/route.ts", "utf8");
  const inAppNotificationsSource = readFileSync("src/lib/notifications/in-app.ts", "utf8");
  const portalServiceSource = readFileSync("src/lib/employee-portal/service.ts", "utf8");
  const resignationsSource = readFileSync("src/lib/resignations/service.ts", "utf8");
  const resignationsReportSource = readResignationsUiSource();
  const trackerSource = readFileSync("src/components/probation/probation-tracker.tsx", "utf8");

  assert.match(serviceSource, /export const getProbationRows = cache\(loadProbationRows\)/);
  assert.match(serviceSource, /function loadProbationRows\(access: AccessContext\)/);
  assert.match(serviceSource, /canReadProbationEmployee\(access, employee, viewer, employees\)/);
  assert.match(serviceSource, /export function canReadAllProbation/);
  assert.match(serviceSource, /canViewAllProbation\(access\) \|\| access\.role === "CEO"/);
  assert.match(serviceSource, /if \(canReadAllProbation\(access\)\) return true/);
  assert.match(adminPageSource, /isProbationAdministrator\(access\)/);
  assert.match(adminPageSource, /canReadAllProbation\(access\)/);
  assert.match(adminPageSource, /canCreate: canAdminister/);
  assert.match(adminPageSource, /canManageWorkflow: canAdminister/);
  assert.match(adminPageSource, /canExport: canViewAllProbation\(access\)/);
  assert.match(portalPageSource, /getProbationTrackerRows\(access\)/);
  assert.doesNotMatch(portalPageSource, /isDsm|isNsm/);
  assert.match(portalPageSource, /canSubmitManagerFeedback/);
  assert.match(permissionsSource, /Employee:\s*\{[\s\S]*?probation:\s*\["read"\]/);
  assert.match(permissionsSource, /"Medical Rep":\s*\{[\s\S]*?probation:\s*\["read"\]/);
  // Regional Manager gained `export` 2026-07-30 (owner-approved) together with canExportProbation.
  // Scoped, not company-wide: the file is built from getProbationRows, which filters every employee
  // through canReadProbationEmployee, so an RM downloads only their own subtree's med reps.
  assert.match(permissionsSource, /"Regional Manager":\s*\{[\s\S]*?probation:\s*\["read", "export"\]/);
  assert.match(permissionsSource, /Manager:\s*\{[\s\S]*?probation:\s*\["read"\]/);

  assert.match(exportRouteSource, /assertCanExportProbation\(access\)/);
  assert.match(exportRouteSource, /getProbationRows\(access\)/);

  // ── Scoped probation export (2026-07-30) ───────────────────────────────────────────────
  // District/Regional/National Sales Manager may export, but ONLY their own scoped rows. Two
  // invariants keep that honest and both must hold:
  //   1. assertCanExportProbation gates on canExportProbation, NOT canViewAllProbation. Before this
  //      it used canViewAllProbation, which excludes all three — so DM/NSM carried an `export`
  //      grant in the matrix that the endpoint refused, and the matrix overstated their access.
  //   2. canViewAllProbation itself must NOT gain those roles. It is the company-wide predicate; if
  //      a field role leaked into it they would export every med rep in the company, not their own.
  assert.match(serviceSource, /export function canExportProbation/);
  assert.match(
    serviceSource,
    /assertCanExportProbation[\s\S]{0,320}if \(!canExportProbation\(access\)\)/,
    "assertCanExportProbation must gate on canExportProbation (the scoped predicate), not canViewAllProbation",
  );
  const companyWideProbationBlock = serviceSource.match(
    /export function canViewAllProbation[\s\S]*?\n\}/,
  );
  assert.ok(companyWideProbationBlock, "canViewAllProbation must still exist");
  for (const fieldRole of ["District Manager", "Regional Manager", "National Sales Manager"]) {
    assert.doesNotMatch(
      companyWideProbationBlock![0],
      new RegExp(fieldRole),
      `${fieldRole} must never enter canViewAllProbation — that would turn a subtree-scoped export into a company-wide one`,
    );
  }
  // The portal button must be driven by the same predicate the endpoint enforces, so it can never
  // render for someone /api/exports would 403.
  assert.match(portalPageSource, /canExport=\{canExportProbation\(access\)\}/);

  assert.match(serviceSource, /allowedWorkflowActions/);
  assert.match(serviceSource, /validateWorkflowTransition/);
  // Cairo/UTC timezone fix (2026-07-25): service.ts's own local probationDays=90 /
  // baseProbationEndDate() / currentProbationEndDate() were a second, independent
  // reimplementation of probation/date.ts's canonical (owner-locked, hire+90-day) rule — and,
  // unlike the canonical module, anchored "today" to the server's local/UTC midnight instead of
  // Africa/Cairo. Consolidated onto the canonical, now Cairo-aware helpers instead of pinning
  // the duplicate that used to live here.
  assert.match(
    serviceSource,
    /import \{\s*probationDaysRemaining,\s*probationEndDate as canonicalProbationEndDate,\s*\} from "@\/lib\/probation\/date";/,
    "probation/service.ts must import the canonical probation-duration helpers instead of reimplementing them",
  );
  assert.doesNotMatch(serviceSource, /const probationDays = 90/, "the duplicate local probationDays constant must not come back");
  assert.doesNotMatch(serviceSource, /function baseProbationEndDate/, "the duplicate local baseProbationEndDate() must not come back");
  assert.doesNotMatch(serviceSource, /function currentProbationEndDate/, "the duplicate local currentProbationEndDate() must not come back");
  assert.doesNotMatch(serviceSource, /probation\?\.status === extensionProbationStatus/);
  assert.doesNotMatch(serviceSource, /Extension end date must be later than the current probation end date/);
  assert.match(serviceSource, /getProbationReminderSchedule/);
  assert.match(serviceSource, /lifecycleRiskWindows\.probationWarningDays/);
  assert.match(serviceSource, /lifecycleRiskWindows\.probationCriticalDays/);
  assert.match(serviceSource, /lifecycleRiskWindows\.probationRiskDays/);
  assert.match(serviceSource, /resolveActiveHrApproverHrIds/, "HR approvers must be resolved by role, not hardcoded IDs");
  assert.doesNotMatch(serviceSource, /"HR Manager"/, "\"HR Manager\" is a job title, not an app_auth_users.role value — it must never appear in a role-array literal");
  assert.doesNotMatch(serviceSource, /phase6HrApproverHrIds/, "hardcoded approver IDs must be removed from probation service");
  assert.match(serviceSource, /probationWorkflowApproverHrIds/);
  assert.match(serviceSource, /Direct Manager/);
  assert.match(serviceSource, /Manager of Manager/);
  assert.match(serviceSource, /HR Pilot Approver/);
  assert.doesNotMatch(serviceSource, /loadHrAndTrainingReminderRecipients/);
  assert.doesNotMatch(serviceSource, /\.in\("role", \["HR Specialist", "Super Admin", "Training Manager"\]\)/);
  assert.doesNotMatch(serviceSource, /recipient_emails/);
  assert.doesNotMatch(serviceSource, /recipients:\s*\[employee\.hrId\]/);
  assert.match(serviceSource, /processDueProbationReminderEvents/);
  assert.match(serviceSource, /eventType:\s*"reminder_due"/);
  assert.match(serviceSource, /workflowApproverHrIds:\s*probationWorkflowApproverHrIds/);
  assert.match(serviceSource, /ctaLabel:\s*"Open Probation Review"/);
  assert.match(serviceSource, /\/api\/probation\/redirect/);
  // SCOPE LEAK FIX (2026-07-19): notifyProbationWorkflow now resolves an EXPLICIT, dynamically
  // role-resolved recipientHrId per notification (DM + NSM chain-walk + Super Admin + CEO) instead of
  // relying on the generic cross-module governance resolver, whose department-based org-scope match
  // leaked another line's probationer's case-status update to up to 98 active users company-wide. The
  // ORIGINAL intent of this guard — no HARDCODED/literal recipient list — is preserved by the assertions
  // below; a dynamically role-resolved recipientHrId is the fix, not the regression it used to guard.
  assert.doesNotMatch(serviceSource, /recipients:\s*\[/, "no hardcoded literal recipient array");
  assert.match(serviceSource, /recipientHrIds\.map\(\(recipientHrId\)/, "notifyProbationWorkflow sends one explicit notification per dynamically-resolved recipient");
  assert.doesNotMatch(serviceSource, /Approve in Telegram|Reject in Telegram|callback_query/);
  assert.match(serviceSource, /ensureSystemProbationReview/);

  // ── SCOPE LEAK FIX (owner report 2026-07-19): probation case-status notifications must be
  // line-scoped, never routed through the generic cross-module governance resolver's
  // department-based org-scope match (department_id groups the ENTIRE field-sales org under one id
  // in this data, not per line — that leaked another line's probationer's status to up to 98 active
  // users company-wide, e.g. an Anti Infective rep's update reaching Pedia/CNS NSMs and reps). ──
  assert.match(
    serviceSource,
    /async function notifyProbationWorkflow\(\s*record: ProbationWorkflowRecord,\s*employee: EmployeeScopeRow,\s*directory: EmployeeScopeRow\[\]/,
    "notifyProbationWorkflow takes the subject employee + directory so it can resolve its own scoped recipients",
  );
  assert.match(
    serviceSource,
    /const \[\{ nsmHrIds \}, hrApproverHrIds, ceoHrIds\] = await Promise\.all\(\[\s*resolveFeedbackExtraRecipients\(employee, directory\)/,
    "reuses the already-correct NSM management-chain walk (resolveFeedbackExtraRecipients), not a department/line broad match",
  );
  assert.doesNotMatch(
    serviceSource,
    /await notifyProbationWorkflow\(record, employee\.displayName/,
    "the old call signature (subject name only, no scoped recipient resolution) must not reappear",
  );
  assert.match(
    serviceSource,
    /await notifyProbationWorkflow\(record, employee, employees, employee\.displayName/,
    "case-creation call site passes the subject employee + directory for scoped recipient resolution",
  );
  assert.match(
    serviceSource,
    /idempotencyKey: `probation:\$\{record\.employeeHrId\}:\$\{record\.status\}:\$\{recipientHrId\}`/,
    "idempotency key is per (case, status, recipient) — each explicit recipient gets its own dedupe key",
  );
  assert.match(notificationProcessRouteSource, /runScheduledNotificationProcessing/);
  assert.match(scheduledNotificationProcessingSource, /processDueProbationReminderEvents/);
  assert.match(scheduledNotificationProcessingSource, /processNotificationOutbox/);
  assert.match(contractRenewalsCronSource, /runScheduledNotificationProcessing/);
  assert.match(inAppNotificationsSource, /\.overlaps\("recipients"/);
  assert.match(inAppNotificationsSource, /mapInAppNotificationRows/);
  assert.match(portalServiceSource, /recipients\.cs/);
  assert.match(portalServiceSource, /category.*probation/);
  assert.match(workflowRouteSource, /expectedUpdatedAt/);
  assert.match(workflowRouteSource, /status: 409/);
  assert.match(workflowRouteSource, /"pass"/);
  assert.match(workflowRouteSource, /"terminate"/);
  assert.doesNotMatch(workflowRouteSource, /"extend"/);
  assert.doesNotMatch(workflowRouteSource, /"upload_letter"/);
  assert.doesNotMatch(workflowRouteSource, /approve_/);
  assert.doesNotMatch(workflowRouteSource, /"complete"/);

  assert.match(serviceSource, /resignEmployeeAndOpenVacancy/);
  assert.match(serviceSource, /\.from\("notification_events"\)/);
  assert.match(serviceSource, /if \(error\) throw error/);
  assert.match(resignationsSource, /vacancyCodeFromEmployee/);
  assert.match(resignationsSource, /Termination\/vacancy reference/);
  assert.match(resignationsSource, /phx_resign_employee_and_open_vacancy/);
  // The 2026-08-10 ground-up rebuild dropped the literal heading "Terminated Employees" — the
  // module has no separate terminated table any more (owner decision: exits are highlighted
  // inside the normal queue). The invariant this guard actually protects — that a terminated exit
  // still shows up on the Resignations page, not a standalone termination system — is what's
  // checked here instead. Also checked directly for isTerminatedResignation() in
  // tests/resignations-view-model.test.ts.
  assert.match(resignationsReportSource, /isTerminatedResignation/);
  assert.match(resignationsReportSource, /["']Terminated["']/);

  assert.match(trackerSource, /SelectedWorkflowAction/);
  assert.match(trackerSource, /Type HR ID to confirm termination/);
  assert.match(trackerSource, /expectedUpdatedAt: workflow\.updatedAt/);
  assert.match(trackerSource, /Start review/);
  assert.match(trackerSource, /Managers Feedback in Probation Period/);
  assert.match(trackerSource, /Feedback Text/);
  assert.doesNotMatch(trackerSource, /Approve extension/);
  assert.doesNotMatch(trackerSource, /Complete decision/);
  assert.doesNotMatch(trackerSource, /Create Probation Evaluation/);
  assert.doesNotMatch(trackerSource, /action === "extend"/);
  assert.doesNotMatch(trackerSource, /action === "upload_letter"/);
  assert.doesNotMatch(trackerSource, /Attach letter/);
  assert.doesNotMatch(readFileSync("app/api/probation/route.ts", "utf8"), /probationEndDate/);
  assert.doesNotMatch(trackerSource, /onClick=\{\(\) => runWorkflow\(row,/);

  // ── Line-scoped probation matching must prefer numeric line_id (canonical
  //    sameWorkforceLine), not text-only lineName — mirrors Coaching/Double-Visit-Analytics. ──
  assert.match(serviceSource, /import \{ sameWorkforceLine \} from "@\/lib\/workforce\/hierarchy-resolver"/);
  assert.match(serviceSource, /return sameWorkforceLine\(employee, viewer\)/);
  assert.doesNotMatch(
    serviceSource,
    /normalizeLineName\(employee\.lineName\)/,
    "Probation line matching must not fall back to the old text-only isSameLine implementation.",
  );

  const adminProbationPageSource = readFileSync("app/(admin)/probation/page.tsx", "utf8");
  assert.match(adminProbationPageSource, /canViewAllProbation\(access\)/);

  // ── Runtime: sameWorkforceLine is the new core of isSameLine in probation service. ──
  // 1) Same line_id matches even when lineName text is stale/differently-cased.
  assert.equal(
    sameWorkforceLine(
      { lineId: 1, lineName: "Anti Infective" },
      { lineId: 1, lineName: "ANTI-INFECTIVE (legacy)" },
    ),
    true,
    "same line_id must match regardless of stale lineName text",
  );

  // 2) Different line_id must NOT match even when both lineName values are blank.
  assert.equal(
    sameWorkforceLine({ lineId: 1, lineName: null }, { lineId: 2, lineName: null }),
    false,
    "different line_id must not match even when lineName coincidentally matches (both null)",
  );

  // 3) Neither side has line_id → normalized lineName text fallback preserves legacy behaviour.
  assert.equal(
    sameWorkforceLine({ lineName: "Pedia" }, { lineName: "pedia" }),
    true,
    "when no line_id is present, normalized lineName text fallback must still match",
  );
  assert.equal(
    sameWorkforceLine({ lineName: "Cardiovascular" }, { lineName: "pedia" }),
    false,
    "when no line_id, different normalized lineName must not match",
  );

  // 4) canViewAllProbation grants TM + MM company-wide — verified at source level.
  assert.match(
    serviceSource,
    /canViewAllProbation[\s\S]{0,400}Training Manager[\s\S]{0,200}Marketing Manager|canViewAllProbation[\s\S]{0,400}Marketing Manager[\s\S]{0,200}Training Manager/,
    "canViewAllProbation must include both Training Manager and Marketing Manager",
  );
}
