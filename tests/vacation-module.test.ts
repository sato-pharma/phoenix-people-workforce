import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const serviceSource = readFileSync(
  new URL("../src/lib/vacation/service.ts", import.meta.url),
  "utf8",
);
const vacationEmailSource = readFileSync(
  new URL("../src/lib/vacation/email.ts", import.meta.url),
  "utf8",
);
const navigationSource = readFileSync(
  new URL("../src/config/system-navigation.ts", import.meta.url),
  "utf8",
);
const migrationSource = readFileSync(
  new URL("../supabase/migrations/20260517040154_v2_vacation_management.sql", import.meta.url),
  "utf8",
);
const policyMigrationSource = readFileSync(
  new URL("../supabase/migrations/20260519203733_vacation_request_policy_updates.sql", import.meta.url),
  "utf8",
);
const hrFinalDecisionMigrationSource = readFileSync(
  new URL("../supabase/migrations/20260521093411_vacation_hr_final_decision_policy_warnings.sql", import.meta.url),
  "utf8",
);
const weeklyOffControlMigrationSource = readFileSync(
  new URL("../supabase/migrations/20260521105458_vacation_weekly_off_control.sql", import.meta.url),
  "utf8",
);
const compensatoryMigrationSource = readFileSync(
  new URL("../supabase/migrations/20260521114136_vacation_compensatory_day.sql", import.meta.url),
  "utf8",
);
const partialPaidMigrationSource = readFileSync(
  new URL("../supabase/migrations/20260521115439_vacation_partial_paid_balance.sql", import.meta.url),
  "utf8",
);
const integrityMigrationSource = readFileSync(
  new URL("../supabase/migrations/20260523220000_vacation_integrity_hardening.sql", import.meta.url),
  "utf8",
);
const governanceMigrationSource = readFileSync(
  new URL("../supabase/migrations/20260531172108_vacation_enterprise_governance.sql", import.meta.url),
  "utf8",
);
const complianceMigrationSource = readFileSync(
  new URL("../supabase/migrations/20260531202329_vacation_leave_governance_compliance.sql", import.meta.url),
  "utf8",
);
const parallelApprovalMigrationSource = readFileSync(
  new URL("../supabase/migrations/20260606091523_vacation_parallel_approval_steps.sql", import.meta.url),
  "utf8",
);
const typesSource = readFileSync(
  new URL("../src/lib/vacation/types.ts", import.meta.url),
  "utf8",
);
const routeSource = readFileSync(
  new URL("../app/api/vacations/requests/route.ts", import.meta.url),
  "utf8",
);
const adminRouteSource = readFileSync(
  new URL("../app/api/vacations/requests/admin/route.ts", import.meta.url),
  "utf8",
);
const requestAdminRouteSource = readFileSync(
  new URL("../app/api/vacations/requests/[id]/route.ts", import.meta.url),
  "utf8",
);
const requestAttachmentRouteSource = readFileSync(
  new URL("../app/api/vacations/requests/[id]/attachments/[kind]/route.ts", import.meta.url),
  "utf8",
);
const requestTimelineRouteSource = readFileSync(
  new URL("../app/api/vacations/requests/[id]/timeline/route.ts", import.meta.url),
  "utf8",
);
const requestEvidenceReviewRouteSource = readFileSync(
  new URL("../app/api/vacations/requests/[id]/evidence-review/route.ts", import.meta.url),
  "utf8",
);
const vacationAuditExportRouteSource = readFileSync(
  new URL("../app/api/vacations/report/export/route.ts", import.meta.url),
  "utf8",
);
const dailyNotificationsRouteSource = readFileSync(
  new URL("../app/api/notifications/daily/route.ts", import.meta.url),
  "utf8",
);
const vercelConfigSource = readFileSync(
  new URL("../vercel.json", import.meta.url),
  "utf8",
);
const nationalHolidaysRouteSource = readFileSync(
  new URL("../app/api/vacations/national-holidays/route.ts", import.meta.url),
  "utf8",
);
const nationalHolidaysSource = readFileSync(
  new URL("../src/lib/vacation/national-holidays.ts", import.meta.url),
  "utf8",
);
const vacationRequestFormSource = readFileSync(
  new URL("../src/components/vacation/vacation-request-form.tsx", import.meta.url),
  "utf8",
);
const vacationReportSource = readFileSync(
  new URL("../src/components/vacation/vacation-report.tsx", import.meta.url),
  "utf8",
);
const vacationLayoutSource = readFileSync(
  new URL("../app/(admin)/layout.tsx", import.meta.url),
  "utf8",
);

