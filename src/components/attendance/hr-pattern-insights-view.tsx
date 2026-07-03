"use client";

import { useState } from "react";
import { Lightbulb } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import type { HrPatternInsights } from "@/lib/attendance/hr-pattern-insights";

type Props = {
  initialInsights: HrPatternInsights | null;
  initialError: string | null;
};

function defaultDateFrom() {
  const date = new Date();
  date.setDate(date.getDate() - 90);
  return date.toISOString().slice(0, 10);
}

function defaultDateTo() {
  return new Date().toISOString().slice(0, 10);
}

export function HrPatternInsightsView({ initialInsights, initialError }: Props) {
  const [dateFrom, setDateFrom] = useState(initialInsights?.dateFrom ?? defaultDateFrom());
  const [dateTo, setDateTo] = useState(initialInsights?.dateTo ?? defaultDateTo());
  const [insights, setInsights] = useState(initialInsights);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ dateFrom, dateTo });
      const response = await fetch(`/api/attendance/hr-pattern-insights?${params.toString()}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "HR pattern insights failed to load.");
      setInsights(payload as HrPatternInsights);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "HR pattern insights failed to load.");
    } finally {
      setLoading(false);
    }
  }

  const maxWeekdayCount = Math.max(1, ...(insights?.weekdayPattern.map((row) => row.count) ?? [1]));

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={insights ? <AdminInsightChip tone="orange">{insights.totalSettlements} settlement(s) in range</AdminInsightChip> : null}
        description="Recurring signals mined from the settlement history — repeat deductions, non-responders, dispute patterns, and weekday clustering. Informational only; no automated action is taken."
        eyebrow="Attendance"
        icon={<Lightbulb className="h-3.5 w-3.5" />}
        title="HR Pattern Insights"
      />

      {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}

      <AdminTableShell
        action={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
              From
              <input
                className="h-9 rounded-lg border border-slate-200 px-2 text-xs font-semibold text-slate-900 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                type="date"
                value={dateFrom}
                onChange={(event) => setDateFrom(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
              To
              <input
                className="h-9 rounded-lg border border-slate-200 px-2 text-xs font-semibold text-slate-900 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                type="date"
                value={dateTo}
                onChange={(event) => setDateTo(event.target.value)}
              />
            </label>
            <Button disabled={loading} type="button" variant="secondary" onClick={load}>
              {loading ? "Loading…" : "Refresh"}
            </Button>
          </div>
        }
        description="Pick a date range and refresh to recompute every pattern below."
        title="Period"
      >
        <div className="p-4 text-xs font-semibold text-slate-500">
          {insights ? `Showing ${insights.dateFrom} to ${insights.dateTo}.` : "Pick a date range and refresh."}
        </div>
      </AdminTableShell>

      <AdminTableShell description="Employees with 3+ real deductions (confirmed, auto-confirmed, or dispute-rejected) in this period, ranked by total value." title="Repeat Offenders">
        {!insights || insights.repeatOffenders.length === 0 ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">No repeat patterns in this range.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {insights.repeatOffenders.map((row) => (
              <div className="flex flex-wrap items-center justify-between gap-3 p-4" key={row.employeeHrId}>
                <p className="text-sm font-black text-slate-950">{row.employeeName} ({row.employeeHrId})</p>
                <p className="text-xs font-semibold text-slate-500">
                  {row.settlementCount} deduction(s) &middot; {row.totalDeductionDays.toFixed(2)} day(s) &middot; {row.totalDeductionValue.toFixed(2)} EGP
                </p>
              </div>
            ))}
          </div>
        )}
      </AdminTableShell>

      <AdminTableShell description="Employees who let the 48h auto-confirm decide for them at least half the time — a possible sign they aren't seeing or engaging with their digest." title="Non-Responders">
        {!insights || insights.nonResponders.length === 0 ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">No non-responder pattern in this range.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {insights.nonResponders.map((row) => (
              <div className="flex flex-wrap items-center justify-between gap-3 p-4" key={row.employeeHrId}>
                <p className="text-sm font-black text-slate-950">{row.employeeName} ({row.employeeHrId})</p>
                <p className="text-xs font-semibold text-slate-500">
                  {row.autoConfirmedCount}/{row.totalCount} auto-confirmed &middot; {(row.autoConfirmRate * 100).toFixed(0)}%
                </p>
              </div>
            ))}
          </div>
        )}
      </AdminTableShell>

      <AdminTableShell description="Employees who disputed 2+ times — a high upheld rate may mean the system is misjudging them; a high rejected rate may mean the policy isn't understood." title="Dispute-Heavy">
        {!insights || insights.disputeHeavy.length === 0 ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">No dispute pattern in this range.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {insights.disputeHeavy.map((row) => (
              <div className="flex flex-wrap items-center justify-between gap-3 p-4" key={row.employeeHrId}>
                <p className="text-sm font-black text-slate-950">{row.employeeName} ({row.employeeHrId})</p>
                <p className="text-xs font-semibold text-slate-500">
                  {row.disputeCount} dispute(s) &middot; {row.upheldCount} upheld &middot; {row.rejectedCount} rejected &middot; {(row.upheldRate * 100).toFixed(0)}% upheld
                </p>
              </div>
            ))}
          </div>
        )}
      </AdminTableShell>

      <AdminTableShell description="Which day of the week clusters the most late/short-hours deductions, org-wide." title="Weekday Pattern">
        {!insights ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">Pick a date range and refresh.</div>
        ) : (
          <div className="space-y-2 p-4">
            {insights.weekdayPattern.map((row) => (
              <div className="flex items-center gap-3" key={row.weekday}>
                <span className="w-24 shrink-0 text-xs font-black text-slate-700">{row.weekday}</span>
                <div className="h-4 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-orange-400" style={{ width: `${(row.count / maxWeekdayCount) * 100}%` }} />
                </div>
                <span className="w-32 shrink-0 text-right text-xs font-semibold text-slate-500">
                  {row.count} &middot; {row.totalValue.toFixed(2)} EGP
                </span>
              </div>
            ))}
          </div>
        )}
      </AdminTableShell>

      <AdminTableShell description="Employees with 2+ missing-punch cases in this period — zero EGP impact, but a repeat pattern worth a conversation." title="Missing-Punch Repeaters">
        {!insights || insights.missingPunchRepeaters.length === 0 ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">No repeat missing-punch pattern in this range.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {insights.missingPunchRepeaters.map((row) => (
              <div className="flex flex-wrap items-center justify-between gap-3 p-4" key={row.employeeHrId}>
                <p className="text-sm font-black text-slate-950">{row.employeeName} ({row.employeeHrId})</p>
                <p className="text-xs font-semibold text-slate-500">{row.caseCount} case(s)</p>
              </div>
            ))}
          </div>
        )}
      </AdminTableShell>
    </div>
  );
}
