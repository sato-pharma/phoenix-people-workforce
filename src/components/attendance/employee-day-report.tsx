"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";
import { CalendarSearch } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import {
  PortalStackingCell,
  portalStackingBodyClassName,
  portalStackingHeadClassName,
  portalStackingRowClassName,
  portalStackingTableClassName,
} from "@/components/employee-portal/portal-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { calculateDeductionAmountFromBaseSalary } from "@/lib/deductions/calculations";
import type {
  EmployeeDayByDayReport,
  EmployeeDayDecisionInfo,
  EmployeeDayOutcome,
  EmployeeDeductionSummaryRow,
  FlexEligibleEmployeeOption,
} from "@/lib/attendance/employee-day-report";
import { phxFieldClassName } from "@/components/ui/form-tokens";

type Props = {
  employees: FlexEligibleEmployeeOption[];
  employeesError: string | null;
  initialDateFrom: string;
  initialDateTo: string;
  initialDecisions: Record<string, EmployeeDayDecisionInfo>;
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
  not_flex_eligible: "Not on flexible-hours model",
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
  not_flex_eligible: "bg-slate-50 text-slate-400 border-slate-200",
  office_no_show_flag: "bg-amber-50 text-amber-700 border-amber-200",
  short_hours: "bg-orange-50 text-orange-700 border-orange-200",
  weekly_off: "bg-slate-100 text-slate-600 border-slate-200",
};

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

/** Live EGP value from a (possibly just-edited) day count — base salary ÷ the day's own month in
 * calendar days × days, the exact formula the server re-derives on Approve
 * (calculateDeductionAmountFromBaseSalary), so the displayed number never lies about what will
 * actually be saved. Falls back to the report's own precomputed value when nothing's been edited.
 *
 * It DID lie until 2026-09-12: this divided by a flat 30 while the server it claims to mirror has
 * divided by the month's real calendar days since 2026-08-01, so every figure a reviewer approved
 * in a 31-day month read ~3.3% higher on screen than the amount actually charged — and lower in
 * February. Hence `dateIso`: the divisor depends on WHICH month the day falls in, so the day being
 * priced has to be passed in. */
function liveValue(
  dateIso: string,
  days: number,
  editedValue: string | undefined,
  baseSalary: number | null,
  fallback: number,
): number {
  const parsedDays = editedValue?.trim() ? Number(editedValue) : days;
  const [year, month] = dateIso.split("-").map(Number);
  const value = calculateDeductionAmountFromBaseSalary({ baseSalary, deductionDays: parsedDays, month, year });
  return Number.isFinite(parsedDays) && value != null ? value : fallback;
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Request failed.");
  return data;
}

