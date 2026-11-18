/**
 * Leave, attendance and payroll — each through the service and gate its screen uses. Read-only.
 */
import { z } from "zod";

import {
  assertCanViewEmployeeAttendance,
  getEmployeeAttendanceData,
  resolveAttendanceScopeHrIds,
} from "@/lib/attendance/employee-attendance";
import { getMonthlyAttendanceSummary, resolveSummaryMonth } from "@/lib/attendance/monthly-summary";
import { assertAttendanceMonthlySummaryPermission, assertPermission, getPayrollScope } from "@/lib/auth/permissions";
import { hrIdsMatch } from "@/lib/hr-id";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { findSalaryBatchForPeriod, getSalaryBatchExport } from "@/lib/payroll/service";
import { getEmployeeAnnualLeaveBalanceDays, getVacationReportData } from "@/lib/vacation/service";
import { VACATION_STATUSES, type VacationRequestStatus } from "@/lib/vacation/types";
import {
  capRows,
  cappedNote,
  daysBetween,
  isIsoDate,
  monthLabel,
  parsePeriod,
  pickFields,
  resolveDateWindow,
} from "@/lib/chatgpt-connector/tools/helpers";
import { defineTool, ToolRefusal } from "@/lib/chatgpt-connector/types";

/** The longest day-by-day attendance window one call reads. */
const MAX_ATTENDANCE_DAYS = 93;

const VACATION_ROW_FIELDS = [
  "requestCode",
  "employeeHrId",
  "employeeName",
  "lineName",
  "departmentName",
  "managerName",
  "vacationType",
  "dayPart",
  "status",
  "startDate",
  "endDate",
  "durationDays",
  "paidDurationDays",
  "unpaidDurationDays",
  "paymentStatus",
  "balanceBeforeDays",
  "balanceAfterDays",
  "managerDecision",
  "managerDecisionAt",
  "hrDecision",
  "hrDecisionAt",
  "createdAt",
] as const;

const VACATION_STATUS_VALUES = VACATION_STATUSES.map((status) => status.value) as [VacationRequestStatus, ...VacationRequestStatus[]];

export const leaveTool = defineTool({
  name: "phoenix_leave",
  title: "Leave",
  description:
    "Vacation requests and annual-leave balances from the Vacation Report. With hrId: that person's requests, their entitlement, " +
    "days used and balance, and the days they may actually request now. Without hrId: every request you can see. " +
    "Optional date window (YYYY-MM-DD) and status (needs_assignment, pending_manager, pending_hr, approved, rejected, returned, cancelled).",
  input: {
    hrId: z.string().max(40).optional().describe("One employee's HR id."),
    from: z.string().optional().describe("Requests overlapping from this date, YYYY-MM-DD."),
    to: z.string().optional().describe("Requests overlapping up to this date, YYYY-MM-DD."),
    status: z.enum(VACATION_STATUS_VALUES).optional(),
  },
  run: async (ctx, input) => {
    if (input.from && !isIsoDate(input.from)) throw new ToolRefusal("from must be written YYYY-MM-DD.");
    if (input.to && !isIsoDate(input.to)) throw new ToolRefusal("to must be written YYYY-MM-DD.");
    // app/(admin)/leave-management/vacation-report/page.tsx — the service asserts leave:read and scopes rows.
    const report = await getVacationReportData(ctx, {
      dateFrom: input.from,
      dateTo: input.to,
      employee: input.hrId,
      status: input.status,
    });
    const rows = input.hrId ? report.rows.filter((row) => hrIdsMatch(row.employeeHrId, input.hrId)) : report.rows;
    const capped = capRows(rows);
    const requests = capped.rows.map((row) => pickFields(row, VACATION_ROW_FIELDS));

    if (input.hrId) {
      const eligibility = report.employeeEligibility.find((row) => hrIdsMatch(row.hrId, input.hrId)) ?? null;
      if (!eligibility && rows.length === 0) {
        throw new ToolRefusal(`No employee you can see on the Vacation Report has the HR id ${input.hrId}.`);
      }
      // A system read (vacation/service.ts), asked only once the report showed this person to the seat.
      const requestableDays = eligibility ? await getEmployeeAnnualLeaveBalanceDays(eligibility.hrId) : null;
      const name = eligibility?.displayName || eligibility?.fullName || rows[0]?.employeeName || input.hrId;
      const balanceWords = eligibility
        ? `entitlement ${eligibility.annualEntitlementDays} days, used ${eligibility.annualUsedDays}, balance ${eligibility.annualBalanceDays}` +
          (requestableDays != null ? `, may request ${requestableDays} now` : "")
        : "no entitlement row on the report";
      return {
        summary: `${name} (${input.hrId}): ${balanceWords}. ${capped.total} leave request${capped.total === 1 ? "" : "s"} in the window.${cappedNote(capped.total, capped.rows.length)}`,
        data: {
          balance: eligibility
            ? {
                annualEntitlementDays: eligibility.annualEntitlementDays,
                annualUsedDays: eligibility.annualUsedDays,
                annualBalanceDays: eligibility.annualBalanceDays,
                requestableAnnualLeaveDaysNow: requestableDays,
                eligibilityStatus: eligibility.eligibilityStatus,
                hireDate: eligibility.hireDate,
              }
            : null,
          requests,
          total: capped.total,
          capped: capped.capped,
        },
      };
    }

    const s = report.summary;
    return {
      summary:
        `${s.total} leave requests: ${s.approved} approved, ${s.pending} pending, ${s.rejected} rejected; ` +
        `${s.paidDays} paid and ${s.unpaidDays} unpaid days.${cappedNote(capped.total, capped.rows.length)}`,
      data: { summary: s, requests, total: capped.total, capped: capped.capped },
    };
  },
});

