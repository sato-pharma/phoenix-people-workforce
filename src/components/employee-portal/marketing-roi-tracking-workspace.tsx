"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock, RefreshCcw, Target, TrendingDown, TrendingUp } from "lucide-react";

import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalPagination,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
  PortalSection,
} from "@/components/employee-portal/portal-primitives";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import type {
  MarketingRoiTrackingRow,
  MarketingRoiTrackingWorkspace as MarketingRoiTrackingWorkspacePayload,
} from "@/lib/marketing-requests/types";

const PAGE_SIZE = 20;

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

function AttributionBadge({ row }: { row: MarketingRoiTrackingRow }) {
  const config = {
    exact_customer: { className: "border-emerald-200 bg-emerald-50 text-emerald-700", label: "Exact" },
    brick_fallback: { className: "border-amber-200 bg-amber-50 text-amber-700", label: "Brick fallback" },
    mixed: { className: "border-sky-200 bg-sky-50 text-sky-700", label: "Mixed" },
    no_sales: { className: "border-slate-200 bg-slate-50 text-slate-500", label: "No sales" },
  }[row.attributionQuality];

  const title = row.hasSalesData
    ? `${row.exactSalesRows} exact row(s), ${row.fallbackSalesRows} brick fallback row(s)`
    : "No matched sales rows";

  return (
    <span
      className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${config.className}`}
      title={title}
    >
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
  const [page, setPage] = useState(1);

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
      setPage(1);
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
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedRows = useMemo(
    () => rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [rows, safePage],
  );
  const pageLabel = rows.length === 0
    ? "0 requests"
    : `${(safePage - 1) * PAGE_SIZE + 1}-${Math.min(safePage * PAGE_SIZE, rows.length)} of ${rows.length} requests`;
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

        <PortalSection
          actions={
            <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-bold text-slate-600">
              {rows.length} request{rows.length === 1 ? "" : "s"}
            </span>
          }
          eyebrow="ROI Tracking"
          title="Actual vs required return"
        >
          <PortalResponsiveDataList
            empty={
              isLoading ? (
                <div className="px-4 py-8 text-center text-[13px] font-medium text-slate-500">
                  <span className="inline-flex items-center gap-2"><LoadingSpinner /> Loading ROI tracking...</span>
                </div>
              ) : (
                <PortalEmptyState
                  message="Approved requests with measurable ROI windows will appear here."
                  title="No approved requests to track yet"
                />
              )
            }
            getKey={(row) => row.id}
            items={pagedRows}
            renderCard={(row) => (
              <PortalRecordCard
                accent={row.actualRoiStatus === "on_track" ? "emerald" : row.actualRoiStatus === "behind" ? "amber" : "slate"}
                meta={<span className="font-mono">{row.requestCode}</span>}
                status={<ActualStatusBadge status={row.actualRoiStatus} />}
                title={row.customerName}
              >
                <PortalRecordFields
                  fields={[
                    { label: "Line", value: row.line ?? "-" },
                    { label: "ROI window", value: row.roiWindow ?? "-" },
                    { label: "Required", value: money(row.requiredRoiValue) },
                    { label: "Expected", value: money(row.expectedRoiValue) },
                    { label: "Actual sales", value: money(row.actualSalesValue) },
                    { label: "Coverage", value: row.hasSalesData ? percent(row.actualCoverageRatio) : "-" },
                  ]}
                />
                <div className="mt-2">
                  <AttributionBadge row={row} />
                </div>
              </PortalRecordCard>
            )}
            renderTable={() => (
              <PortalDesktopTable className="text-[13px]" minWidth="1180px">
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
                  <th className="border-r border-slate-100 px-3 py-2.5">Attribution</th>
                  <th className="px-3 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="bg-white">
                {pagedRows.map((row) => (
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
                      <td className="border-r border-slate-100 px-3 py-2.5"><AttributionBadge row={row} /></td>
                      <td className="px-3 py-2.5"><ActualStatusBadge status={row.actualRoiStatus} /></td>
                    </tr>
                  ))}
              </tbody>
              </PortalDesktopTable>
            )}
          />
          <PortalPagination label={pageLabel}>
            <button
              className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-600 disabled:opacity-40"
              disabled={safePage <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              type="button"
            >
              Previous
            </button>
            <button
              className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-600 disabled:opacity-40"
              disabled={safePage >= totalPages}
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              type="button"
            >
              Next
            </button>
          </PortalPagination>
        </PortalSection>
      </div>
    </WorkspaceErrorBoundary>
  );
}
