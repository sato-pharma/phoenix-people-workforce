"use client";

import { useState } from "react";
import { BarChart2, CalendarCheck, CalendarX2, Clock4, Download, UsersRound, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { attendanceMonthlyCycleNote, type MonthlyAttendanceSummaryData } from "@/lib/attendance/monthly-summary";

type Props = {
  canGenerateCandidates: boolean;
  initialData: MonthlyAttendanceSummaryData | null;
  initialError: string | null;
  month: string;
};

type GenerateResult = {
  employees: number;
  generated: number;
  monthKey: string;
  skipped: number;
  updated: number;
};

function absentTone(absentDays: number) {
  if (absentDays <= 0) return "text-emerald-700";
  if (absentDays <= 2) return "text-amber-700";
  return "text-rose-700";
}

export function MonthlyAttendanceSummary({ canGenerateCandidates, initialData, initialError, month }: Props) {
  const router = useRouter();
  const [selectedMonth, setSelectedMonth] = useState(month);
  const [generating, setGenerating] = useState(false);
  const [generateResult, setGenerateResult] = useState<GenerateResult | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

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

  function runGenerate() {
    setGenerating(true);
    setGenerateResult(null);
    setGenerateError(null);
    fetch("/api/attendance/generate-deduction-candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message ?? "Generation failed.");
        setGenerateResult(data as GenerateResult);
      })
      .catch((err) => setGenerateError(err instanceof Error ? err.message : "Failed."))
      .finally(() => setGenerating(false));
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
            className={`inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-slate-100 backdrop-blur transition hover:border-[#FDBA74] hover:bg-white/[0.16] hover:text-white ${rows.length === 0 ? "pointer-events-none opacity-50" : ""}`}
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
      {initialData && !initialData.holidaySourceConnected ? (
        <AdminCallout tone="warning">
          The public-holiday calendar could not be reached. Company holidays are still applied, but public holidays in this month may be counted as working days, slightly overcounting absences.
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
              className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
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
        <div className="phoenix-horizontal-scroll max-h-[70vh] overflow-auto">
          <table className="min-w-[1400px] border-separate border-spacing-0 text-left">
            <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
              <tr>
                <th className="sticky left-0 z-30 border-b border-r border-slate-200 bg-slate-50 px-4 py-3">Employee ID</th>
                <th className="sticky left-32 z-30 border-b border-r border-slate-200 bg-slate-50 px-4 py-3 shadow-[8px_0_12px_-12px_rgba(15,23,42,0.45)]">Name</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Job Title</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Department</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Expected</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Present</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Absent</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">On Leave</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Late</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Early Leave</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Single Punch</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Exceptions</th>
                <th className="border-b border-r border-slate-200 px-4 py-3">Deduction Days</th>
                <th className="border-b border-slate-200 px-4 py-3">Deduction Value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr className="group text-sm hover:bg-slate-50/60" key={row.employeeHrId}>
                  <td className="sticky left-0 z-20 w-32 min-w-32 whitespace-nowrap border-b border-r border-slate-100 bg-white px-4 py-3 font-semibold text-slate-800 group-hover:bg-slate-50">{row.employeeHrId}</td>
                  <td className="sticky left-32 z-20 w-56 min-w-56 whitespace-nowrap border-b border-r border-slate-100 bg-white px-4 py-3 text-slate-700 shadow-[8px_0_12px_-12px_rgba(15,23,42,0.45)] group-hover:bg-slate-50">{row.employeeName}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 text-slate-700">{row.jobTitle || "-"}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 text-slate-700">{row.department || "-"}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 font-semibold tabular-nums text-slate-800">{row.expectedWorkingDays}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 tabular-nums text-emerald-700">{row.presentDays}</td>
                  <td className={`whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 font-bold tabular-nums ${absentTone(row.absentDays)}`}>{row.absentDays}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 tabular-nums text-slate-700">{row.leaveDays}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 tabular-nums text-slate-700">{row.lateCount}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 tabular-nums text-slate-700">{row.earlyLeaveCount}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 tabular-nums text-slate-700">{row.singlePunchCount}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 tabular-nums text-slate-700">{row.exceptionDays}</td>
                  <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 font-semibold tabular-nums text-slate-800">{row.totalDeductionDays}</td>
                  <td className="whitespace-nowrap border-b border-slate-100 px-4 py-3 tabular-nums text-slate-700">{row.totalDeductionValue}</td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={14}>
                    No device-mapped employees found for this month.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </AdminTableShell>

      {canGenerateCandidates ? (
        <AdminTableShell
          description="Lock this month's attendance deductions and push them to the payroll governance queue. Approved exceptions are excluded automatically; re-running updates existing candidates safely."
          title="Month Closing — Generate Payroll Candidates"
        >
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button className="h-10 gap-2" disabled={generating} type="button" onClick={runGenerate}>
                <BarChart2 className="h-4 w-4" />
                {generating ? "Generating…" : `Generate Payroll Candidates for ${month}`}
              </Button>
            </div>
            {generateResult ? (
              <AdminCallout tone="neutral">
                Generated <strong>{generateResult.generated}</strong> new + updated <strong>{generateResult.updated}</strong> existing candidates for <strong>{generateResult.employees}</strong> employees in {generateResult.monthKey} ({generateResult.skipped} skipped — no violations).{" "}
                <a className="font-semibold underline hover:text-orange-600" href="/payroll">View in Deductions Governance →</a>
              </AdminCallout>
            ) : null}
            {generateError ? <AdminCallout tone="danger">{generateError}</AdminCallout> : null}
          </div>
        </AdminTableShell>
      ) : null}
    </div>
  );
}
