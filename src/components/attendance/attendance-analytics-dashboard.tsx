"use client";

import { AlarmClock, CalendarX2, ChartColumnBig, PlaneTakeoff, UsersRound } from "lucide-react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import type { AttendanceAnalyticsData } from "@/lib/attendance/analytics";

type Props = {
  initialData: AttendanceAnalyticsData | null;
  initialError: string | null;
};

function rateCellClass(rate: number) {
  if (rate <= 5) return "bg-emerald-50 text-emerald-800";
  if (rate <= 10) return "bg-amber-50 text-amber-800";
  if (rate <= 20) return "bg-orange-100 text-orange-900";
  return "bg-rose-100 text-rose-900";
}

function trendBarColor(absenceRate: number) {
  if (absenceRate <= 5) return "bg-emerald-500";
  if (absenceRate <= 10) return "bg-amber-500";
  return "bg-rose-500";
}

export function AttendanceAnalyticsDashboard({ initialData, initialError }: Props) {
  const today = initialData?.today;
  const chronicLate = initialData?.chronicLate ?? [];
  const departments = initialData?.departments ?? [];
  const weeklyTrend = initialData?.weeklyTrend ?? [];
  const dataUnavailable = initialData?.dataUnavailable ?? [];

  const maxWeeklyExpected = Math.max(1, ...weeklyTrend.map((week) => week.expectedDays));

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={(
          <>
            <AdminInsightChip>{today?.dateIso ?? ""}</AdminInsightChip>
            <AdminInsightChip tone="slate">{initialData?.windowFrom ?? ""} → {initialData?.windowTo ?? ""}</AdminInsightChip>
            {today && !today.isWorkingDay ? (
              <AdminInsightChip tone="orange">{today.holidayName ?? "Weekly off"} — no attendance expected today</AdminInsightChip>
            ) : null}
          </>
        )}
        description="Company-wide attendance signals for device-mapped employees: today's presence, chronic late offenders, department comparison, and the 8-week trend."
        eyebrow="Attendance"
        icon={<ChartColumnBig className="h-3.5 w-3.5" />}
        title="Attendance Analytics"
      />

      {initialError ? <AdminCallout tone="danger">{initialError}</AdminCallout> : null}
      {dataUnavailable.map((message) => (
        <AdminCallout key={message} tone="warning">{message}</AdminCallout>
      ))}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AdminStatCard
          description="Mapped employees expected to punch today"
          icon={<UsersRound className="h-5 w-5" />}
          label="Expected Today"
          value={today?.expectedCount ?? 0}
        />
        <AdminStatCard
          description="Employees with a punch so far today"
          icon={<AlarmClock className="h-5 w-5" />}
          label="Punched In (so far)"
          tone="emerald"
          value={today?.punchedInCount ?? 0}
        />
        <AdminStatCard
          description="Expected today with no punch yet"
          icon={<CalendarX2 className="h-5 w-5" />}
          label="Not Punched In"
          tone="rose"
          value={today?.absentees.length ?? 0}
        />
        <AdminStatCard
          description="On approved leave today"
          icon={<PlaneTakeoff className="h-5 w-5" />}
          label="On Leave"
          tone="blue"
          value={today?.onLeaveCount ?? 0}
        />
      </div>

      {today && today.isWorkingDay && today.absentees.length > 0 ? (
        <AdminTableShell
          description="Expected to work today but no fingerprint punch yet. Approved leave is already excluded — counts update as punches sync."
          title={`Not Punched In Today (${today.absentees.length})`}
        >
          <div className="max-h-[40vh] overflow-auto">
            <table className="w-full border-separate border-spacing-0 text-left">
              <thead className="bg-slate-50 text-phx-xs font-black uppercase tracking-[0.16em] text-slate-500">
                <tr>
                  <th className="border-b border-r border-slate-200 px-4 py-3">Employee ID</th>
                  <th className="border-b border-r border-slate-200 px-4 py-3">Name</th>
                  <th className="border-b border-slate-200 px-4 py-3">Department</th>
                </tr>
              </thead>
              <tbody>
                {today.absentees.map((absentee) => (
                  <tr className="text-sm hover:bg-slate-50/60" key={absentee.employeeHrId}>
                    <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 font-semibold text-slate-800">{absentee.employeeHrId}</td>
                    <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 text-slate-700">{absentee.employeeName}</td>
                    <td className="whitespace-nowrap border-b border-slate-100 px-4 py-3 text-slate-700">{absentee.department || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminTableShell>
      ) : null}

      <AdminTableShell
        description={`Employees with ${3}+ late days in the last 30 days, worst first.`}
        title={`Chronic Late Offenders (${chronicLate.length})`}
      >
        <div className="max-h-[50vh] overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-left">
            <thead className="bg-slate-50 text-phx-xs font-black uppercase tracking-[0.16em] text-slate-500">
              <tr>
                <th className="border-b border-r border-slate-200 px-4 py-3">Employee ID</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Name</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Department</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Late Days</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Present Days</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Late Rate</th>
                <th className="border-b border-slate-200 px-4 py-3">Total Late Minutes</th>
              </tr>
            </thead>
            <tbody>
              {chronicLate.map((entry) => (
                <tr className="text-sm hover:bg-slate-50/60" key={entry.employeeHrId}>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 font-semibold text-slate-800">{entry.employeeHrId}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 text-slate-700">{entry.employeeName}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 text-slate-700">{entry.department || "-"}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 font-bold tabular-nums text-rose-700">{entry.lateDays}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 tabular-nums text-slate-700">{entry.presentDays}</td>
                  <td className={`whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 font-semibold tabular-nums ${rateCellClass(entry.lateRate)}`}>{entry.lateRate}%</td>
                  <td className="whitespace-nowrap border-b border-slate-100 px-4 py-3 tabular-nums text-slate-700">{entry.totalLateMinutes}</td>
                </tr>
              ))}
              {chronicLate.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={7}>
                    No chronic late offenders in the last 30 days.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </AdminTableShell>

      <AdminTableShell
        description="Late and absence rates per department over the last 30 days. Cell color steps from green (healthy) to red (needs attention)."
        title="Department Comparison"
      >
        <div className="max-h-[50vh] overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-left">
            <thead className="bg-slate-50 text-phx-xs font-black uppercase tracking-[0.16em] text-slate-500">
              <tr>
                <th className="border-b border-r border-slate-200 px-4 py-3">Department</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Headcount</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Expected Days</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Present Days</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Late Days</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Late Rate</th>
                <th className="border-b border-slate-200 px-4 py-3">Absence Rate</th>
              </tr>
            </thead>
            <tbody>
              {departments.map((entry) => (
                <tr className="text-sm hover:bg-slate-50/60" key={entry.department}>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 font-semibold text-slate-800">{entry.department}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 tabular-nums text-slate-700">{entry.headcount}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 tabular-nums text-slate-700">{entry.expectedDays}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 tabular-nums text-slate-700">{entry.presentDays}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 tabular-nums text-slate-700">{entry.lateDays}</td>
                  <td className={`whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 font-semibold tabular-nums ${rateCellClass(entry.lateRate)}`}>{entry.lateRate}%</td>
                  <td className={`whitespace-nowrap border-b border-slate-100 px-4 py-3 font-semibold tabular-nums ${rateCellClass(entry.absenceRate)}`}>{entry.absenceRate}%</td>
                </tr>
              ))}
              {departments.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={7}>
                    No department data available for the last 30 days.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </AdminTableShell>

      <AdminTableShell
        description="Present vs expected working days per ISO week. Bar height = expected days; the filled portion = days present."
        title="8-Week Attendance Trend"
      >
        <div className="p-5">
          {weeklyTrend.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">No trend data available.</p>
          ) : (
            <div className="flex items-end gap-3 overflow-x-auto pb-2">
              {weeklyTrend.map((week) => {
                const heightPct = Math.max(8, Math.round((week.expectedDays / maxWeeklyExpected) * 100));
                const presentPct = week.expectedDays > 0
                  ? Math.round((week.presentDays / week.expectedDays) * 100)
                  : 0;
                return (
                  <div className="flex min-w-20 flex-1 flex-col items-center gap-2" key={week.isoWeek}>
                    <div className="text-xs font-bold tabular-nums text-slate-700">{week.absenceRate}%</div>
                    <div className="flex h-40 w-full items-end">
                      <div
                        className="relative w-full overflow-hidden border border-slate-200 bg-slate-100"
                        style={{ height: `${heightPct}%` }}
                        title={`${week.isoWeek}: ${week.presentDays}/${week.expectedDays} present, ${week.lateDays} late, absence ${week.absenceRate}%`}
                      >
                        <div
                          className={`absolute bottom-0 left-0 w-full ${trendBarColor(week.absenceRate)}`}
                          style={{ height: `${presentPct}%` }}
                        />
                      </div>
                    </div>
                    <div className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">{week.isoWeek.slice(5)}</div>
                    <div className="text-phx-2xs tabular-nums text-slate-400">{week.weekStartIso.slice(5)}</div>
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Number above each bar is the week&apos;s absence rate. Weekly offs, holidays, and approved leave are excluded from expected days.
          </p>
        </div>
      </AdminTableShell>
    </div>
  );
}
