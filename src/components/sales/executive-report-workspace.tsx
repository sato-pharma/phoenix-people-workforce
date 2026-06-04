"use client";

import { AlertTriangle, Download, Loader2, Building2 } from "lucide-react";
import { useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/sales/format";
import type { ExecutiveReportView } from "@/lib/sales/executive-report";

type Props = {
  initialError: string | null;
  initialView: ExecutiveReportView | null;
};

type ViewResponse = { data?: ExecutiveReportView; error?: string; success: boolean };

const ALL = "all";

function periodText(period: string | null) {
  return period ?? "All-time";
}

export function ExecutiveReportWorkspace({ initialError, initialView }: Props) {
  const [view, setView] = useState<ExecutiveReportView | null>(initialView);
  const [selected, setSelected] = useState<string>(initialView?.period ?? ALL);
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  const availablePeriods = view?.availablePeriods ?? [];

  async function reload(period: string) {
    setSelected(period);
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/sales/executive-report?period=${encodeURIComponent(period)}`, { cache: "no-store" });
      const text = await response.text();
      const payload: ViewResponse = text ? JSON.parse(text) : { success: response.ok };
      if (payload.success && payload.data) {
        setView(payload.data);
      } else {
        setError(payload.error ?? "Failed to load Executive Report.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load Executive Report.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleExport() {
    setIsExporting(true);
    try {
      const response = await fetch("/api/sales/executive-report/export", {
        body: JSON.stringify({ period: selected }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="(.+?)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? "phoenix-executive-report.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Export failed.");
    } finally {
      setIsExporting(false);
    }
  }

  if (initialError && !view) {
    return (
      <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-[#E2E8F0] bg-[#F8FAFC] p-5 sm:p-6 xl:p-8">
        <AdminCallout tone="danger">
          <AlertTriangle className="h-4 w-4" />
          <p>{initialError}</p>
        </AdminCallout>
      </div>
    );
  }

  const national = view?.national;
  const selectClassName =
    "h-11 w-full rounded-2xl border border-[#D8E0EA] bg-[#F8FAFC] px-3.5 text-sm font-semibold text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-4 focus:ring-[#F97316]/10 disabled:opacity-60";
  const thBase = "whitespace-nowrap px-3 py-2 text-left";
  const tdBase = "whitespace-nowrap px-3 py-2";

  return (
    <div className="min-h-[calc(100vh-7rem)] space-y-7">
      <AdminPageHero
        badges={(
          <>
            <AdminInsightChip>Period: {periodText(view?.period ?? null)}</AdminInsightChip>
            <AdminInsightChip tone="slate">Lines: {view?.byLine.length ?? 0}</AdminInsightChip>
            <AdminInsightChip tone="slate">Distributors: {view?.distributorCount ?? 0}</AdminInsightChip>
            <AdminInsightChip tone="orange">Company-wide, all lines & products</AdminInsightChip>
          </>
        )}
        description="One company-wide executive comparison across every line, product, distributor, region and area. Download the full Phoenix-branded workbook (live formulas, no charts)."
        eyebrow="Executive Report"
        icon={<Building2 className="h-4 w-4" />}
        title="Executive Report"
      />

      <AdminTableShell
        action={(
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex flex-col gap-1 sm:w-52">
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Period</span>
              <select
                className={selectClassName}
                disabled={isLoading}
                onChange={(event) => void reload(event.target.value)}
                value={selected}
              >
                <option value={ALL}>All-time (all months)</option>
                {availablePeriods.map((period) => (
                  <option key={period} value={period}>{period}</option>
                ))}
              </select>
            </label>
            <button
              className={cn(
                "inline-flex h-11 shrink-0 items-center gap-2 border border-[#0B0B0B] bg-[#0B0B0B] px-4 text-sm font-bold text-white transition hover:bg-[#F97316] disabled:opacity-50",
              )}
              disabled={isExporting || isLoading || !view}
              onClick={() => void handleExport()}
              type="button"
            >
              {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Download Executive XLSX
            </button>
          </div>
        )}
        description="Preview the company totals and per-line split below. The downloaded workbook adds By Distributor, By Region & Area, Rankings, Mix and Gaps — every number a live formula."
        title="Company Overview"
      >
        {error ? (
          <div className="p-4 md:p-5">
            <AdminCallout tone="danger">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <p>{error}</p>
            </AdminCallout>
          </div>
        ) : !national || national.value === 0 ? (
          <div className="p-4 md:p-5">
            <AdminCallout tone="neutral">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <p>No validated Source of Sales data for this period yet. Upload and validate distributor sheets first.</p>
            </AdminCallout>
          </div>
        ) : (
          <div className="space-y-6 p-4 md:p-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
              {[
                { label: "Total Value (EGP)", value: formatCurrency(national.value) },
                { label: "Total Units", value: formatNumber(national.units) },
                { label: "Lines", value: formatNumber(view!.byLine.length) },
                { label: "Products", value: formatNumber(national.productCount) },
                { label: "Areas", value: formatNumber(national.areaCount) },
                { label: "Customers", value: formatNumber(national.customerCount) },
              ].map((kpi) => (
                <div className="border border-[#E2E8F0] bg-white p-3" key={kpi.label}>
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{kpi.label}</p>
                  <p className="mt-1 text-lg font-black tabular-nums text-slate-900">{kpi.value}</p>
                </div>
              ))}
            </div>

            <div className="overflow-x-auto border border-[#E2E8F0]">
              <table className="w-full text-sm">
                <thead className="bg-[#0B0B0B] text-[#F1F5F9]">
                  <tr>
                    <th className={thBase}>Line</th>
                    <th className={`${thBase} text-right`}>Units</th>
                    <th className={`${thBase} text-right`}>Value (EGP)</th>
                    <th className={`${thBase} text-right`}>% Share</th>
                    <th className={`${thBase} text-right`}>Products</th>
                    <th className={`${thBase} text-right`}>Areas</th>
                    <th className={`${thBase} text-right`}>Distributors</th>
                  </tr>
                </thead>
                <tbody>
                  {view!.byLine.map((line, index) => (
                    <tr className={index % 2 === 1 ? "bg-[#F8FAFC]" : ""} key={line.officialLine}>
                      <td className={`${tdBase} font-semibold text-slate-900`}>{line.officialLine}</td>
                      <td className={`${tdBase} text-right tabular-nums text-slate-700`}>{formatNumber(line.units)}</td>
                      <td className={`${tdBase} text-right tabular-nums text-slate-700`}>{formatCurrency(line.value)}</td>
                      <td className={`${tdBase} text-right tabular-nums text-slate-700`}>{formatPercent(line.valueShare, { input: "ratio" })}</td>
                      <td className={`${tdBase} text-right tabular-nums text-slate-700`}>{formatNumber(line.productCount)}</td>
                      <td className={`${tdBase} text-right tabular-nums text-slate-700`}>{formatNumber(line.areaCount)}</td>
                      <td className={`${tdBase} text-right tabular-nums text-slate-700`}>{formatNumber(line.distributorCount)}</td>
                    </tr>
                  ))}
                  <tr className="bg-[#0B0B0B] text-white">
                    <td className={`${tdBase} font-black`}>ALL LINES</td>
                    <td className={`${tdBase} text-right font-black tabular-nums`}>{formatNumber(national.units)}</td>
                    <td className={`${tdBase} text-right font-black tabular-nums`}>{formatCurrency(national.value)}</td>
                    <td className={`${tdBase} text-right font-black tabular-nums`}>100%</td>
                    <td className={`${tdBase} text-right font-black tabular-nums`}>{formatNumber(national.productCount)}</td>
                    <td className={`${tdBase} text-right font-black tabular-nums`}>{formatNumber(national.areaCount)}</td>
                    <td className={`${tdBase} text-right font-black tabular-nums`}>{formatNumber(view!.distributorCount)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </AdminTableShell>
    </div>
  );
}
