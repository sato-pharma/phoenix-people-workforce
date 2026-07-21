"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarSearch, CheckCircle2, XCircle } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type {
  EmployeeDayByDayReport,
  EmployeeDayOutcome,
  EmployeeDayReportRow,
  FlexEligibleEmployeeOption,
} from "@/lib/attendance/employee-day-report";

type Props = {
  employees: FlexEligibleEmployeeOption[];
  employeesError: string | null;
  initialDateFrom: string;
  initialDateTo: string;
  initialEmployeeHrId: string;
  initialError: string | null;
  initialReport: EmployeeDayByDayReport | null;
};

const OUTCOME_LABEL: Record<EmployeeDayOutcome, string> = {
  approved_excuse: "Approved excuse",
  approved_leave: "Approved leave",
  complete: "Complete",
  crm_field_visit: "CRM field visit",
  crm_leave: "CRM leave",
  device_outage: "Device outage",
  field_punch_anomaly_flag: "Field-punch anomaly (flagged)",
  future: "Future",
  holiday: "Holiday",
  late: "Late",
  missing_punch: "Missing punch",
  no_plan_field_day: "Field day (per plan)",
  office_no_show_flag: "Office no-show (flagged)",
  short_hours: "Short hours",
  weekly_off: "Weekly off",
};

const OUTCOME_TONE: Record<EmployeeDayOutcome, string> = {
  approved_excuse: "bg-sky-50 text-sky-700 border-sky-200",
  approved_leave: "bg-sky-50 text-sky-700 border-sky-200",
  complete: "bg-emerald-50 text-emerald-700 border-emerald-200",
  crm_field_visit: "bg-sky-50 text-sky-700 border-sky-200",
  crm_leave: "bg-sky-50 text-sky-700 border-sky-200",
  device_outage: "bg-slate-100 text-slate-600 border-slate-200",
  field_punch_anomaly_flag: "bg-amber-50 text-amber-700 border-amber-200",
  future: "bg-slate-50 text-slate-400 border-slate-200",
  holiday: "bg-slate-100 text-slate-600 border-slate-200",
  late: "bg-orange-50 text-orange-700 border-orange-200",
  missing_punch: "bg-amber-50 text-amber-700 border-amber-200",
  no_plan_field_day: "bg-slate-100 text-slate-600 border-slate-200",
  office_no_show_flag: "bg-amber-50 text-amber-700 border-amber-200",
  short_hours: "bg-orange-50 text-orange-700 border-orange-200",
  weekly_off: "bg-slate-100 text-slate-600 border-slate-200",
};

const DECISION_LABEL: Record<string, string> = {
  auto_confirmed: "Confirmed",
  confirmed: "Confirmed",
  disputed: "Disputed",
  pending: "Pending review",
};

/** Outcomes that carry an actual deduction decision — the only rows Edit/Decline/Confirm apply to. */
const ACTIONABLE_OUTCOMES: ReadonlySet<EmployeeDayOutcome> = new Set(["late", "short_hours"]);

