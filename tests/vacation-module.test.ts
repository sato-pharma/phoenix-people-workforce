import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const serviceSource = readFileSync(
  new URL("../src/lib/vacation/service.ts", import.meta.url),
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
  new URL("../app/leave-management/layout.tsx", import.meta.url),
  "utf8",
);

export function runVacationModuleTests() {
  assert.match(serviceSource, /const vacationRequestsTable = "v2_vacation_requests"/);
  assert.match(serviceSource, /request\.status !== "pending_manager" && request\.status !== "pending_hr"/);
  assert.match(serviceSource, /accessMatchesHrId\(access, request\.managerHrId\)/);
  assert.match(serviceSource, /access\.role === "Super Admin" \|\| isDesignatedHrSpecialist\(access\)/);
  assert.match(serviceSource, /\.in\("role", \["HR Specialist", "Super Admin"\]\)/);
  assert.match(serviceSource, /managerOfManagerHrId/);
  assert.match(serviceSource, /getVacationPolicyWarnings/);
  assert.match(typesSource, /label: "Pending HR", value: "pending_hr"/);
  assert.match(serviceSource, /\.in\("vacation_type", \["annual", "emergency"\]\)/);
  assert.match(serviceSource, /leave-attachments/);
  assert.match(serviceSource, /Sick vacation requires an uploaded medical document/);
  assert.match(serviceSource, /Compensatory Day requires the event name/);
  assert.match(serviceSource, /Compensatory Day requires the first manager name/);
  assert.match(serviceSource, /Compensatory Day has expired/);
  assert.match(serviceSource, /Vacation requests cannot be submitted retroactively/);
  assert.match(serviceSource, /Annual vacation requests must start from tomorrow or later/);
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
  const crons = JSON.parse(vercelConfigSource).crons as Array<{ path: string; schedule: string }>;
  assert.deepEqual(crons, [{ path: "/api/notifications/daily", schedule: "0 4 * * *" }]);
}
