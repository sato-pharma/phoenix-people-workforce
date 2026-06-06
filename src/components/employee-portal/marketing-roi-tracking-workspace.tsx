"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock, RefreshCcw, Target, TrendingDown, TrendingUp } from "lucide-react";

import { Card } from "@/components/ui/card";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import type {
  MarketingRoiTrackingRow,
  MarketingRoiTrackingWorkspace as MarketingRoiTrackingWorkspacePayload,
} from "@/lib/marketing-requests/types";

const moneyFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function money(value: number) {
  return moneyFormatter.format(Math.round(Number.isFinite(value) ? value : 0));
}

function percent(ratio: number) {
  return `${Math.round((Number.isFinite(ratio) ? ratio : 0) * 100)}%`;
}

function emptyWorkspace(): MarketingRoiTrackingWorkspacePayload {
  return {
    rows: [],
    summary: { behind: 0, noData: 0, onTrack: 0, total: 0, totalActualValue: 0, totalRequiredValue: 0 },
  };
}

function ActualStatusBadge({ status }: { status: MarketingRoiTrackingRow["actualRoiStatus"] }) {
  const config = {
    on_track: { className: "border-emerald-200 bg-emerald-50 text-emerald-700", label: "On track" },
    behind: { className: "border-amber-200 bg-amber-50 text-amber-700", label: "Behind" },
    no_data: { className: "border-slate-200 bg-slate-50 text-slate-500", label: "No sales yet" },
  }[status];

  return (
    <span className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${config.className}`}>
      {config.label}
    </span>
  );
}

function MetricCard({
  accent,
  icon: Icon,
  label,
  value,
}: {
  accent: "slate" | "green" | "amber" | "blue";
  icon: typeof CheckCircle2;
  label: string;
  value: string | number;
}) {
  const accentStyles = {
    slate: "border-l-slate-500",
    green: "border-l-emerald-500",
    amber: "border-l-amber-500",
    blue: "border-l-sky-500",
  };
  const iconStyles = {
    slate: "text-slate-600",
    green: "text-emerald-600",
    amber: "text-amber-600",
    blue: "text-sky-600",
  };

  return (
    <div className={`rounded-sm border border-slate-200 border-l-[3px] bg-white px-3.5 py-3 ${accentStyles[accent]}`}>
      <div className="flex items-center gap-2">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${iconStyles[accent]}`} />
        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">{label}</p>
      </div>
      <p className="mt-1.5 text-[22px] font-black leading-none text-slate-900">{value}</p>
    </div>
  );
}

