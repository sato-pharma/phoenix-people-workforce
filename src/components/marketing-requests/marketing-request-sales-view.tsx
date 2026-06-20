"use client";

import * as React from "react";
import { AlertTriangle, ArrowLeftRight, CalendarRange, Download, ExternalLink, RefreshCcw, Target } from "lucide-react";

import { LoadingSpinner } from "@/components/ui/loading-state";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import type { MarketingRoiViewSales, MarketingRoiViewSalesAggregate } from "@/lib/marketing-requests/roi-report-types";
import { cn } from "@/lib/utils";

const moneyFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const unitFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function money(value: number) {
  return moneyFormatter.format(Math.round(Number.isFinite(value) ? value : 0));
}
function units(value: number) {
  return unitFormatter.format(Number.isFinite(value) ? value : 0);
}
function percent(ratio: number) {
  return `${Math.round((Number.isFinite(ratio) ? ratio : 0) * 100)}%`;
}

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  pending_validation: "Pending validation",
  pending_approval: "Pending approval",
  returned: "Returned",
  rejected: "Rejected",
  approved: "Approved",
  active: "Active",
  roi_tracking: "ROI tracking",
  closed: "Closed",
  finance_hold: "Finance hold",
};

function StatCard({ label, value, hint, accent = "slate" }: { label: string; value: string; hint?: string; accent?: "slate" | "orange" | "green" | "sky" }) {
  const border = { slate: "border-l-slate-500", orange: "border-l-[#F97316]", green: "border-l-emerald-500", sky: "border-l-sky-500" }[accent];
  return (
    <div className={cn("rounded-[6px] border border-[#E2E8F0] border-l-[3px] bg-white px-3.5 py-3 shadow-sm", border)}>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">{label}</p>
      <p className="mt-1.5 text-[22px] font-black leading-none text-[#0F172A]">{value}</p>
      {hint ? <p className="mt-1 text-[11px] font-semibold text-[#94A3B8]">{hint}</p> : null}
    </div>
  );
}

