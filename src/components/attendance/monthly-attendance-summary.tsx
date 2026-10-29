"use client";

import { useState } from "react";
import { CalendarCheck, CalendarX2, Clock4, Download, UsersRound, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { Button } from "@/components/ui/button";
import type { MonthlyAttendanceSummaryData } from "@/lib/attendance/monthly-summary";
import { attendanceMonthlyCycleNote } from "@/lib/attendance/monthly-summary-note";
import { phxFieldClassName } from "@/components/ui/form-tokens";

type Props = {
  initialData: MonthlyAttendanceSummaryData | null;
  initialError: string | null;
  month: string;
};

function absentTone(absentDays: number) {
  if (absentDays <= 0) return "text-emerald-700";
  if (absentDays <= 2) return "text-amber-700";
  return "text-rose-700";
}

export function MonthlyAttendanceSummary({ initialData, initialError, month }: Props) {
  const router = useRouter();
  const [selectedMonth, setSelectedMonth] = useState(month);

  const rows = initialData?.rows ?? [];
  const totals = initialData?.totals ?? {
    absenceRate: 0,
    absentDays: 0,
    employees: 0,
    expectedWorkingDays: 0,
    lateCount: 0,
    presentDays: 0,
    totalDeductionDays: 0,
  };

  function applyMonth() {
    router.push(`/attendance/monthly-summary?month=${encodeURIComponent(selectedMonth)}`);
  }

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={(
          <>
            <AdminInsightChip>{totals.employees} employees</AdminInsightChip>
            <AdminInsightChip tone="slate">{initialData?.dateFrom ?? ""} → {initialData?.dateTo ?? ""}</AdminInsightChip>
            <AdminInsightChip tone="orange">{totals.absenceRate}% absence rate</AdminInsightChip>
          </>
        )}
        description="Per-employee month rollup for device-mapped employees: expected working days exclude weekly offs, holidays, approved leave, and future days."
        eyebrow="Attendance"
        icon={<CalendarCheck className="h-3.5 w-3.5" />}
        title="Monthly Attendance Summary"
        actions={(
          <a
            className={`inline-flex items-center justify-center gap-2 border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-slate-100 backdrop-blur transition hover:border-phx-accent-line hover:bg-white/[0.16] hover:text-white ${rows.length === 0 ? "pointer-events-none opacity-50" : ""}`}
            href={`/api/attendance/monthly-summary/export?month=${encodeURIComponent(month)}`}
          >
            <Download className="h-4 w-4" />
            Export XLSX
          </a>
        )}
      />

      {initialError ? <AdminCallout tone="danger">{initialError}</AdminCallout> : null}
      <AdminCallout tone="neutral">
        {attendanceMonthlyCycleNote}
      </AdminCallout>
      {initialData && (!initialData.holidaySourceConnected || !initialData.holidayCalendarReachable) ? (
        <AdminCallout tone="warning">
          The public-holiday calendar could not be reached. Company and fixed-date public holidays are still applied, but the moving Islamic and Coptic holidays — both Eids, Islamic New Year, the Prophet&apos;s Birthday and Coptic Easter — may be counted as working days, overcounting absences.
        </AdminCallout>
      ) : null}
      {/* An attendance-agent outage used to be indistinguishable from mass absence: days with no
          punch data at all were counted against every employee. Those days are now excluded from
          the figures and named here instead, because this report's Absent column is read as
          evidence about people. */}
      {initialData && initialData.missingDataDates.length > 0 ? (
        <AdminCallout tone="danger">
          {`No attendance data was received for ${initialData.missingDataDates.length} working ${initialData.missingDataDates.length === 1 ? "day" : "days"} in this month: ${initialData.missingDataDates.join(", ")}. Those days are excluded from the figures below rather than counted as absence — this month is incomplete until the attendance device is back online and the days are re-ingested.`}
        </AdminCallout>
      ) : null}

      <AdminTableShell
        description="Pick a month to roll up. The current month only counts days through today."
        title="Month"
      >
        <div className="flex flex-wrap items-end gap-3 p-4">
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Month</span>
            <input
              className={phxFieldClassName}
              type="month"
              value={selectedMonth}
              onChange={(event) => setSelectedMonth(event.target.value)}
            />
          </label>
          <Button className="h-10" type="button" onClick={applyMonth}>
            Apply
          </Button>
        </div>
      </AdminTableShell>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <AdminStatCard
          description="Working days expected across all mapped employees"
          icon={<UsersRound className="h-5 w-5" />}
          label="Expected Days"
          value={totals.expectedWorkingDays}
        />
        <AdminStatCard
          description="Days with fingerprint punches on expected days"
          icon={<CalendarCheck className="h-5 w-5" />}
          label="Present Days"
          tone="emerald"
          value={totals.presentDays}
        />
        <AdminStatCard
          description={`${totals.absenceRate}% of expected working days`}
          icon={<CalendarX2 className="h-5 w-5" />}
          label="Absent Days"
          tone="rose"
          value={totals.absentDays}
        />
        <AdminStatCard
          description="Late arrivals flagged by attendance policies"
          icon={<Clock4 className="h-5 w-5" />}
          label="Late Count"
          tone="orange"
          value={totals.lateCount}
        />
        <AdminStatCard
          description="Total estimated deduction days this month"
          icon={<Wallet className="h-5 w-5" />}
          label="Deduction Days"
          tone="violet"
          value={totals.totalDeductionDays}
        />
      </div>

      <AdminTableShell
        description="Counts only cover expected working days — weekly offs, holidays, approved leave, and future days are excluded."
        title={`Employee Summary — ${month}`}
      >
        {/* Cards below md, the ten-column table from md up — the owner's standing rule, and a
            hard acceptance criterion for the two HR seats: "desktop shows full tables/dashboards,
            mobile never does". This page reached an HR rail on 2026-09-05, when the Attendance hub
            row was replaced by its cards and Monthly Summary became a row of its own. Before that
            the only HR row was the hub, so tests/hr-shell-mobile-tables.test.ts never walked this
            far and a 1400px minimum sat one tap from a phone. */}
        <PortalResponsiveDataList
          empty={
            <PortalEmptyState
              message="No device-mapped employees found for this month."
              title="Nothing to summarise"
            />
          }
          getKey={(row) => row.employeeHrId}
          items={rows}
          renderCard={(row) => (
            <PortalRecordCard
              accent={row.absentDays > 2 ? "rose" : row.absentDays > 0 ? "amber" : "emerald"}
              meta={
                <span>{[row.jobTitle, row.department].filter(Boolean).join(" · ")}</span>
              }
              title={row.employeeName}
            >
              <PortalRecordFields
                fields={[
                  { label: "Expected", value: row.expectedWorkingDays },
                  { label: "Present", value: row.presentDays },
                  { label: "Absent", value: row.absentDays },
                  { label: "On Leave", value: row.leaveDays },
                  { label: "Late", value: row.lateCount },
                  { label: "Early Leave", value: row.earlyLeaveCount },
                  { label: "Single Punch", value: row.singlePunchCount },
                  { label: "Exceptions", value: row.exceptionDays },
                  { label: "Deduction Days", value: row.totalDeductionDays },
                  { label: "Deduction Value", value: row.totalDeductionValue },
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[24%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                  <col className="w-[12%]" />
                </colgroup>
              }
            >
              <thead className="bg-slate-50 text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">
                <tr>
                    <th className="border-b border-slate-200 px-3 py-3">Employee</th>
                    <th className="border-b border-slate-200 px-3 py-3">Expected</th>
                    <th className="border-b border-slate-200 px-3 py-3">Present</th>
                    <th className="border-b border-slate-200 px-3 py-3">Absent</th>
                    <th className="border-b border-slate-200 px-3 py-3">On Leave</th>
                    <th className="border-b border-slate-200 px-3 py-3">Late</th>
                    <th className="border-b border-slate-200 px-3 py-3">Early Leave</th>
                    <th className="border-b border-slate-200 px-3 py-3">Single Punch</th>
                    <th className="border-b border-slate-200 px-3 py-3">Exceptions</th>
                    <th className="border-b border-slate-200 px-3 py-3">Deduction</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr className="text-sm" key={row.employeeHrId}>
                    <td className="break-words border-b border-slate-100 px-3 py-3 text-slate-700">
                      <span className="font-semibold text-slate-800">{row.employeeName}</span>
                      {row.jobTitle ? <div className="text-xs text-slate-500">{row.jobTitle}</div> : null}
                      {row.department ? <div className="text-xs text-slate-500">{row.department}</div> : null}
                    </td>
                    <td className="border-b border-slate-100 px-3 py-3 tabular-nums text-slate-700">{row.expectedWorkingDays}</td>
                    <td className="border-b border-slate-100 px-3 py-3 tabular-nums text-slate-700">{row.presentDays}</td>
                    <td className={`border-b border-slate-100 px-3 py-3 font-bold tabular-nums ${absentTone(row.absentDays)}`}>{row.absentDays}</td>
                    <td className="border-b border-slate-100 px-3 py-3 tabular-nums text-slate-700">{row.leaveDays}</td>
                    <td className="border-b border-slate-100 px-3 py-3 tabular-nums text-slate-700">{row.lateCount}</td>
                    <td className="border-b border-slate-100 px-3 py-3 tabular-nums text-slate-700">{row.earlyLeaveCount}</td>
                    <td className="border-b border-slate-100 px-3 py-3 tabular-nums text-slate-700">{row.singlePunchCount}</td>
                    <td className="border-b border-slate-100 px-3 py-3 tabular-nums text-slate-700">{row.exceptionDays}</td>
                    <td className="break-words border-b border-slate-100 px-3 py-3 tabular-nums text-slate-700">
                      <span className="font-semibold text-slate-800">{row.totalDeductionDays}</span>
                      <div className="text-xs">{row.totalDeductionValue}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
      </AdminTableShell>
    </div>
  );
}