function formatClock(minutes: number | null): string {
  if (minutes === null) return "—";
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatDuration(minutes: number): string {
  if (minutes <= 0) return "—";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}h ${remainder}m`;
}

type Draft = { deductionDays: string; deductionValue: string; reason: string };

function initDrafts(days: EmployeeDayReportRow[]): Record<string, Draft> {
  const drafts: Record<string, Draft> = {};
  for (const day of days) {
    if (!ACTIONABLE_OUTCOMES.has(day.outcome)) continue;
    drafts[day.dateIso] = {
      deductionDays: String(day.deductionDays),
      deductionValue: String(day.deductionValue),
      reason: day.reason,
    };
  }
  return drafts;
}

export function EmployeeDayReport({
  employees,
  employeesError,
  initialDateFrom,
  initialDateTo,
  initialEmployeeHrId,
  initialError,
  initialReport,
}: Props) {
  const router = useRouter();
  const [employeeHrId, setEmployeeHrId] = useState(initialEmployeeHrId);
  const [dateFrom, setDateFrom] = useState(initialDateFrom);
  const [dateTo, setDateTo] = useState(initialDateTo);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => (initialReport ? initDrafts(initialReport.days) : {}));
  const [busyDate, setBusyDate] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionNotice, setDecisionNotice] = useState<string | null>(null);

  function viewReport() {
    if (!employeeHrId || !dateFrom || !dateTo) return;
    const params = new URLSearchParams({ dateFrom, dateTo, employeeHrId });
    router.push(`/attendance/employee-day-report?${params.toString()}`);
  }

  function updateDraft(dateIso: string, patch: Partial<Draft>) {
    setDrafts((current) => ({ ...current, [dateIso]: { ...current[dateIso], ...patch } as Draft }));
  }

  async function submitDecision(dateIso: string, mode: "confirm" | "decline") {
    if (!initialReport) return;
    const draft = drafts[dateIso];
    if (!draft) return;
    setBusyDate(dateIso);
    setDecisionError(null);
    setDecisionNotice(null);
    try {
      const response = await fetch("/api/attendance/employee-day-report/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dateIso,
          deductionDays: mode === "decline" ? 0 : Number(draft.deductionDays),
          deductionValue: mode === "decline" ? 0 : Number(draft.deductionValue),
          employeeHrId: initialReport.employeeHrId,
          reason: mode === "decline" ? `Declined by admin. ${draft.reason}`.trim() : draft.reason,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Decision failed.");
      setDecisionNotice(
        mode === "decline"
          ? `Declined ${dateIso} — no deduction will reach payroll.`
          : `Confirmed ${dateIso} — this will appear in Automated Payroll's Fingerprint Deductions.`,
      );
      router.refresh();
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : "Decision failed.");
    } finally {
      setBusyDate(null);
    }
  }

  const totals = initialReport
    ? initialReport.days.reduce(
        (acc, day) => ({
          deductionDays: acc.deductionDays + day.deductionDays,
          deductionValue: acc.deductionValue + day.deductionValue,
        }),
        { deductionDays: 0, deductionValue: 0 },
      )
    : null;

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={initialReport ? <AdminInsightChip tone="orange">{initialReport.days.length} day(s) shown</AdminInsightChip> : null}
        description="Pick one employee and a date range — every calendar day in that range is listed. Edit, Decline, or Confirm a late/short-hours day directly here; a Confirm settles it exactly like Digest Review does, and it's what Automated Payroll's Fingerprint Deductions step reads."
        eyebrow="Attendance"
        icon={<CalendarSearch className="h-3.5 w-3.5" />}
        title="Employee Day-by-Day Report"
      />

      {employeesError ? <AdminCallout tone="danger">{employeesError}</AdminCallout> : null}
      {initialError ? <AdminCallout tone="danger">{initialError}</AdminCallout> : null}
      {decisionError ? <AdminCallout tone="danger">{decisionError}</AdminCallout> : null}
      {decisionNotice ? <AdminCallout tone="neutral">{decisionNotice}</AdminCallout> : null}

      <AdminTableShell description="Only employees on the flexible-hours model appear here — the same population the weekly digest governs." title="Filters">
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-4">
          <label className="block space-y-1 sm:col-span-2">
            <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Employee</span>
            <SearchableSelect
              className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm font-semibold text-slate-900 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
              placeholder="Search employees..."
              value={employeeHrId}
              onValueChange={setEmployeeHrId}
            >
              <option value="">Select an employee…</option>
              {employees.map((employee) => (
                <option key={employee.hrId} value={employee.hrId}>
                  {employee.employeeName} ({employee.hrId}) — {employee.jobTitle}
                </option>
              ))}
            </SearchableSelect>
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">From</span>
            <input
              className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm font-semibold text-slate-900 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">To</span>
            <input
              className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm font-semibold text-slate-900 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
            />
          </label>
          <div className="sm:col-span-4">
            <Button disabled={!employeeHrId || !dateFrom || !dateTo} type="button" onClick={viewReport}>
              View Report
            </Button>
          </div>
        </div>
      </AdminTableShell>

      {initialReport ? (
        initialReport.tier === null ? (
          <AdminCallout tone="warning">
            {initialReport.employeeName} isn&apos;t on the flexible-hours model (no required-minutes policy) — this report only
            covers the population the weekly digest governs.
          </AdminCallout>
        ) : (
          <AdminTableShell
            description={`${initialReport.employeeName} (${initialReport.employeeHrId}) · ${initialReport.jobTitle} · ${initialReport.dateFromIso} to ${initialReport.dateToIso} · ${totals?.deductionDays ?? 0} day(s) · ${(totals?.deductionValue ?? 0).toFixed(2)} EGP total`}
            title="Day-by-Day Detail"
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1180px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-[11px] font-black uppercase tracking-[0.1em] text-slate-500">
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Outcome</th>
                    <th className="px-3 py-2">Check-in</th>
                    <th className="px-3 py-2">Check-out</th>
                    <th className="px-3 py-2">Worked</th>
                    <th className="px-3 py-2">Late</th>
                    <th className="px-3 py-2">Short</th>
                    <th className="px-3 py-2">Days</th>
                    <th className="px-3 py-2">Value (EGP)</th>
                    <th className="px-3 py-2">Reason</th>
                    <th className="px-3 py-2">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {initialReport.days.map((day) => {
                    const actionable = ACTIONABLE_OUTCOMES.has(day.outcome);
                    const draft = drafts[day.dateIso];
                    const decisionLabel = day.decision ? DECISION_LABEL[day.decision.action] : "Not yet generated";
                    return (
                      <tr className="align-top" key={day.dateIso}>
                        <td className="whitespace-nowrap px-3 py-2 font-semibold text-slate-900">
                          {day.dateIso}
                          <div className="text-[11px] font-medium text-slate-400">{day.weekday}</div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-bold ${OUTCOME_TONE[day.outcome]}`}>
                            {OUTCOME_LABEL[day.outcome]}
                          </span>
                          {actionable ? (
                            <div className="mt-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                              {decisionLabel}
                              {day.decision && (day.decision.action === "confirmed" || day.decision.action === "auto_confirmed")
                                ? `: ${day.decision.storedDeductionDays}d / ${day.decision.storedDeductionValue.toFixed(2)} EGP`
                                : ""}
                            </div>
                          ) : null}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-700">{formatClock(day.firstPunchMinutes)}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-700">{formatClock(day.lastPunchMinutes)}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-700">{formatDuration(day.workedMinutes)}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-700">{day.lateMinutes > 0 ? `${day.lateMinutes} min` : "—"}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-700">{day.shortMinutes > 0 ? `${day.shortMinutes} min` : "—"}</td>
                        {actionable && draft ? (
                          <>
                            <td className="px-3 py-2">
                              <input
                                className="h-8 w-16 rounded-md border border-slate-200 px-1.5 text-xs font-semibold text-slate-900 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                                type="number"
                                step="0.25"
                                min="0"
                                value={draft.deductionDays}
                                onChange={(event) => updateDraft(day.dateIso, { deductionDays: event.target.value })}
                              />
                            </td>
                            <td className="px-3 py-2">
                              <input
                                className="h-8 w-24 rounded-md border border-slate-200 px-1.5 text-xs font-semibold text-slate-900 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                                type="number"
                                step="0.01"
                                min="0"
                                value={draft.deductionValue}
                                onChange={(event) => updateDraft(day.dateIso, { deductionValue: event.target.value })}
                              />
                            </td>
                            <td className="px-3 py-2">
                              <input
                                className="h-8 w-40 rounded-md border border-slate-200 px-1.5 text-xs font-medium text-slate-700 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                                value={draft.reason}
                                onChange={(event) => updateDraft(day.dateIso, { reason: event.target.value })}
                              />
                            </td>
                            <td className="whitespace-nowrap px-3 py-2">
                              <div className="flex gap-1">
                                <Button
                                  disabled={busyDate !== null}
                                  size="sm"
                                  type="button"
                                  onClick={() => submitDecision(day.dateIso, "confirm")}
                                >
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                  {busyDate === day.dateIso ? "…" : "Confirm"}
                                </Button>
                                <Button
                                  disabled={busyDate !== null}
                                  size="sm"
                                  type="button"
                                  variant="secondary"
                                  onClick={() => submitDecision(day.dateIso, "decline")}
                                >
                                  <XCircle className="h-3.5 w-3.5" />
                                  Decline
                                </Button>
                              </div>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="whitespace-nowrap px-3 py-2 font-bold text-slate-900">{day.deductionDays > 0 ? day.deductionDays : "—"}</td>
                            <td className="whitespace-nowrap px-3 py-2 font-bold text-slate-900">{day.deductionValue > 0 ? day.deductionValue.toFixed(2) : "—"}</td>
                            <td className="px-3 py-2 text-xs font-medium text-slate-500">{day.reason}</td>
                            <td className="px-3 py-2 text-xs font-medium text-slate-400">—</td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </AdminTableShell>
        )
      ) : null}
    </div>
  );
}