export const attendanceTool = defineTool({
  name: "phoenix_attendance",
  title: "Attendance",
  description:
    "Fingerprint attendance. With hrId: that person's day-by-day punches, late and early minutes, deductions and a summary for a date window " +
    "(from/to as YYYY-MM-DD, at most 93 days; default this month to today). Without hrId: the company Monthly Attendance Summary for `month` " +
    "(YYYY-MM, default this month) — present, absent, late, leave and deduction days per employee. 'absentDays' in a person's summary " +
    "counts single-punch days, not absence; days with no punch data company-wide are an outage, not absence.",
  input: {
    hrId: z.string().max(40).optional().describe("One employee's HR id."),
    from: z.string().optional().describe("YYYY-MM-DD, for one person."),
    to: z.string().optional().describe("YYYY-MM-DD, for one person."),
    month: z.string().optional().describe("YYYY-MM, for the company summary."),
  },
  run: async (ctx, input) => {
    if (input.hrId) {
      // app/api/attendance/employee-attendance/route.ts: attendance:read, then the per-person gate.
      await assertPermission(ctx, "attendance", "read");
      await assertCanViewEmployeeAttendance(ctx, input.hrId);
      const { from, to } = resolveDateWindow(input.from, input.to, currentCairoDateOnlyIso());
      if (daysBetween(from, to) > MAX_ATTENDANCE_DAYS) throw new ToolRefusal(`Ask for at most ${MAX_ATTENDANCE_DAYS} days at a time.`);
      const data = await getEmployeeAttendanceData(input.hrId, from, to, { includeNoRecordDays: true });
      const s = data.summary;
      return {
        summary:
          `${input.hrId}, ${from} to ${to}: ${s.totalRows} punch days — ${s.completeDays} complete, ${s.lateDays} late, ` +
          `${s.shortDays} short, ${s.absentDays} single-punch, ${s.deductionDays} with a deduction; ` +
          `${data.noRecordDates?.length ?? 0} working days with no record; ${data.pendingDisputes} disputes pending.`,
        data,
      };
    }

    // app/api/attendance/monthly-summary/export/route.ts: employees:read, the summary gate, the scope.
    if (input.month && !parsePeriod(input.month)) throw new ToolRefusal("month must be written YYYY-MM.");
    await assertPermission(ctx, "employees", "read");
    await assertAttendanceMonthlySummaryPermission(ctx);
    const scopeHrIds = await resolveAttendanceScopeHrIds(ctx);
    const month = resolveSummaryMonth(input.month);
    const data = await getMonthlyAttendanceSummary({ month, employeeHrIds: scopeHrIds ?? undefined });
    const capped = capRows(data.rows);
    const t = data.totals;
    const outage =
      data.missingDataDates.length > 0
        ? ` The device sent no data on ${data.missingDataDates.length} working day(s) (${data.missingDataDates.join(", ")}), so the month is incomplete.`
        : "";
    return {
      summary:
        `${monthLabel(month)} (${data.dateFrom} to ${data.dateTo}): ${t.employees} employees, ${t.presentDays} present days, ` +
        `${t.absentDays} absent days (${t.absenceRate.toFixed(1)}%), ${t.lateCount} late arrivals, ${t.totalDeductionDays} deduction days.` +
        outage +
        (data.holidayCalendarReachable ? "" : " The holiday calendar could not be read, so absences may be overcounted.") +
        cappedNote(capped.total, capped.rows.length),
      data: { ...data, rows: capped.rows, rowsTotal: capped.total, rowsCapped: capped.capped },
    };
  },
});