export function runVacationModuleTests() {
  const submittedStart = serviceSource.indexOf("async function notifyVacationSubmittedByGovernance");
  const submittedEnd = serviceSource.indexOf("async function dispatchVacationSubmitted", submittedStart);
  const submittedBlock = serviceSource.slice(submittedStart, submittedEnd);

  assert.match(serviceSource, /const vacationRequestsTable = "v2_vacation_requests"/);
  assert.match(serviceSource, /const vacationApprovalStepsTable = "v2_vacation_approval_steps"/);

  // Guard: the dead/legacy leave engine (public.leave_* tables + phx_leave_* RPCs) must never be
  // referenced by live runtime code — the live engine is the v2_vacation_* family. The
  // workflow-registry MODULE KEY string "leave_requests" lives in workflow.ts (not scanned here)
  // and the live "leave-attachments" storage bucket are both intentionally allowed.
  const liveVacationRuntimeSources = [
    ["service", serviceSource],
    ["requests route", routeSource],
    ["admin route", adminRouteSource],
    ["request [id] route", requestAdminRouteSource],
    ["attachment route", requestAttachmentRouteSource],
    ["timeline route", requestTimelineRouteSource],
    ["evidence-review route", requestEvidenceReviewRouteSource],
    ["report export route", vacationAuditExportRouteSource],
    ["national-holidays route", nationalHolidaysRouteSource],
    ["request form", vacationRequestFormSource],
  ];
  const deadLeaveObjectPattern =
    /phx_leave_|employee_leave_balances|\bleave_transactions\b|\bleave_approvals\b|\bleave_audit_logs\b|from\(\s*["']leave_requests["']/;
  for (const [label, src] of liveVacationRuntimeSources) {
    assert.doesNotMatch(
      src,
      deadLeaveObjectPattern,
      `${label} must not reference the dead leave engine (use the v2_vacation_* tables)`,
    );
  }
  assert.match(parallelApprovalMigrationSource, /create table if not exists public\.v2_vacation_approval_steps/);
  assert.match(parallelApprovalMigrationSource, /step_key in \('direct_manager', 'manager_of_manager', 'hr'\)/);
  assert.match(parallelApprovalMigrationSource, /status in \('pending', 'approved', 'rejected'\)/);
  assert.match(parallelApprovalMigrationSource, /enable row level security/);
  assert.ok(submittedStart >= 0 && submittedEnd > submittedStart, "vacation submitted notifications must use a dedicated governed helper");
  assert.match(serviceSource, /resolveVacationParallelApprovalRecipients/, "vacation submit must resolve the exact parallel approval participants");
  assert.match(serviceSource, /\.in\("role", \["HR Manager", "Super Admin"\]\)/, "vacation HR approvers must be resolved by elevated role, not hardcoded IDs");
  assert.doesNotMatch(serviceSource, /vacationPilotHrApproverKeys/, "hardcoded approver keys must be removed from vacation service");
  assert.match(serviceSource, /createVacationApprovalSteps/, "vacation submit must create approval-step rows");
  assert.match(submittedBlock, /createSystemNotification\(\{/, "vacation submitted pilot must route through createSystemNotification");
  assert.match(submittedBlock, /eventType: "request_submitted"/, "vacation submitted pilot must use the engine policy event key");
  assert.match(submittedBlock, /input\.approvalRecipients\.map/, "vacation submitted pilot must notify exact approval-step recipients");
  assert.match(submittedBlock, /recipientHrId: recipient\.hrId/, "vacation submitted pilot must send only to resolved approvers");
  assert.match(submittedBlock, /recipientUserId: recipient\.userId/, "vacation submitted pilot must preserve approver login identity when available");
  assert.match(submittedBlock, /Approve in Phoenix/, "Telegram approval button must open Phoenix");
  assert.match(submittedBlock, /Reject in Phoenix/, "Telegram rejection button must open Phoenix");
  assert.match(submittedBlock, /\/leave-management\/vacation-decision\/\$\{encodeURIComponent\(input\.request\.id\)\}\?decision=approve/, "Telegram approve URL must be a Phoenix confirmation URL");
  // PR3: the sequential workflow (Annual/Other/Compensatory/Emergency) redirects email/Telegram to
  // the Vacation Action Center instead of approving directly; only legacy Sick keeps direct buttons.
  assert.match(submittedBlock, /Review Request/, "sequential workflow notifications use a Review Request redirect");
  assert.match(submittedBlock, /vacation-action-center\?requestId=/, "Review button opens the Vacation Action Center by request id");

  // Email-template wiring: sequential submit emails render from the user-edited "leave_request"
  // WYSIWYG template (sendVacationManagerDecisionEmail) and the generic notification's email
  // channel is dropped so there is no duplicate generic email. Legacy Sick keeps the generic email.
  assert.match(submittedBlock, /const submitEmail = sequential && primaryRecipient && primaryDeliverableEmail/, "sequential submit must send one templated leave_request email to the primary approver");
  assert.match(submittedBlock, /sendVacationManagerDecisionEmail\(\{/, "sequential submit must send the templated leave_request email");
  assert.match(submittedBlock, /cc: ccEmails/, "sequential submit email must CC visibility approvers instead of sending separate emails");
  assert.match(
    submittedBlock,
    /channels: sequential \|\| !isPrimaryEmailRecipient \? \["in_app", "telegram"\] : \["in_app", "email", "telegram"\]/,
    "sequential submit must drop the duplicate generic email channel (templated leave_request is the only submit email)",
  );
  assert.match(submittedBlock, /pickDeliverableEmail\(primaryRecipient\.email\)/, "templated submit email must guard the primary approver address against non-deliverable synthetic addresses");
  assert.match(submittedBlock, /reviewUrl: absoluteReviewUrl/, "templated submit email CTA must be the absolute Action Center review link");
  assert.doesNotMatch(submittedBlock, /Promise\.all\(\[notification, templatedEmail\]\)/, "vacation submit must not send a separate templated email per approver");

  // The dedicated vacation email senders must map to the edited templates and fully populate the
  // leave_request greeting ({{managerName}}) and hiring-date ({{date}}) placeholders, with a safe
  // plain-email fallback when a template has been deactivated/deleted.
  assert.match(vacationEmailSource, /templateKey: "leave_request"/, "manager submit email must use the leave_request template");
  assert.match(vacationEmailSource, /templateKey: approved \? "leave_approval" : "leave_rejection"/, "decision result email must use leave_approval / leave_rejection");
  assert.match(vacationEmailSource, /managerName: input\.managerName \|\| "Manager"/, "leave_request greeting placeholder {{managerName}} must be populated");
  assert.match(vacationEmailSource, /date: hireDate/, "leave_request {{date}} (hiring date) placeholder must be populated");
  assert.match(vacationEmailSource, /isTemplateUnavailableSkip/, "vacation emails must fall back to a plain send when the template is missing/inactive");
  assert.match(vacationEmailSource, /renderPhoenixEmailHtml/, "vacation fallback emails must use the shared Phoenix layout");
  assert.match(vacationEmailSource, /renderPhoenixEmailText/, "vacation fallback text must use the shared Phoenix text renderer");
  assert.doesNotMatch(vacationEmailSource, /const html = `<div/, "vacation fallback must not use a one-off raw HTML layout");
  assert.match(
    vacationEmailSource,
    /overrides: \{ cc: input\.cc, replaceRecipients: true, to: \[input\.managerEmail\] \}/,
    "leave_request routing must be one manager TO with visibility approvers in CC",
  );
  assert.match(
    vacationEmailSource,
    /overrides: \{ cc: input\.cc, replaceRecipients: true, to: \[input\.employeeEmail\] \}/,
    "decision result email routing is engine-owned (employee TO + approver CC), never the template's recipient rules",
  );

  // Decision dispatch must not double-email: the generic notification is in-app + Telegram only,
  // and the employee/approvers receive the templated leave_approval/leave_rejection email instead.
  const decisionStart = serviceSource.indexOf("async function dispatchVacationDecision");
  const decisionEnd = serviceSource.indexOf("async function resolveManagerEmail", decisionStart);
  assert.ok(decisionStart >= 0 && decisionEnd > decisionStart, "dispatchVacationDecision must exist as a dedicated helper");
  const decisionBlock = serviceSource.slice(decisionStart, decisionEnd);
  assert.match(decisionBlock, /channels: \["in_app", "telegram"\]/, "decision dispatch must suppress the generic email so only the templated decision email sends");
  assert.match(decisionBlock, /sendVacationDecisionResultEmail\(/, "decision dispatch must send the templated decision result email");
  assert.match(
    serviceSource,
    /This request must be reviewed in the Vacation Action Center; email approval links are disabled/,
    "token-based direct approval must be disabled for the sequential workflow",
  );
  assert.match(submittedBlock, /requestUrl: sequential \? actionCenterUrl : input\.href/, "vacation submitted metadata must include requestUrl for Telegram templates");
  assert.match(submittedBlock, /actionUrl: sequential \? actionCenterUrl : input\.href/, "vacation submitted metadata must include actionUrl for Telegram templates");
  assert.match(submittedBlock, /approveUrl/, "vacation submitted metadata must include approveUrl for Telegram templates");
  assert.match(submittedBlock, /rejectUrl/, "vacation submitted metadata must include rejectUrl for Telegram templates");
  assert.match(submittedBlock, /employeeName: input\.request\.employeeName/, "vacation submitted metadata must include employeeName");
  assert.match(submittedBlock, /employeeHrId: input\.request\.employeeHrId/, "vacation submitted metadata must include employeeHrId");
  assert.match(submittedBlock, /period/, "vacation submitted metadata must include period");
  assert.match(serviceSource, /\/leave-management\/vacation-report\?requestId=/, "vacation Telegram button must open the Phoenix vacation report page");
  assert.match(serviceSource, /getPendingVacationApprovalStepForActor/, "vacation decisions must be bound to a pending approval-step row");
  assert.match(serviceSource, /recordVacationApprovalStepDecision/, "vacation decisions must atomically decide one pending approval step");
  assert.match(serviceSource, /rejected \|\| allApproved/, "vacation request must finalize only on rejection or all approvals");
  assert.match(serviceSource, /dispatchVacationDecision\(\{ decision: input\.decision, directory, request: updated \}\)/, "final notifications must only send after terminal decision");
  assert.match(serviceSource, /getVacationDecisionConfirmationData/, "Telegram approval URLs must be backed by an authenticated Phoenix confirmation page");
  assert.match(serviceSource, /input\.request\.status !== "pending_manager"/);
  assert.match(serviceSource, /Forbidden: only assigned pending vacation approvers can decide this request/);
  assert.match(serviceSource, /accessMatchesHrId\(access, request\.managerHrId\)/);
  assert.match(serviceSource, /access\.scope === "system" \|\| access\.role === "Super Admin"/);
  assert.match(serviceSource, /\.in\("role", \["Super Admin"\]\)/);
  assert.match(serviceSource, /managerOfManagerHrId/);
  // CEO-direct-reports: the parallel chain requires only a direct manager; the
  // manager-of-manager step is included only when one exists (no manager above the CEO).
  assert.match(
    serviceSource,
    /\.\.\.\(managerOfManager\?\.hrId\s*\n\s*\?\s*\[/,
    "manager-of-manager approval step must be optional so direct reports to the top of the org can submit",
  );
  assert.doesNotMatch(
    serviceSource,
    /if \(!manager\?\.hrId \|\| !managerOfManager\?\.hrId\) \{/,
    "vacation submit must not hard-require a manager-of-manager (blocks CEO direct reports)",
  );
  assert.match(serviceSource, /getVacationPolicyWarnings/);
  assert.match(typesSource, /label: "Pending HR", value: "pending_hr"/);
  assert.match(serviceSource, /\.in\("vacation_type", \["annual", "emergency"\]\)/);
  assert.match(serviceSource, /leave-attachments/);
  assert.match(serviceSource, /Sick vacation requires an uploaded medical document/);
  assert.match(serviceSource, /Compensatory Day requires the event name/);
  assert.match(serviceSource, /Compensatory Day requires the first manager name/);
  assert.match(serviceSource, /Compensatory Day has expired/);
  assert.match(serviceSource, /Vacation requests cannot be submitted retroactively/);
  // Annual vacation may now start today: the old "must start from tomorrow" floor was removed
  // from validateVacationSubmissionDates. The retroactive guard above still blocks past dates,
  // and resolveSubmittedVacationType still reclassifies a single-day same-day annual to emergency.
  assert.doesNotMatch(serviceSource, /Annual vacation requests must start from tomorrow or later/);
  assert.match(serviceSource, /Vacation requests are not allowed directly before or directly after an official national holiday/);
  assert.match(serviceSource, /validateOfficialHolidayAdjacency/);
  assert.match(serviceSource, /createVacationRequestAsAdmin/);
  assert.match(serviceSource, /updateVacationRequestAsAdmin/);
  assert.match(serviceSource, /deleteVacationRequestAsAdmin/);
  assert.match(serviceSource, /assertVacationAdminManagement/);
  assert.match(serviceSource, /buildWeeklyOffPolicySnapshot/);
  assert.match(serviceSource, /weekly_off_policy_snapshot/);
  assert.match(serviceSource, /fetchVacationReportRowsFromDatabase/);
  assert.match(serviceSource, /\.range\(from, to\)/);
  assert.doesNotMatch(serviceSource, /\.limit\(1000\)/);
  assert.match(serviceSource, /createVacationAttachmentReviewUrl/);
  assert.match(serviceSource, /createSignedUrl/);
  assert.match(serviceSource, /\.rpc\("phx_vacation_report_rows"/);
  assert.match(serviceSource, /reviewVacationEvidence/);
  assert.match(serviceSource, /getVacationRequestTimeline/);
  assert.match(serviceSource, /generateVacationAuditExportWorkbook/);
  assert.match(serviceSource, /assertPermission\(access, "leave", "export"\)/);
  assert.match(serviceSource, /vacationAuditExportMaxRows = 5000/);
  assert.match(serviceSource, /buildVacationTimelineEntries/);
  assert.match(serviceSource, /fetchVacationEventsForRequests\(report\.rows\.map/);
  assert.doesNotMatch(serviceSource, /Promise\.all\(report\.rows\.map\(\(row\) => getVacationRequestTimeline/);
  assert.match(serviceSource, /Separation of duties requires a different HR or Super Admin actor/);
  assert.match(serviceSource, /vacationRetentionPolicyDefaults/);
  assert.match(serviceSource, /runVacationRetentionPurge/);
  assert.match(serviceSource, /runVacationSlaDaily/);
  assert.match(serviceSource, /Required vacation evidence must be accepted by HR before final HR approval/);
  assert.match(serviceSource, /buildVacationOverlapWarnings/);
  assert.match(serviceSource, /buildVacationDashboardData/);
  assert.match(serviceSource, /This email approval link is no longer valid/);
  assert.match(serviceSource, /An active vacation request already exists/);
  assert.match(serviceSource, /Manual admin record update/);
  assert.match(serviceSource, /Other vacation requires an explanation for HR review/);
  assert.match(serviceSource, /compensatoryAttachment/);
  assert.match(serviceSource, /\.eq\("vacation_type", input\.vacationType\)/);
  assert.match(serviceSource, /v2_vacation_weekly_off_policies/);
  assert.match(serviceSource, /getVacationControlData/);
  assert.match(serviceSource, /updateVacationWeeklyOffPolicy/);
  assert.match(serviceSource, /entityType: "vacation_weekly_off_policy"/);
  assert.match(serviceSource, /return "pending_manager"/);
  assert.match(serviceSource, /fetchWeeklyOffPolicyForTitle/);
  assert.match(routeSource, /request\.formData\(\)/);
  assert.match(routeSource, /assertSameOriginMutation/);
  assert.match(routeSource, /rejectOversizedVacationUploadRequest/);
  assert.match(routeSource, /rejectOversizedVacationFile/);
  assert.match(routeSource, /assertVacationRouteRateLimit/);
  assert.match(routeSource, /sickDocument/);
  assert.match(routeSource, /otherReason/);
  assert.match(routeSource, /compensatoryPhoto/);
  assert.match(adminRouteSource, /createVacationRequestAsAdmin/);
  assert.match(requestAdminRouteSource, /updateVacationRequestAsAdmin/);
  assert.match(requestAdminRouteSource, /deleteVacationRequestAsAdmin/);
  assert.match(requestAttachmentRouteSource, /createVacationAttachmentReviewUrl/);
  assert.match(requestAttachmentRouteSource, /NextResponse\.redirect/);
  assert.match(requestTimelineRouteSource, /getVacationRequestTimeline/);
  assert.match(requestEvidenceReviewRouteSource, /reviewVacationEvidence/);
  assert.match(requestEvidenceReviewRouteSource, /assertSameOriginMutation/);
  assert.match(requestEvidenceReviewRouteSource, /assertVacationRouteRateLimit/);
  assert.match(vacationAuditExportRouteSource, /generateVacationAuditExportWorkbook/);
  assert.match(vacationAuditExportRouteSource, /assertPermission\(access, "leave", "export"\)/);
  assert.match(vacationAuditExportRouteSource, /assertVacationRouteRateLimit/);
  assert.ok(
    vacationAuditExportRouteSource.indexOf('assertPermission(access, "leave", "export")') <
      vacationAuditExportRouteSource.indexOf("assertVacationRouteRateLimit({"),
    "Vacation audit export must assert export permission before rate limiting.",
  );
  assert.match(vacationAuditExportRouteSource, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.match(dailyNotificationsRouteSource, /runBirthdayNotifications/);
  assert.match(dailyNotificationsRouteSource, /runContractRenewalNotifications/);
  assert.match(dailyNotificationsRouteSource, /runVacationSlaDaily/);
  assert.match(nationalHolidaysRouteSource, /getEgyptianNationalHolidays/);
  assert.match(nationalHolidaysRouteSource, /assertPermission\(access, "leave", "read"\)/);
  assert.match(nationalHolidaysSource, /GOOGLE_CALENDAR_API_KEY/);
  assert.match(nationalHolidaysSource, /GOOGLE_HOLIDAY_CALENDAR_ID_EG/);
  assert.match(nationalHolidaysSource, /fetchGoogleHolidayCalendarIcs/);
  assert.match(nationalHolidaysSource, /parseGoogleHolidayIcs/);
  assert.match(nationalHolidaysSource, /calendar\.google\.com\/calendar\/ical/);
  assert.match(nationalHolidaysSource, /en\.eg#holiday@group\.v\.calendar\.google\.com/);
  assert.match(nationalHolidaysSource, /en\.egyptian#holiday@group\.v\.calendar\.google\.com/);
  assert.match(nationalHolidaysSource, /calendarCandidates/);
  assert.match(nationalHolidaysSource, /dateRangeIndex/);
  assert.match(nationalHolidaysSource, /mergeHolidayRows/);
  assert.match(nationalHolidaysSource, /https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars/);
  assert.match(nationalHolidaysSource, /holidayFetchTimeoutMs/);
  assert.match(nationalHolidaysSource, /holidayCacheTtlMs/);
  assert.match(nationalHolidaysSource, /AbortController/);
  assert.match(vacationRequestFormSource, /National Egyptian holiday/);
  assert.match(vacationRequestFormSource, /Google Calendar/);
  assert.match(vacationRequestFormSource, /Official holiday adjacency/);
  assert.match(vacationRequestFormSource, /<table className=/);
  assert.match(vacationRequestFormSource, /Duration/);
  assert.match(vacationRequestFormSource, /function VacationDatePicker/);
  assert.match(vacationRequestFormSource, /Fridays in red/);
  assert.match(vacationRequestFormSource, /Grey dates outside current vacation policy/);
  assert.match(vacationRequestFormSource, /GlobeMed forms, do not qualify as Sick vacation documents/);
  assert.match(vacationRequestFormSource, /indexedDB\.open\(vacationQueueDbName/);
  assert.match(vacationRequestFormSource, /Online connection is required for evidence upload/);
  assert.match(vacationRequestFormSource, /vacationType === "sick" \|\| vacationType === "compensatory"/);
  assert.match(vacationRequestFormSource, /htmlFor="compensatory-photo"/);
  assert.match(vacationReportSource, /Request ID/);
  assert.match(vacationReportSource, /formatDateTime/);
  assert.match(vacationReportSource, /Submitted/);
  assert.match(vacationReportSource, /vacationRequestDisplayId\(row\.id\)/);
  assert.match(vacationReportSource, />HR ID</);
  assert.match(vacationReportSource, />From</);
  assert.match(vacationReportSource, />To</);
  assert.match(vacationReportSource, /SortableHeader/);
  assert.match(vacationReportSource, /requestId: initialData\?\.filters\.requestId/);
  assert.match(vacationReportSource, /Add Vacation/);
  assert.match(vacationReportSource, /Save Changes/);
  assert.match(vacationReportSource, /deleteAdminRequest/);
  assert.match(vacationReportSource, /VacationAttachmentLinks/);
  assert.match(vacationReportSource, /Audit XLSX/);
  assert.match(vacationReportSource, /canExport/);
  assert.match(vacationReportSource, /status: "pending_manager"/);
  assert.match(vacationReportSource, /Evidence review/);
  assert.match(vacationReportSource, /Approval timeline/);
  assert.match(vacationReportSource, /Overlap intelligence/);
  assert.match(vacationReportSource, /Daily SLA run/);
  assert.match(vacationReportSource, /pendingAction/);
  assert.doesNotMatch(vacationReportSource, /window\.confirm|window\.prompt/);
  assert.match(vacationLayoutSource, /redirect\("\/login"\)/);
  assert.match(vacationLayoutSource, /!access\.loginId && !access\.hrId/);
  assert.match(typesSource, /canAdminManage: boolean/);
  assert.match(typesSource, /canExport: boolean/);
  assert.match(typesSource, /canReviewAttachments: boolean/);
  assert.match(typesSource, /VacationWeeklyOffPolicySnapshot/);
  assert.match(typesSource, /VacationTimelineEvent/);
  assert.match(typesSource, /VacationEvidenceReview/);
  assert.match(typesSource, /VacationOverlapWarning/);
  assert.match(typesSource, /VacationSlaStatus/);
  assert.match(typesSource, /VacationDashboardData/);
  assert.match(typesSource, /VacationAuditExportMetadata/);
  assert.match(typesSource, /label: "Other", value: "other"/);
  assert.match(typesSource, /label: "Compensatory Day", value: "compensatory"/);
  assert.match(typesSource, /label: "Partially Paid", value: "partial"/);
  assert.match(typesSource, /VACATION_WEEKLY_OFF_MODES/);
  assert.doesNotMatch(typesSource, /Personal Vacation/);

  assert.match(navigationSource, /label: "Leave Management"/);
  assert.match(navigationSource, /label: "Vacation Request"/);
  assert.match(navigationSource, /label: "Vacation Report"/);
  assert.match(navigationSource, /label: "Vacation Control"/);
  assert.doesNotMatch(navigationSource, /Leave Policy|Entitlement|Approval Matrix|Workflow Builder/);

  assert.match(migrationSource, /create table if not exists public\.v2_vacation_requests/);
  assert.match(migrationSource, /create table if not exists public\.v2_vacation_email_tokens/);
  assert.match(migrationSource, /enable row level security/);
  assert.doesNotMatch(migrationSource, /drop table|drop function|drop policy .*leave/i);
  assert.match(policyMigrationSource, /update public\.v2_vacation_requests\s+set vacation_type = 'other'/i);
  assert.match(policyMigrationSource, /vacation_type in \('annual', 'emergency', 'sick', 'other'\)/i);
  assert.match(policyMigrationSource, /sick_attachment_object_path/);
  assert.match(policyMigrationSource, /leave-attachments/);
  assert.match(hrFinalDecisionMigrationSource, /pending_hr/);
  assert.match(hrFinalDecisionMigrationSource, /hr_decision/);
  assert.doesNotMatch(hrFinalDecisionMigrationSource, /drop table|drop function|drop policy .*leave/i);
  assert.match(weeklyOffControlMigrationSource, /create table if not exists public\.v2_vacation_weekly_off_policies/);
  assert.match(weeklyOffControlMigrationSource, /friday_off text not null default 'full_day'/);
  assert.match(weeklyOffControlMigrationSource, /saturday_off text not null default 'working'/);
  assert.match(weeklyOffControlMigrationSource, /thursday_off text not null default 'working'/);
  assert.doesNotMatch(weeklyOffControlMigrationSource, /drop table|drop function|drop policy .*leave/i);
  assert.match(compensatoryMigrationSource, /compensatory_event_name text null/);
  assert.match(compensatoryMigrationSource, /vacation_type in \('annual', 'emergency', 'sick', 'other', 'compensatory'\)/);
  assert.match(compensatoryMigrationSource, /v2_vacation_requests_compensatory_required_check/);
  assert.doesNotMatch(compensatoryMigrationSource, /drop table|drop function|drop policy .*leave/i);
  assert.match(partialPaidMigrationSource, /paid_duration_days numeric\(8,2\)/);
  assert.match(partialPaidMigrationSource, /unpaid_duration_days numeric\(8,2\)/);
  assert.match(partialPaidMigrationSource, /payment_status in \('paid', 'partial', 'unpaid'\)/);
  assert.doesNotMatch(partialPaidMigrationSource, /drop table|drop function|drop policy .*leave/i);
  assert.match(integrityMigrationSource, /weekly_off_policy_snapshot jsonb/);
  assert.match(integrityMigrationSource, /v2_vacation_requests_no_duplicate_active/);
  assert.match(governanceMigrationSource, /create table if not exists public\.v2_vacation_evidence_reviews/);
  assert.match(governanceMigrationSource, /create table if not exists public\.v2_vacation_sla_runs/);
  assert.match(governanceMigrationSource, /create table if not exists public\.v2_vacation_sla_settings/);
  assert.match(governanceMigrationSource, /create or replace function public\.phx_vacation_report_rows/);
  assert.match(governanceMigrationSource, /grant execute on function public\.phx_vacation_report_rows/);
  assert.match(governanceMigrationSource, /v2_vacation_requests_sla_pending_manager_idx/);
  assert.match(governanceMigrationSource, /v2_vacation_requests_sla_pending_hr_idx/);
  assert.doesNotMatch(governanceMigrationSource, /drop table|drop function|drop policy .*leave/i);
  assert.match(complianceMigrationSource, /create table if not exists public\.api_rate_limit_buckets/);
  assert.match(complianceMigrationSource, /create table if not exists public\.v2_vacation_retention_policies/);
  assert.match(complianceMigrationSource, /'request_history', 2555/);
  assert.match(complianceMigrationSource, /'evidence_attachments', 1095/);
  assert.match(complianceMigrationSource, /'decision_tokens', 90/);
  assert.match(complianceMigrationSource, /'sla_run_logs', 365/);
  assert.match(complianceMigrationSource, /create table if not exists public\.v2_vacation_retention_purge_runs/);
  assert.match(complianceMigrationSource, /enable row level security/);
  assert.doesNotMatch(complianceMigrationSource, /drop table|drop function|drop policy .*leave/i);
  // Vercel Pro hosts the daily dispatcher, the sub-daily outbox drain (moved off GitHub Actions
  // so it stops consuming Actions minutes), and the iReports360 visits sync. All are CRON_SECRET
  // protected. Any additional cron must be a deliberate, reviewed change.
  const crons = JSON.parse(vercelConfigSource).crons as Array<{ path: string; schedule: string }>;
  // Daily dispatcher runs at 06:30 UTC = 09:30 Africa/Cairo (EEST, UTC+3 in summer).
  // iReports360 visits sync runs 09:00/12:00/19:00 UTC = 12pm/3pm/10pm Africa/Cairo (same EEST
  // calibration) — owner-requested cadence so Phoenix stays synced with the CRM without a manual pull.
  assert.deepEqual(crons, [
    { path: "/api/notifications/daily", schedule: "30 6 * * *" },
    { path: "/api/notifications/process?limit=50", schedule: "*/30 * * * *" },
    { path: "/api/cron/ireports360-visits-sync", schedule: "0 9,12,19 * * *" },
  ]);
}
