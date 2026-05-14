import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildLeaveAnalytics,
  buildLeaveCalendarItems,
  buildTeamAvailability,
  detectLeaveConflicts,
} from "../src/lib/leave/insights.ts";
import type { LeaveRequest, PublicHoliday } from "../src/lib/leave/types.ts";

function request(input: Partial<LeaveRequest> & Pick<LeaveRequest, "employeeHrId" | "endDate" | "id" | "startDate" | "status">): LeaveRequest {
  return {
    approvalHistory: [],
    attachmentUrl: null,
    balanceLeaveTypeId: "type-annual",
    createdAt: "2026-05-01T08:00:00.000Z",
    durationUnit: input.durationUnit ?? "full_day",
    employee: {
      areaName: input.employee?.areaName ?? "Cairo",
      fullName: input.employee?.fullName ?? input.employeeHrId,
      hrId: input.employeeHrId,
      jobTitle: input.employee?.jobTitle ?? "Medical Representative",
      lineName: input.employee?.lineName ?? "Line A",
      managerHrId: "M-001",
      managerName: "Manager One",
    },
    employeeHrId: input.employeeHrId,
    endDate: input.endDate,
    hrComment: null,
    hrBalanceDecision: null,
    hrDecisionAt: null,
    hrStatus: "pending",
    id: input.id,
    leaveType: input.leaveType ?? { affectsPayroll: false, code: "annual_leave", isPaid: true, name: "Annual Leave" },
    leaveTypeId: "type-annual",
    managerComment: null,
    managerDecisionAt: null,
    managerStatus: "pending",
    payrollStatus: "not_required",
    paymentReason: null,
    paymentStatus: input.paymentStatus ?? "paid",
    policyId: "policy",
    reason: null,
    requestedAt: input.requestedAt ?? "2026-05-01T08:00:00.000Z",
    startDate: input.startDate,
    status: input.status,
    totalCalendarDays: input.totalCalendarDays ?? 1,
    totalWorkingDays: input.totalWorkingDays ?? 1,
    updatedAt: input.updatedAt ?? "2026-05-01T08:00:00.000Z",
  };
}

const holidays: PublicHoliday[] = [
  {
    country: "EG",
    createdAt: "2026-05-01T00:00:00.000Z",
    date: "2026-05-07",
    id: "holiday",
    isActive: true,
    name: "Labour Day Observed",
    year: 2026,
  },
];

