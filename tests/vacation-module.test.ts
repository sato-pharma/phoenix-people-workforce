import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const serviceSource = readFileSync(
  new URL("../src/lib/vacation/service.ts", import.meta.url),
  "utf8",
);
const sidebarSource = readFileSync(
  new URL("../src/components/layout/sidebar.tsx", import.meta.url),
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

export function runVacationModuleTests() {
  assert.match(serviceSource, /const vacationRequestsTable = "v2_vacation_requests"/);
  assert.match(serviceSource, /request\.status !== "pending_manager" && request\.status !== "pending_hr"/);
  assert.match(serviceSource, /hrIdsMatch\(resolveEmployeeIdentityId\(access\), request\.managerHrId\)/);
  assert.match(serviceSource, /access\.role === "Super Admin" \|\| isDesignatedHrSpecialist\(access\)/);
  assert.match(serviceSource, /\.ilike\("hr_id", "A-16"\)/);
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
  assert.match(serviceSource, /Manual admin record update/);
  assert.match(serviceSource, /Other vacation requires an explanation for HR review/);
  assert.match(serviceSource, /compensatoryAttachment/);
  assert.match(serviceSource, /\.eq\("vacation_type", input\.vacationType\)/);
  assert.match(serviceSource, /v2_vacation_weekly_off_policies/);
  assert.match(serviceSource, /getVacationControlData/);
  assert.match(serviceSource, /updateVacationWeeklyOffPolicy/);
  assert.match(serviceSource, /fetchWeeklyOffPolicyForTitle/);
  assert.match(routeSource, /request\.formData\(\)/);
  assert.match(routeSource, /sickDocument/);
  assert.match(routeSource, /otherReason/);
  assert.match(routeSource, /compensatoryPhoto/);
  assert.match(adminRouteSource, /createVacationRequestAsAdmin/);
  assert.match(requestAdminRouteSource, /updateVacationRequestAsAdmin/);
  assert.match(requestAdminRouteSource, /deleteVacationRequestAsAdmin/);
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
  assert.match(vacationRequestFormSource, /National Egyptian holiday/);
  assert.match(vacationRequestFormSource, /Google Calendar/);
  assert.match(vacationRequestFormSource, /Official holiday adjacency/);
  assert.match(vacationRequestFormSource, /<table className=/);
  assert.match(vacationRequestFormSource, /Duration/);
  assert.match(vacationRequestFormSource, /function VacationDatePicker/);
  assert.match(vacationRequestFormSource, /Fridays are marked in red/);
  assert.match(vacationRequestFormSource, /Grey dates are outside the current vacation policy/);
  assert.match(vacationRequestFormSource, /GlobeMed forms, do not qualify as Sick vacation documents/);
  assert.match(vacationReportSource, /Request ID/);
  assert.match(vacationReportSource, /formatDateTime/);
  assert.match(vacationReportSource, /Submitted/);
  assert.match(vacationReportSource, /vacationRequestDisplayId\(row\.id\)/);
  assert.match(vacationReportSource, />HR ID</);
  assert.match(vacationReportSource, />From</);
  assert.match(vacationReportSource, />To</);
  assert.match(vacationReportSource, /reportHeaderCellClass/);
  assert.match(vacationReportSource, /requestId: initialData\?\.filters\.requestId/);
  assert.match(vacationReportSource, /Add Vacation/);
  assert.match(vacationReportSource, /Save Changes/);
  assert.match(vacationReportSource, /deleteAdminRequest/);
  assert.match(typesSource, /canAdminManage: boolean/);
  assert.match(typesSource, /label: "Other", value: "other"/);
  assert.match(typesSource, /label: "Compensatory Day", value: "compensatory"/);
  assert.match(typesSource, /label: "Partially Paid", value: "partial"/);
  assert.match(typesSource, /VACATION_WEEKLY_OFF_MODES/);
  assert.doesNotMatch(typesSource, /Personal Vacation/);

  assert.match(sidebarSource, /label: "Leave Management"/);
  assert.match(sidebarSource, /label: "Vacation Request"/);
  assert.match(sidebarSource, /label: "Vacation Report"/);
  assert.match(sidebarSource, /label: "Vacation Control"/);
  assert.doesNotMatch(sidebarSource, /Leave Policy|Entitlement|Approval Matrix|Workflow Builder/);

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
}