export const payrollTool = defineTool({
  name: "phoenix_payroll",
  title: "Payroll",
  description:
    "The salary sheet Phoenix holds for one month (month 1-12, year): batch status and every employee's line as payroll recorded it — " +
    "base, gross and net salary, allowances, additions, deductions (tax, social and medical insurance, loans, attendance, CRM), " +
    "the month's pay and its two parts. With hrId: that one person's line. Figures are the payroll file's own; nothing is recalculated.",
  input: {
    month: z.number().int().min(1).max(12),
    year: z.number().int().min(2024).max(2100),
    hrId: z.string().max(40).optional().describe("One employee's HR id."),
  },
  run: async (ctx, input) => {
    // app/(admin)/payroll/page.tsx + app/api/payroll/[id]/download/route.ts: company payroll scope,
    // payroll:read and payroll:export, then the service's own access filter on the rows.
    if (getPayrollScope(ctx) !== "COMPANY") throw new ToolRefusal("Your role does not see the company payroll.");
    await assertPermission(ctx, "payroll", "read");
    await assertPermission(ctx, "payroll", "export");
    const period = `${input.year}-${String(input.month).padStart(2, "0")}`;
    const batch = await findSalaryBatchForPeriod(input.month, input.year);
    if (!batch) {
      return { summary: `No salary sheet has been uploaded for ${monthLabel(period)}.`, data: { batch: null, records: [] } };
    }
    const exported = await getSalaryBatchExport(batch.id, ctx);
    if (!exported) throw new ToolRefusal(`The ${monthLabel(period)} salary sheet is not visible to your role.`);
    const records = input.hrId ? exported.records.filter((row) => hrIdsMatch(row.hrId, input.hrId)) : exported.records;
    const batchData = pickFields(exported.batch, ["id", "month", "year", "status", "fileName", "createdAt", "part1PaidAt", "approvedAt", "lockedAt"]);

    if (input.hrId) {
      const line = records[0];
      if (!line) throw new ToolRefusal(`${input.hrId} has no line on the ${monthLabel(period)} salary sheet.`);
      return {
        summary:
          `${line.fullName} (${line.hrId}), ${monthLabel(period)} (sheet status ${exported.batch.status}): base ${line.baseSalary}, gross ${line.grossSalary}, ` +
          `net ${line.netSalary}, month's pay ${line.monthSalary} (part 1 ${line.firstPart}, part 2 ${line.secondPart}), ` +
          `additions ${line.totalAdditions}, deductions ${line.totalDeductions} — EGP, as the payroll file records them.`,
        data: { batch: batchData, record: line },
      };
    }

    const capped = capRows(records);
    return {
      summary:
        `${monthLabel(period)} salary sheet (status ${exported.batch.status}): ${records.length} employee lines, in EGP as the payroll file records them.` +
        cappedNote(capped.total, capped.rows.length),
      data: { batch: batchData, records: capped.rows, total: capped.total, capped: capped.capped },
    };
  },
});