export function EmployeeDayReport({
  employees,
  employeesError,
  initialDateFrom,
  initialDateTo,
  initialDecisions,
  initialEmployeeHrId,
  initialError,
  initialReport,
}: Props) {
  const router = useRouter();
  const [employeeHrId, setEmployeeHrId] = useState(initialEmployeeHrId);
  const [dateFrom, setDateFrom] = useState(initialDateFrom);
  const [dateTo, setDateTo] = useState(initialDateTo);
  const [isReportPending, startReportTransition] = useTransition();
  const [decisions, setDecisions] = useState<Record<string, EmployeeDayDecisionInfo>>(initialDecisions);
  const [busyDate, setBusyDate] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [editedDays, setEditedDays] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<"detail" | "summary" | "all">("detail");
  const [allSummary, setAllSummary] = useState<EmployeeDeductionSummaryRow[] | null>(null);
  const [allSummaryLoading, setAllSummaryLoading] = useState(false);
  const [allSummaryError, setAllSummaryError] = useState<string | null>(null);

  const loadAllSummary = useCallback(async () => {
    if (!dateFrom || !dateTo) {
      setAllSummaryError("Pick a From and To date above first.");
      return;
    }
    setAllSummaryLoading(true);
    setAllSummaryError(null);
    try {
      const res = await fetch(
        `/api/attendance/employee-day-report/all-summary?dateFrom=${dateFrom}&dateTo=${dateTo}`,
        { credentials: "same-origin" },
      );
      const data = (await res.json().catch(() => ({}))) as { rows?: EmployeeDeductionSummaryRow[]; message?: string };
      if (!res.ok) throw new Error(data.message ?? "Failed to load.");
      setAllSummary(data.rows ?? []);
    } catch (err) {
      setAllSummaryError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      setAllSummaryLoading(false);
    }
  }, [dateFrom, dateTo]);

  function viewReport() {
    if (!employeeHrId || !dateFrom || !dateTo) return;
    const params = new URLSearchParams({ dateFrom, dateTo, employeeHrId });
    startReportTransition(() => {
      router.push(`/attendance/employee-day-report?${params.toString()}`);
    });
  }

  const decide = useCallback(
    async (dateIso: string, decisionStatus: "Approved for Payroll" | "Do Not Take Action", days: number) => {
      setBusyDate(dateIso);
      setDecisionError(null);
      try {
        const data = await postJson("/api/attendance/employee-day-report/decisions", {
          employeeHrId,
          dateIso,
          decisionStatus,
          days,
        });
        const decision = data.decision as
          | { candidateId: string; decisionStatus: string; appliedDeductionValue: number | null; appliedAmount: number | null }
          | undefined;
        if (decision) {
          setDecisions((prev) => ({
            ...prev,
            [dateIso]: {
              candidateId: decision.candidateId,
              decisionStatus: decision.decisionStatus,
              appliedDeductionValue: decision.appliedDeductionValue,
              appliedAmount: decision.appliedAmount,
            },
          }));
        }
        const payrollNotices = Array.isArray(data.payrollNotices) ? (data.payrollNotices as string[]) : [];
        if (payrollNotices.length > 0) setDecisionError(payrollNotices.join(" "));
      } catch (err) {
        setDecisionError(err instanceof Error ? err.message : "Failed to save the decision.");
      } finally {
        setBusyDate(null);
      }
    },
    [employeeHrId],
  );

  const totals = initialReport
    ? initialReport.days.reduce(
        (acc, day) => ({
          deductionDays: acc.deductionDays + day.deductionDays,
          deductionValue: acc.deductionValue + day.deductionValue,
        }),
        { deductionDays: 0, deductionValue: 0 },
      )
    : null;

  // Live because it's derived straight from `decisions` state, which updates the instant a
  // decide() call succeeds — no separate refetch needed for this to reflect a fresh confirm.
  const confirmed = useMemo(() => {
    if (!initialReport) return [];
    return initialReport.days
      .map((day) => ({ day, decision: decisions[day.dateIso] }))
      .filter((entry) => entry.decision?.decisionStatus === "Approved for Payroll");
  }, [initialReport, decisions]);
  const confirmedTotals = confirmed.reduce(
    (acc, entry) => ({
      days: acc.days + (entry.decision?.appliedDeductionValue ?? 0),
      value: acc.value + (entry.decision?.appliedAmount ?? 0),
    }),
    { days: 0, value: 0 },
  );

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={initialReport ? <AdminInsightChip tone="orange">{initialReport.days.length} day(s) shown</AdminInsightChip> : null}
        description="Pick one employee and a date range — every calendar day in that range is listed with its full attendance detail. Confirm or reject that day's fingerprint deduction right here, on any day."
        eyebrow="Attendance"
        icon={<CalendarSearch className="h-3.5 w-3.5" />}
        title="Employee Day-by-Day Report"
      />

      {employeesError ? <AdminCallout tone="danger">{employeesError}</AdminCallout> : null}
      {initialError ? <AdminCallout tone="danger">{initialError}</AdminCallout> : null}
      {decisionError ? <AdminCallout tone="danger">{decisionError}</AdminCallout> : null}

      <AdminTableShell description="Only employees on the flexible-hours model appear here." title="Filters">
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-4">
          <label className="block space-y-1 sm:col-span-2">
            <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Employee</span>
            <SearchableSelect
              className="h-9 w-full px-2"
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
            <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">From</span>
            <input
              className={phxFieldClassName}
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">To</span>
            <input
              className={phxFieldClassName}
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
            />
          </label>
          <div className="sm:col-span-4">
            <Button disabled={!employeeHrId || !dateFrom || !dateTo || isReportPending} type="button" onClick={viewReport}>
              {isReportPending ? "Loading…" : "View Report"}
            </Button>
          </div>
        </div>
      </AdminTableShell>

      <div className="flex gap-1 border-b border-slate-200">
        <button
          type="button"
          onClick={() => setTab("detail")}
          className={`px-3 py-2 text-sm font-semibold ${
            tab === "detail" ? "border-b-2 border-orange-500 text-slate-900" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          Day-by-Day Detail
        </button>
        <button
          type="button"
          onClick={() => setTab("summary")}
          className={`px-3 py-2 text-sm font-semibold ${
            tab === "summary" ? "border-b-2 border-orange-500 text-slate-900" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          FP Deductions Summary ({confirmed.length})
        </button>
        <button
          type="button"
          onClick={() => {
            setTab("all");
            if (allSummary === null) void loadAllSummary();
          }}
          className={`px-3 py-2 text-sm font-semibold ${
            tab === "all" ? "border-b-2 border-orange-500 text-slate-900" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          All Employees Summary
        </button>
      </div>

      {tab === "all" ? (
        <AdminTableShell
          description={`Every employee with a confirmed fingerprint deduction, ${dateFrom || "…"} to ${dateTo || "…"} — no employee needs to be picked above.`}
          title="All Employees — Confirmed Fingerprint Deductions"
        >
          <div className="flex items-center justify-between gap-3 px-4 pt-4">
            <span className="text-xs text-slate-500">{allSummary ? `${allSummary.length} employee(s)` : ""}</span>
            <Button variant="outline" size="sm" disabled={allSummaryLoading} onClick={() => void loadAllSummary()}>
              {allSummaryLoading ? "Loading…" : "Refresh"}
            </Button>
          </div>
          {allSummaryError ? <div className="px-4 pt-2"><AdminCallout tone="danger">{allSummaryError}</AdminCallout></div> : null}
          {allSummary === null ? (
            <p className="px-4 py-6 text-sm text-slate-500">{allSummaryLoading ? "Loading…" : "Click Refresh to load."}</p>
          ) : allSummary.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">No confirmed fingerprint deductions in this range.</p>
          ) : (
            <div className="p-4 pt-2">
              <table className={`${portalStackingTableClassName} md:w-full md:table-fixed`}>
                <colgroup>
                  <col className="w-[40%]" />
                  <col className="w-[20%]" />
                  <col className="w-[20%]" />
                  <col className="w-[20%]" />
                </colgroup>
                <thead className={portalStackingHeadClassName}>
                  <tr className="border-b border-slate-200 text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">
                    <th className="px-3 py-2">Employee</th>
                    <th className="px-3 py-2">Days confirmed</th>
                    <th className="px-3 py-2">Total days</th>
                    <th className="px-3 py-2">Total value (EGP)</th>
                  </tr>
                </thead>
                <tbody className={`${portalStackingBodyClassName} divide-y divide-slate-100`}>
                  {allSummary.map((row) => (
                    <tr className={portalStackingRowClassName} key={row.employeeHrId}>
                      <PortalStackingCell className="break-words font-semibold text-slate-900" label="Employee">
                        {row.employeeName}
                      </PortalStackingCell>
                      <PortalStackingCell className="text-slate-700" label="Days confirmed">{row.count}</PortalStackingCell>
                      <PortalStackingCell className="font-bold text-slate-900" label="Total days">{row.days.toFixed(2)}</PortalStackingCell>
                      <PortalStackingCell className="font-bold text-slate-900" label="Total value (EGP)">{row.amount.toFixed(2)}</PortalStackingCell>
                    </tr>
                  ))}
                </tbody>
                <tfoot className={portalStackingBodyClassName}>
                  <tr className={`${portalStackingRowClassName} border-t-2 border-slate-300 font-black text-slate-900`}>
                    <PortalStackingCell label="Employee">Total</PortalStackingCell>
                    <PortalStackingCell label="Days confirmed">{allSummary.reduce((sum, row) => sum + row.count, 0)}</PortalStackingCell>
                    <PortalStackingCell label="Total days">{allSummary.reduce((sum, row) => sum + row.days, 0).toFixed(2)}</PortalStackingCell>
                    <PortalStackingCell label="Total value (EGP)">{allSummary.reduce((sum, row) => sum + row.amount, 0).toFixed(2)}</PortalStackingCell>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </AdminTableShell>
      ) : !initialReport ? (
        <AdminCallout tone="warning">Pick an employee above and click View Report to see day-by-day detail.</AdminCallout>
      ) : initialReport.tier === null && Object.keys(initialDecisions).length === 0 ? (
        <AdminCallout tone="warning">
          {initialReport.employeeName} isn&apos;t on the flexible-hours model (no required-minutes policy) — this report has no
          detail to show for them.
        </AdminCallout>
      ) : (
        <>
          {initialReport.tier === null ? (
            <AdminCallout tone="warning">
              {initialReport.employeeName} isn&apos;t on the flexible-hours model (no required-minutes policy) — the system
              can&apos;t judge any day for them. The row(s) below with an existing recorded deduction are shown so you can
              still confirm or reject it; every other day just shows &quot;Not on flexible-hours model&quot;.
            </AdminCallout>
          ) : null}
            {tab === "detail" ? (
              <AdminTableShell
                description={`${initialReport.employeeName} · ${initialReport.jobTitle} · ${initialReport.dateFromIso} to ${initialReport.dateToIso} · ${totals?.deductionDays ?? 0} day(s) flagged · ${(totals?.deductionValue ?? 0).toFixed(2)} EGP flagged`}
                title="Day-by-Day Detail"
              >
                <table className={`${portalStackingTableClassName} md:w-full md:table-fixed`}>
                  <colgroup>
                    <col className="w-[11%]" />
                    <col className="w-[22%]" />
                    <col className="w-[11%]" />
                    <col className="w-[18%]" />
                    <col className="w-[28%]" />
                    <col className="w-[10%]" />
                  </colgroup>
                  <thead className={portalStackingHeadClassName}>
                    <tr className="border-b border-slate-200 text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Outcome</th>
                      <th className="px-3 py-2">Punches</th>
                      <th className="px-3 py-2">Worked</th>
                      <th className="px-3 py-2">Deduction</th>
                      <th className="px-3 py-2 text-center">Approve</th>
                    </tr>
                  </thead>
                  <tbody className={`${portalStackingBodyClassName} divide-y divide-slate-100`}>
                    {initialReport.days.map((day) => {
                      const decision = decisions[day.dateIso];
                      const approved = decision?.decisionStatus === "Approved for Payroll";
                      const rejected = decision?.decisionStatus === "Do Not Take Action";
                      const defaultDays = decision?.appliedDeductionValue ?? (day.deductionDays > 0 ? day.deductionDays : 0);
                      const value = liveValue(day.dateIso, defaultDays, editedDays[day.dateIso], initialReport.baseSalary, decision?.appliedAmount ?? day.deductionValue);
                      return (
                        <tr className={`${portalStackingRowClassName} align-top`} key={day.dateIso}>
                          <PortalStackingCell className="break-words font-semibold text-slate-900" label="Date">
                            {day.dateIso}
                            <div className="text-phx-xs font-medium text-slate-400">{day.weekday}</div>
                          </PortalStackingCell>
                          <PortalStackingCell className="min-w-0 break-words" label="Outcome">
                            <span className={`inline-flex border px-2 py-0.5 text-phx-xs font-bold ${OUTCOME_TONE[day.outcome]}`}>
                              {OUTCOME_LABEL[day.outcome]}
                            </span>
                            {day.reason ? <div className="mt-1 text-xs font-medium text-slate-500">{day.reason}</div> : null}
                          </PortalStackingCell>
                          <PortalStackingCell className="break-words text-slate-700" label="Punches">
                            {formatClock(day.firstPunchMinutes)} – {formatClock(day.lastPunchMinutes)}
                          </PortalStackingCell>
                          <PortalStackingCell className="break-words text-slate-700" label="Worked">
                            {formatDuration(day.workedMinutes)}
                            {day.lateMinutes > 0 ? <div className="text-xs text-slate-500">Late {day.lateMinutes} min</div> : null}
                            {day.shortMinutes > 0 ? <div className="text-xs text-slate-500">Short {day.shortMinutes} min</div> : null}
                          </PortalStackingCell>
                          <PortalStackingCell className="font-bold text-slate-900" label="Deduction">
                            <div className="flex flex-wrap items-center gap-2">
                              <Input
                                key={`${day.dateIso}:${defaultDays}`}
                                type="number"
                                step="0.01"
                                min="0"
                                defaultValue={defaultDays}
                                disabled={busyDate === day.dateIso}
                                onChange={(event) => setEditedDays((prev) => ({ ...prev, [day.dateIso]: event.target.value }))}
                                className="h-8 w-20"
                                aria-label="Deduction days"
                              />
                              <span>{value > 0 ? `${value.toFixed(2)} EGP` : "—"}</span>
                            </div>
                          </PortalStackingCell>
                          <PortalStackingCell className="text-center align-top" label="Approve">
                            <input
                              type="checkbox"
                              checked={approved}
                              disabled={busyDate === day.dateIso}
                              onChange={(event) => {
                                const editedValue = editedDays[day.dateIso];
                                const days = editedValue?.trim() ? Number(editedValue) : defaultDays;
                                void decide(day.dateIso, event.target.checked ? "Approved for Payroll" : "Do Not Take Action", days);
                              }}
                              className="h-5 w-5 cursor-pointer accent-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                            />
                            {rejected ? <div className="text-phx-2xs font-semibold text-rose-600">Rejected</div> : null}
                          </PortalStackingCell>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </AdminTableShell>
            ) : (
              <AdminTableShell
                description={`${initialReport.employeeName} · confirmed for payroll · ${confirmedTotals.days.toFixed(2)} day(s) · ${confirmedTotals.value.toFixed(2)} EGP total`}
                title="FP Deductions Summary"
              >
                {confirmed.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-slate-500">No days confirmed yet for this employee in this range.</p>
                ) : (
                  <table className={`${portalStackingTableClassName} md:w-full md:table-fixed`}>
                    <colgroup>
                      <col className="w-[14%]" />
                      <col className="w-[34%]" />
                      <col className="w-[26%]" />
                      <col className="w-[26%]" />
                    </colgroup>
                    <thead className={portalStackingHeadClassName}>
                      <tr className="border-b border-slate-200 text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">
                        <th className="px-3 py-2">Date</th>
                        <th className="px-3 py-2">Outcome</th>
                        <th className="px-3 py-2">Days</th>
                        <th className="px-3 py-2">Value (EGP)</th>
                      </tr>
                    </thead>
                    <tbody className={`${portalStackingBodyClassName} divide-y divide-slate-100`}>
                      {confirmed.map(({ day, decision }) => (
                        <tr className={portalStackingRowClassName} key={day.dateIso}>
                          <PortalStackingCell className="break-words font-semibold text-slate-900" label="Date">
                            {day.dateIso}
                            <div className="text-phx-xs font-medium text-slate-400">{day.weekday}</div>
                          </PortalStackingCell>
                          <PortalStackingCell className="min-w-0 break-words" label="Outcome">
                            <span className={`inline-flex border px-2 py-0.5 text-phx-xs font-bold ${OUTCOME_TONE[day.outcome]}`}>
                              {OUTCOME_LABEL[day.outcome]}
                            </span>
                            {day.reason ? <div className="mt-1 text-xs font-medium text-slate-500">{day.reason}</div> : null}
                          </PortalStackingCell>
                          <PortalStackingCell className="font-bold text-slate-900" label="Days">
                            {decision?.appliedDeductionValue ?? "—"}
                          </PortalStackingCell>
                          <PortalStackingCell className="font-bold text-slate-900" label="Value (EGP)">
                            {(decision?.appliedAmount ?? 0).toFixed(2)}
                          </PortalStackingCell>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className={portalStackingBodyClassName}>
                      <tr className={`${portalStackingRowClassName} border-t-2 border-slate-300 font-black text-slate-900`}>
                        <PortalStackingCell label="Total">All confirmed days</PortalStackingCell>
                        <PortalStackingCell label="Days">{confirmedTotals.days.toFixed(2)}</PortalStackingCell>
                        <PortalStackingCell label="Value (EGP)">{confirmedTotals.value.toFixed(2)}</PortalStackingCell>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </AdminTableShell>
            )}
        </>
      )}
    </div>
  );
}