export function MarketingRoiTrackingWorkspace() {
  const [workspace, setWorkspace] = useState<MarketingRoiTrackingWorkspacePayload>(emptyWorkspace);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  async function loadWorkspace() {
    try {
      const response = await fetch("/api/marketing-requests/roi-tracking", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        setWorkspace(emptyWorkspace());
        setMessage(payload.message ?? "Unable to load ROI tracking.");
        return;
      }
      setMessage(null);
      setWorkspace({
        rows: payload.rows ?? [],
        summary: payload.summary ?? emptyWorkspace().summary,
      });
    } catch {
      setWorkspace(emptyWorkspace());
      setMessage("Unable to load ROI tracking.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadWorkspace();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  const rows = workspace.rows;
  const summaryCoverage = useMemo(() => {
    return workspace.summary.totalRequiredValue > 0
      ? workspace.summary.totalActualValue / workspace.summary.totalRequiredValue
      : 0;
  }, [workspace.summary.totalActualValue, workspace.summary.totalRequiredValue]);

  return (
    <WorkspaceErrorBoundary fallbackTitle="ROI tracking error">
      <div className="space-y-4" dir="auto">
        {/* Summary metrics */}
        <div className="rounded-sm border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="grid flex-1 grid-cols-2 gap-2 xs:grid-cols-4">
              <MetricCard accent="slate" icon={Target} label="Tracked" value={workspace.summary.total} />
              <MetricCard accent="green" icon={TrendingUp} label="On track" value={workspace.summary.onTrack} />
              <MetricCard accent="amber" icon={TrendingDown} label="Behind" value={workspace.summary.behind} />
              <MetricCard accent="blue" icon={Clock} label="No sales yet" value={workspace.summary.noData} />
            </div>
            <button
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-slate-200 bg-white text-slate-600 transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-600"
              onClick={() => {
                setIsLoading(true);
                void loadWorkspace();
              }}
              title="Refresh data"
              type="button"
            >
              {isLoading ? <LoadingSpinner /> : <RefreshCcw className="h-3.5 w-3.5" />}
            </button>
          </div>
          {!isLoading && workspace.summary.total > 0 ? (
            <p className="mt-3 text-[12px] font-semibold text-slate-600">
              Realized {money(workspace.summary.totalActualValue)} of {money(workspace.summary.totalRequiredValue)} required
              {" "}
              <span className="text-slate-400">({percent(summaryCoverage)} overall)</span>
            </p>
          ) : null}
        </div>

        {message ? (
          <div className="rounded-sm border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] font-semibold text-amber-800">
            {message}
          </div>
        ) : null}

        <Card className="overflow-hidden rounded-sm border border-slate-200 bg-white p-0 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.14em] text-orange-600">ROI Tracking</p>
              <h2 className="mt-1 text-lg font-black tracking-tight text-slate-900">Actual vs required return</h2>
            </div>
            <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-bold text-slate-600">
              {rows.length} request{rows.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] border-collapse text-left text-[13px]">
              <thead className="bg-slate-50 text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
                <tr>
                  <th className="border-r border-slate-100 px-3 py-2.5">Request</th>
                  <th className="border-r border-slate-100 px-3 py-2.5">Customer</th>
                  <th className="border-r border-slate-100 px-3 py-2.5">Line</th>
                  <th className="border-r border-slate-100 px-3 py-2.5">ROI Window</th>
                  <th className="border-r border-slate-100 px-3 py-2.5 text-right">Required ROI</th>
                  <th className="border-r border-slate-100 px-3 py-2.5 text-right">Expected ROI</th>
                  <th className="border-r border-slate-100 px-3 py-2.5 text-right">Actual Sales</th>
                  <th className="border-r border-slate-100 px-3 py-2.5 text-right">Coverage</th>
                  <th className="px-3 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="bg-white">
                {isLoading ? (
                  <tr>
                    <td className="px-4 py-6 text-center text-[13px] font-medium text-slate-500" colSpan={9}>
                      <span className="inline-flex items-center gap-2"><LoadingSpinner /> Loading ROI tracking...</span>
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td className="px-4 py-6 text-center text-[13px] font-medium text-slate-500" colSpan={9}>
                      No approved requests to track yet.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr className="border-t border-slate-100" key={row.id}>
                      <td className="border-r border-slate-100 px-3 py-2.5 font-mono text-[12px] font-bold text-slate-900">{row.requestCode}</td>
                      <td className="border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-800">{row.customerName}</td>
                      <td className="border-r border-slate-100 px-3 py-2.5 font-medium text-slate-600">{row.line ?? "—"}</td>
                      <td className="border-r border-slate-100 px-3 py-2.5 font-medium text-slate-600">{row.roiWindow ?? "—"}</td>
                      <td className="border-r border-slate-100 px-3 py-2.5 text-right font-semibold text-slate-700">{money(row.requiredRoiValue)}</td>
                      <td className="border-r border-slate-100 px-3 py-2.5 text-right font-medium text-slate-600">{money(row.expectedRoiValue)}</td>
                      <td className="border-r border-slate-100 px-3 py-2.5 text-right font-bold text-slate-900">{money(row.actualSalesValue)}</td>
                      <td className="border-r border-slate-100 px-3 py-2.5 text-right font-bold text-slate-900">
                        {row.hasSalesData ? percent(row.actualCoverageRatio) : "—"}
                      </td>
                      <td className="px-3 py-2.5"><ActualStatusBadge status={row.actualRoiStatus} /></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </WorkspaceErrorBoundary>
  );
}