export function runLeavePhase2Tests() {
  const requests = [
    request({ employeeHrId: "E-001", endDate: "2026-05-06", id: "approved", startDate: "2026-05-04", status: "hr_approved", totalWorkingDays: 3 }),
    request({ employeeHrId: "E-002", endDate: "2026-05-05", id: "pending", startDate: "2026-05-05", status: "pending_manager" }),
    request({ employeeHrId: "E-003", endDate: "2026-05-05", id: "rejected", startDate: "2026-05-05", status: "hr_rejected" }),
    request({
      employee: { areaName: "Cairo", fullName: "Other Line", hrId: "E-004", jobTitle: "Rep", lineName: "Line B", managerHrId: "M-001", managerName: "Manager One" },
      employeeHrId: "E-004",
      endDate: "2026-05-06",
      id: "other-line",
      startDate: "2026-05-06",
      status: "hr_approved",
    }),
  ];

  const calendar = buildLeaveCalendarItems(requests, holidays, { month: 5, year: 2026 });
  assert.equal(calendar.some((item) => item.kind === "holiday" && item.title === "Labour Day Observed"), true);
  assert.equal(calendar.filter((item) => item.kind === "request").length, 4);
  assert.equal(buildLeaveCalendarItems(requests, holidays, { line: "Line A", month: 5, year: 2026 }).some((item) => item.employeeHrId === "E-004"), false);

  const availability = buildTeamAvailability(requests, holidays, { endDate: "2026-05-07", line: "Line A", startDate: "2026-05-05" });
  const conflictDay = availability.find((day) => day.date === "2026-05-05");
  assert.equal(conflictDay?.approved.length, 1);
  assert.equal(conflictDay?.pending.length, 1);
  assert.equal(conflictDay?.conflictCount, 1);
  assert.equal(availability.find((day) => day.date === "2026-05-07")?.publicHolidays.length, 1);
  const saturdayRequests = [
    request({ employeeHrId: "E-010", endDate: "2026-05-23", id: "field-saturday", startDate: "2026-05-23", status: "hr_approved" }),
    request({
      employee: { areaName: "Cairo", fullName: "Office User", hrId: "E-011", jobTitle: "Office Coordinator", lineName: "Line A", managerHrId: "M-001", managerName: "Manager One" },
      employeeHrId: "E-011",
      endDate: "2026-05-23",
      id: "office-saturday",
      startDate: "2026-05-23",
      status: "hr_approved",
    }),
  ];
  const saturdayAvailability = buildTeamAvailability(saturdayRequests, [], { endDate: "2026-05-23", line: "Line A", startDate: "2026-05-23" });
  assert.equal(saturdayAvailability[0]?.approved.some((item) => item.employeeHrId === "E-010"), true, "Field roles should appear available-conflicted on Saturday leave.");
  assert.equal(saturdayAvailability[0]?.approved.some((item) => item.employeeHrId === "E-011"), false, "Office roles should not appear on Saturday leave availability.");

  const conflicts = detectLeaveConflicts(
    {
      employee: { areaName: "Cairo", fullName: "Requester", hrId: "E-009", lineName: "Line A" },
      endDate: "2026-05-06",
      existingRequests: requests,
      startDate: "2026-05-05",
    },
    { sameLineWarningThreshold: 2 },
  );
  assert.equal(conflicts.blocked, false);
  assert.equal(conflicts.sameLineCount, 2);
  assert.equal(conflicts.warnings.some((warning) => warning.code === "same_line_capacity"), true);
  const saturdayConflicts = detectLeaveConflicts(
    {
      employee: { areaName: "Cairo", fullName: "Requester", hrId: "E-012", jobTitle: "Medical Representative", lineName: "Line A" },
      endDate: "2026-05-23",
      existingRequests: saturdayRequests,
      startDate: "2026-05-23",
    },
    { sameLineWarningThreshold: 1 },
  );
  assert.equal(saturdayConflicts.sameLineCount, 1, "Conflict detection should use dynamic weekend rules by title.");

  const analytics = buildLeaveAnalytics(requests, holidays, "2026-05-10");
  assert.equal(analytics.requestsByStatus.some((row) => row.label === "hr approved"), true);
  assert.equal(analytics.consumptionByMonth.find((row) => row.label === "May 2026")?.value, 4);
  assert.equal(analytics.pendingApprovalAging.find((row) => row.label === "8+ days")?.value, 1);
  assert.equal(analytics.publicHolidayImpact.find((row) => row.label === "May 2026")?.value, 1);

  const attachmentSource = readFileSync("src/lib/leave/attachments.ts", "utf8");
  assert.match(attachmentSource, /export function validateLeaveAttachment/);
  assert.match(attachmentSource, /export async function uploadLeaveAttachment/);
  assert.match(attachmentSource, /export async function getLeaveAttachmentUrl/);
  assert.match(attachmentSource, /export async function deleteLeaveAttachment/);
  assert.match(attachmentSource, /export function isRenderableLeaveAttachmentReference/);
  assert.match(attachmentSource, /path\.resolve\(uploadRoot/);
  assert.match(attachmentSource, /startsWith\(`\$\{uploadRoot\}\$\{path\.sep\}`\)/);
  assert.match(attachmentSource, /LEAVE_ATTACHMENT_STORAGE_MODE/);
  assert.match(attachmentSource, /"supabase" : "local"/);

  const serviceSource = readFileSync("src/lib/leave/service.ts", "utf8");
  const previewStart = serviceSource.indexOf("export async function getLeaveAccrualPreview");
  const runStart = serviceSource.indexOf("export async function runMonthlyLeaveAccrual");
  assert.ok(previewStart > -1 && runStart > previewStart, "accrual preview and run functions should exist");
  assert.equal(serviceSource.slice(previewStart, runStart).includes("recordBalanceTransaction"), false, "dry-run preview must not write transactions");
  assert.match(serviceSource, /\.eq\("notes", notes\)/, "accrual idempotency must check monthly notes");
  assert.match(serviceSource, /async function listManagerHierarchyLeaveRequests/);
  assert.match(serviceSource, /listManagerHierarchyLeaveRequests\(access, \{\}\)/);
  assert.match(serviceSource, /visibleOverlappingRequests/);
  assert.match(serviceSource, /employeeIsUnderManager\(access\.hrId, request\.employeeHrId, employeeByHrId\)/);

  const notificationSource = readFileSync("src/lib/leave/notifications.ts", "utf8");
  assert.match(notificationSource, /try \{/);
  assert.match(notificationSource, /catch \(error\)/);
  assert.match(notificationSource, /console\.warn\("Leave notification skipped"/);

  const requestRouteSource = readFileSync("app/api/leave/requests/route.ts", "utf8");
  assert.doesNotMatch(requestRouteSource, /attachmentUrl:\s*body\.attachmentUrl/);

  const workspaceSource = readFileSync("src/components/leave/leave-workspaces.tsx", "utf8");
  assert.match(workspaceSource, /LeaveCalendarView/);
  assert.match(workspaceSource, /LeaveAvailabilityView/);
  assert.match(workspaceSource, /LeaveAccrualPanel/);
  assert.match(workspaceSource, /LeaveAnalyticsPanel/);
  assert.match(workspaceSource, /LeaveRequestForm/);
  assert.match(workspaceSource, /LeaveRequestHistory/);

  const detailModalSource = readFileSync("src/components/leave/leave-detail-modal.tsx", "utf8");
  assert.match(detailModalSource, /\/api\/leave\/requests\/\$\{selectedRequest\.id\}\/attachment/);
  assert.match(detailModalSource, /noopener,noreferrer/);
  assert.match(detailModalSource, /stored privately/);
}
