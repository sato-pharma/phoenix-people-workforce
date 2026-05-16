import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  calculateVacationRequestPreview,
  createVacationRequestRecord,
  type VacationRequestRecord,
} from "../src/lib/leave/requests.ts";

const migrationSource = readFileSync(
  new URL("../supabase/migrations/20260517000000_remote_app_baseline.sql", import.meta.url),
  "utf8",
);
const workflowRouteSource = readFileSync(
  new URL("../app/api/vacation-requests/workflow/route.ts", import.meta.url),
  "utf8",
);
const requestComponentSource = readFileSync(
  new URL("../src/components/leave/vacation-request.tsx", import.meta.url),
  "utf8",
);
const reportComponentSource = readFileSync(
  new URL("../src/components/leave/vacation-report.tsx", import.meta.url),
  "utf8",
);
const leaveServiceSource = readFileSync(
  new URL("../src/lib/leave/requests.ts", import.meta.url),
  "utf8",
);

function assertContains(source: string, pattern: RegExp, message: string) {
  assert.match(source, pattern, message);
}

function assertNotContains(source: string, pattern: RegExp, message: string) {
  assert.doesNotMatch(source, pattern, message);
}

function findSubmitPayloadBlock() {
  const match = requestComponentSource.match(
    /body:\s*JSON\.stringify\(\{\s*action:\s*"submit"[\s\S]*?\n\s*headers:/i,
  );
  if (!match) {
    return "";
  }

  return match[0];
}

function makeRecord({
  startDate,
  endDate,
  status = "Pending",
}: { startDate: string; endDate: string; status?: "Pending" | "Approved" | "Rejected" }) {
  const record = createVacationRequestRecord({
    employeeEmail: "test.user@company.com",
    employeeId: "E001",
    employeeHireDate: "2026-04-01",
    employeeName: "Test User",
    reason: "test",
    requestType: "Annual Leave",
    dayType: "Full Day",
    startDate,
    endDate,
    existingRecords: [],
  });

  return {
    ...record,
    status,
  } as VacationRequestRecord;
}

export function runLeaveWorkflowAccessControlTests() {
  const requiredFields = [
    "id",
    "employee_hr_id",
    "employee_name",
    "direct_manager_hr_id",
    "manager_of_manager_hr_id",
    "vacation_type",
    "day_type",
    "start_date",
    "end_date",
    "duration_days",
    "paid_status",
    "available_balance_at_submission",
    "first_year_entitlement_at_submission",
    "current_annual_entitlement_at_submission",
    "used_paid_leave_at_submission",
    "remaining_paid_balance_at_submission",
    "unpaid_leave_days_at_submission",
    "pending_leave_impact_at_submission",
    "status",
    "rejection_reason",
    "approved_or_rejected_by",
    "submitted_at",
    "approved_or_rejected_at",
    "created_at",
    "updated_at",
  ];

  for (const field of requiredFields) {
    assertContains(migrationSource, new RegExp(`\\b${field}\\b`, "i"), `leave_requests migration must include ${field}.`);
  }

  assertContains(
    workflowRouteSource,
    /const canAccessAdminData = await canAccess\(access, "admin", "read"\)/i,
    "workflow route must evaluate admin-report permission before exposing company records.",
  );
  assertContains(
    workflowRouteSource,
    /const actor = canViewAll \? null : await resolveAuthenticatedEmployee\(access\)/i,
    "workflow report must derive requesting employee identity from server-side session resolution.",
  );
  assertContains(
    workflowRouteSource,
    /const requestedEmployeeId = canViewAll \? null : actor\?\.employeeHrId \?\? null/i,
    "workflow report must scope non-admin reads to the resolved authenticated employee HR ID.",
  );
  assertContains(
    workflowRouteSource,
    /loadLeaveRequestsFromDb\(\{\s*employeeHrId: requestedEmployeeId,\s*requestId: requestId \|\| null,\s*\}\)/i,
    "workflow GET should scope non-admin employees to own records and optional request ID.",
  );
  assertContains(
    workflowRouteSource,
    /if \(!access\.loginId && !access\.hrId\)\s*{\s*return NextResponse\.json\(\{ success: false, error: "Unauthorized\." \}, \{ status: 401 \}\);/i,
    "workflow submit must reject unauthenticated users.",
  );
  assertContains(
    workflowRouteSource,
    /if \(!canApprove && !canAccessAdminData && !canDirectManageRequest && !isHrActor\)/i,
    "workflow decide must explicitly guard unauthorized actors before applying decisions.",
  );
  assertContains(
    workflowRouteSource,
    /Forbidden: only admins, HR, or the assigned direct manager can decide requests\./i,
    "workflow decide must return the current forbidden message for unauthorized decision actors.",
  );
  assertContains(
    workflowRouteSource,
    /await upsertVacationRequest\(requestSnapshot\)/i,
    "workflow submit must persist computed request snapshot with the server-side snapshot source.",
  );
  assertContains(
    workflowRouteSource,
    /await setVacationRequestStatus\(/i,
    "workflow decide must persist decision through server-side DB update.",
  );
  assertNotContains(workflowRouteSource, /employee_hr_id.*: .*source\.|employee_name.*: .*source\./i,
    "submit payload fields from client identity should not be written directly into persistence payload.");

  assertNotContains(requestComponentSource, /localStorage/i, "Vacation Request component must not use localStorage for persistence.");
  assertContains(
    requestComponentSource,
    /const submitDisabled =[\s\S]*!preview\.hasRange[\s\S]*calculateVacationDuration\(form\.startDate, form\.endDate\) <= 0/i,
    "Vacation Request submit gating must be based on date validity, not identity fields from the client form.",
  );
  assertNotContains(
    requestComponentSource,
    /const submitDisabled =[\s\S]*validEmployeeIdentity|const submitDisabled =[\s\S]*validHiringDate/i,
    "Vacation Request submit gating must not rely on client-provided employee identity or hiring-date validity.",
  );

  const requestPayloadBlock = findSubmitPayloadBlock();
  assertNotContains(
    requestPayloadBlock,
    /employee_hr_id|employee_name|direct_manager_hr_id|manager_of_manager_hr_id|duration_days|paid_status|available_balance_at_submission|first_year_entitlement_at_submission|current_annual_entitlement_at_submission|used_paid_leave_at_submission|remaining_paid_balance_at_submission|unpaid_leave_days_at_submission|pending_leave_impact_at_submission|approved_or_rejected_by|employeeId|employeeEmail|employeeHireDate|line|area|team|role/i,
    "Vacation submit request payload must not include authoritative identity or calculation fields.",
  );
  assertContains(
    requestPayloadBlock,
    /"vacation_type":\s*form\.requestType|vacation_type:\s*form\.requestType/i,
    "Vacation submit payload must include request type from form input.",
  );
  assertContains(
    requestPayloadBlock,
    /"day_type":\s*form\.dayType|day_type:\s*form\.dayType/i,
    "Vacation submit payload must include day type from form input.",
  );
  assertContains(
    requestPayloadBlock,
    /"start_date":\s*form\.startDate|start_date:\s*form\.startDate/i,
    "Vacation submit payload must include start date.",
  );
  assertContains(
    requestPayloadBlock,
    /"end_date":\s*form\.endDate|end_date:\s*form\.endDate/i,
    "Vacation submit payload must include end date.",
  );

  assertNotContains(reportComponentSource, /localStorage/i, "Vacation Report component must not use localStorage for persistence.");
  assertNotContains(reportComponentSource, /getSupabaseAdmin/i, "Vacation Report component must not use server-only Supabase clients.");
  assertNotContains(requestComponentSource, /getSupabaseAdmin/i, "Vacation Request component must not use server-only Supabase clients.");
  assertNotContains(leaveServiceSource, /getSupabaseAdmin|SUPABASE_SERVICE_ROLE_KEY|service_role/i,
    "Client leave service layer should stay free of service-role DB access.");

  const probationPreview = calculateVacationRequestPreview({
    currentDateISO: "2026-06-15",
    dayType: "Full Day",
    endDate: "2026-06-18",
    existingRecords: [],
    employeeEmail: "test.user@company.com",
    employeeHireDate: "2026-04-01",
    employeeId: "E001",
    employeeName: "Test User",
    startDate: "2026-06-15",
  });

  assert.equal(probationPreview.paymentStatus, "Unpaid", "First 6 months requests must be auto-unpaid.");

  const sixMonthPreview = calculateVacationRequestPreview({
    currentDateISO: "2026-10-20",
    dayType: "Full Day",
    endDate: "2026-10-21",
    existingRecords: [],
    employeeEmail: "test.user@company.com",
    employeeHireDate: "2026-04-01",
    employeeId: "E001",
    employeeName: "Test User",
    startDate: "2026-10-20",
  });
  assert.equal(sixMonthPreview.currentAnnualEntitlement, 15, "First-year entitlement must be 15 paid days.");
  assert.equal(sixMonthPreview.willBePaid, true, "Requests after probation should be paid when balance supports it.");

  const oneYearPreview = calculateVacationRequestPreview({
    currentDateISO: "2027-05-12",
    dayType: "Full Day",
    endDate: "2027-05-13",
    existingRecords: [],
    employeeEmail: "test.user@company.com",
    employeeHireDate: "2026-04-01",
    employeeId: "E001",
    employeeName: "Test User",
    startDate: "2027-05-12",
  });
  assert.equal(oneYearPreview.currentAnnualEntitlement, 21, "Post-year entitlement must be 21 paid days.");

  const priorApproved = makeRecord({
    startDate: "2026-10-01",
    endDate: "2026-10-15",
    status: "Approved",
  });

  const insufficientBalancePreview = calculateVacationRequestPreview({
    currentDateISO: "2026-11-10",
    dayType: "Full Day",
    endDate: "2026-11-12",
    existingRecords: [priorApproved],
    employeeEmail: "test.user@company.com",
    employeeHireDate: "2026-04-01",
    employeeId: "E001",
    employeeName: "Test User",
    startDate: "2026-11-10",
  });

  assert.equal(insufficientBalancePreview.willBePaid, false, "Insufficient remaining balance must force unpaid.");
  assert.equal(insufficientBalancePreview.paymentStatus, "Unpaid", "Insufficient balance must mark request as unpaid.");
}