function AggregateTable({ title, rows, max }: { title: string; rows: MarketingRoiViewSalesAggregate[]; max: number }) {
  return (
    <section className="overflow-hidden rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm">
      <div className="border-b border-[#E2E8F0] px-4 py-2.5">
        <h3 className="text-[12px] font-black uppercase tracking-[0.12em] text-[#0F172A]">{title}</h3>
      </div>
      <div className="max-h-72 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-4 py-4 text-[12px] font-medium text-[#94A3B8]">No matched sales.</p>
        ) : (
          rows.map((row) => (
            <div key={row.key} className="flex items-center gap-2 border-b border-[#F1F5F9] px-4 py-2 last:border-b-0">
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[#334155]" title={row.label}>{row.label}</span>
              <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-[#F1F5F9]">
                <div className="h-full rounded-full bg-[#F97316]" style={{ width: `${max > 0 ? Math.max(3, Math.round((row.value / max) * 100)) : 0}%` }} />
              </div>
              <span className="w-20 shrink-0 text-right text-[12px] font-bold text-[#0F172A]">{money(row.value)}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export function MarketingRequestSalesView({ requestId, viewSalesBasePath }: { requestId: string; viewSalesBasePath: string }) {
  const [data, setData] = React.useState<MarketingRoiViewSales | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [exporting, setExporting] = React.useState(false);

  const load = React.useCallback(async (fromPeriod: string, toPeriod: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (fromPeriod) params.set("from", fromPeriod);
      if (toPeriod) params.set("to", toPeriod);
      const query = params.toString();
      const response = await fetch(`/api/marketing-requests/${requestId}/view-sales${query ? `?${query}` : ""}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        setData(null);
        setError(payload.message ?? "Unable to load sales for this request.");
        return;
      }
      setData(payload as MarketingRoiViewSales);
    } catch {
      setData(null);
      setError("Unable to load sales for this request.");
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      // defer one microtask so the initial fetch's setState is not synchronous in the effect body
      await Promise.resolve();
      if (!cancelled) await load("", "");
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function downloadExport() {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const query = params.toString();
      const response = await fetch(`/api/marketing-requests/${requestId}/view-sales/export${query ? `?${query}` : ""}`, { cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.message ?? "Export failed.");
        return;
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="(.+?)"/);
      const filename = match ? match[1] : "phoenix-roi-view-sales.xlsx";
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      setError("Export failed.");
    } finally {
      setExporting(false);
    }
  }

  const maxProduct = data ? Math.max(0, ...data.byProduct.map((row) => row.value)) : 0;
  const maxPharmacy = data ? Math.max(0, ...data.byPharmacy.map((row) => row.value)) : 0;
  const maxMonth = data ? Math.max(0, ...data.byMonth.map((row) => row.value)) : 0;

  return (
    <WorkspaceErrorBoundary fallbackTitle="View Sales error">
      <div className="space-y-4" dir="auto">
        {loading && !data ? (
          <div className="flex items-center gap-2 rounded-[6px] border border-[#E2E8F0] bg-white px-4 py-8 text-[13px] font-semibold text-[#64748B] shadow-sm">
            <LoadingSpinner /> Loading sales for this request…
          </div>
        ) : error ? (
          <div className="rounded-[6px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] font-semibold text-amber-800">{error}</div>
        ) : data ? (
          <>
            {/* Context */}
            <section className="rounded-[6px] border border-[#E2E8F0] bg-white p-4 shadow-sm sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#F97316]">View Sales · {data.context.requestCode}</p>
                  <h2 className="mt-1 text-lg font-black tracking-tight text-[#0F172A]">{data.context.customerName}</h2>
                  <p className="mt-1 text-[12px] font-semibold text-[#64748B]">
                    {data.context.requesterName ?? data.context.requesterHrId}
                    {data.context.line ? ` · ${data.context.line}` : ""}
                    {data.context.requestTypeName ? ` · ${data.context.requestTypeName}` : ""}
                    {" · "}{STATUS_LABELS[data.context.status] ?? data.context.status}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1 text-right">
                  <span className="inline-flex items-center gap-1 rounded-[5px] border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-1 text-[11px] font-bold text-[#64748B]">
                    <CalendarRange className="h-3 w-3" /> ROI window {data.context.roiWindowLabel ?? "—"}
                  </span>
                  <span className="text-[11px] font-semibold text-[#94A3B8]">Sales data as of {data.salesDataAsOf ?? "n/a"}</span>
                </div>
              </div>

              {/* expected vs actual mini-band */}
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <StatCard accent="orange" label="Cost" value={money(data.context.estimatedCost)} />
                <StatCard accent="sky" label="Required ROI" value={money(data.context.requiredRoiValue)} hint="cost × 10" />
                <StatCard accent="green" label="Actual sales" value={money(data.actualValue)} hint={`${percent(data.coverageRatio)} of required`} />
                <StatCard accent="slate" label="Matched rows" value={units(data.totals.rows)} hint={`${units(data.totals.units)} units`} />
              </div>
              {data.context.products.length > 0 ? (
                <p className="mt-3 text-[11px] font-semibold text-[#94A3B8]">
                  Promoted products: <span className="text-[#475569]">{data.context.products.map((product) => product.name).join(", ")}</span>
                </p>
              ) : null}
            </section>

            {/* Range controls */}
            <section className="flex flex-wrap items-end gap-3 rounded-[6px] border border-[#E2E8F0] bg-white px-4 py-3 shadow-sm">
              <div className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">
                <CalendarRange className="h-3.5 w-3.5" /> Period range
                {data.range.isCustom ? (
                  <span className="rounded-[3px] bg-[#F97316] px-1 text-[9px] text-white">custom</span>
                ) : (
                  <span className="rounded-[3px] bg-[#0F172A] px-1 text-[9px] text-white">ROI window</span>
                )}
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wide text-[#94A3B8]">From</span>
                <input type="month" value={from} onChange={(event) => setFrom(event.target.value)} className="h-8 rounded-[5px] border border-[#E2E8F0] px-2 text-[12px] font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wide text-[#94A3B8]">To</span>
                <input type="month" value={to} onChange={(event) => setTo(event.target.value)} className="h-8 rounded-[5px] border border-[#E2E8F0] px-2 text-[12px] font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]" />
              </label>
              <button
                type="button"
                onClick={() => void load(from, to)}
                disabled={loading}
                className="inline-flex h-8 items-center gap-1.5 rounded-[6px] bg-[#F97316] px-3 text-[12px] font-black uppercase tracking-wide text-white transition hover:bg-[#EA580C] disabled:opacity-60"
              >
                {loading ? <LoadingSpinner /> : <Target className="h-3.5 w-3.5" />} Apply range
              </button>
              <button
                type="button"
                onClick={() => { setFrom(""); setTo(""); void load("", ""); }}
                className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-[#E2E8F0] bg-white px-3 text-[12px] font-bold text-[#64748B] transition hover:border-[#FDBA74] hover:text-[#F97316]"
              >
                <RefreshCcw className="h-3.5 w-3.5" /> Reset to ROI window
              </button>
              <button
                type="button"
                onClick={() => void downloadExport()}
                disabled={exporting}
                className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-[#0F172A] bg-[#0F172A] px-3 text-[12px] font-black uppercase tracking-wide text-white transition hover:bg-black disabled:opacity-60"
              >
                {exporting ? <LoadingSpinner /> : <Download className="h-3.5 w-3.5" />} Export XLSX
              </button>
            </section>

            {/* Monthly trend + breakdowns */}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <AggregateTable title="By month" rows={data.byMonth} max={maxMonth} />
              <AggregateTable title="By product" rows={data.byProduct} max={maxProduct} />
              <AggregateTable title="By pharmacy" rows={data.byPharmacy} max={maxPharmacy} />
            </div>

            {/* Detail rows */}
            <section className="overflow-hidden rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-[#E2E8F0] px-4 py-3">
                <h3 className="text-[13px] font-black uppercase tracking-[0.12em] text-[#0F172A]">Matched sales rows</h3>
                <span className="inline-flex items-center rounded-[5px] border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-1 text-[11px] font-bold text-[#64748B]">{data.rows.length} row{data.rows.length === 1 ? "" : "s"}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[920px] border-collapse text-left text-[13px]">
                  <thead className="bg-[#0F172A] text-[10px] font-black uppercase tracking-[0.12em] text-white">
                    <tr>
                      <th className="px-3 py-2.5">Period</th>
                      <th className="px-3 py-2.5">Distributor</th>
                      <th className="px-3 py-2.5">Product</th>
                      <th className="px-3 py-2.5">Customer code</th>
                      <th className="px-3 py-2.5">Pharmacy</th>
                      <th className="px-3 py-2.5 text-right">Units</th>
                      <th className="px-3 py-2.5 text-right">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.length === 0 ? (
                      <tr><td className="px-4 py-6 text-center text-[13px] font-medium text-[#64748B]" colSpan={7}>No sales matched in this period range.</td></tr>
                    ) : (
                      data.rows.map((row, index) => (
                        <tr key={`${row.customerCode}-${row.productCode}-${row.invoicePeriod}-${index}`} className="border-t border-[#FEE7D2]">
                          <td className="px-3 py-2 font-mono text-[12px] font-bold text-[#0F172A]">{row.invoicePeriod}</td>
                          <td className="px-3 py-2 font-medium text-[#64748B]">{row.distributorName}</td>
                          <td className="px-3 py-2 font-semibold text-[#334155]">{row.productName}</td>
                          <td className="px-3 py-2 font-mono text-[12px] text-[#64748B]">{row.customerCode}</td>
                          <td className="px-3 py-2 font-medium text-[#64748B]">{row.customerName ?? "—"}</td>
                          <td className="px-3 py-2 text-right font-semibold text-[#475569]">{units(row.qty)}</td>
                          <td className="px-3 py-2 text-right font-bold text-[#0F172A]">{money(row.value)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Reverse lookup */}
            {data.reverseLookup.length > 0 ? (
              <section className="overflow-hidden rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm">
                <div className="flex items-center gap-2 border-b border-[#E2E8F0] px-4 py-3">
                  <ArrowLeftRight className="h-3.5 w-3.5 text-[#F97316]" />
                  <h3 className="text-[13px] font-black uppercase tracking-[0.12em] text-[#0F172A]">Other requests targeting these pharmacies</h3>
                </div>
                <div className="divide-y divide-[#F1F5F9]">
                  {data.reverseLookup.map((row) => (
                    <div key={row.requestId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                      <div className="min-w-0">
                        <span className="font-mono text-[12px] font-bold text-[#0F172A]">{row.requestCode}</span>
                        <span className="ml-2 text-[12px] font-semibold text-[#64748B]">{row.requesterName ?? ""}</span>
                        <span className="ml-2 text-[11px] font-medium text-[#94A3B8]">{STATUS_LABELS[row.status] ?? row.status} · {row.sharedPharmacyCodes.length} shared pharmacy{row.sharedPharmacyCodes.length === 1 ? "" : "s"}</span>
                      </div>
                      <a
                        href={`${viewSalesBasePath}/marketing-requests/${row.requestId}/view-sales`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-[5px] border border-[#E2E8F0] bg-white px-2 py-1 text-[11px] font-black text-[#F97316] transition hover:border-[#FDBA74] hover:bg-[#FFF7ED]"
                      >
                        <ExternalLink className="h-3 w-3" /> View Sales
                      </a>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {!data.salesDataAsOf ? (
              <div className="flex items-center gap-2 rounded-[6px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12px] font-semibold text-amber-800">
                <AlertTriangle className="h-4 w-4 shrink-0" /> No validated sales data is loaded yet, so attribution may be incomplete.
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </WorkspaceErrorBoundary>
  );
}
