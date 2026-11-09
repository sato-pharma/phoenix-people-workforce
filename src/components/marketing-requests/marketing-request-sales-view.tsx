"use client";

import { requestStatusLabel } from "@/lib/approvals-hub/request-status-label";
import * as React from "react";
import { AlertTriangle, ArrowLeftRight, CalendarRange, Download, ExternalLink, RefreshCcw, Target } from "lucide-react";

import { LoadingSpinner } from "@/components/ui/loading-state";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import type { MarketingRoiViewSales, MarketingRoiViewSalesAggregate, MarketingRoiViewSalesRow } from "@/lib/marketing-requests/roi-report-types";
import { DirectTrackingToggle } from "@/components/marketing-requests/direct-tracking-toggle";
import { MarketingRoiExplainPanel } from "@/components/marketing-requests/roi-explain-panel";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { cn } from "@/lib/utils";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { adminPanelClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";

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
  archived: "Archived",
  cancelled: "Cancelled",
};

function StatCard({ label, value, hint, accent = "slate" }: { label: string; value: string; hint?: string; accent?: "slate" | "orange" | "green" | "sky" }) {
  const border = { slate: "border-l-slate-500", orange: "border-l-phx-accent", green: "border-l-emerald-500", sky: "border-l-sky-500" }[accent];
  return (
    <div className={cn("rounded-[6px] border border-phx-line border-l-[3px] bg-white px-3.5 py-3 shadow-sm", border)}>
      <p className="text-phx-sm font-black uppercase tracking-[0.14em] text-phx-ink-faint">{label}</p>
      <p className="mt-1.5 text-[22px] font-black leading-none text-phx-ink">{value}</p>
      {hint ? <p className="mt-1 text-phx-xs font-semibold text-phx-ink-faint">{hint}</p> : null}
    </div>
  );
}

function AggregateTable({ title, rows, max }: { title: string; rows: MarketingRoiViewSalesAggregate[]; max: number }) {
  return (
    <section className={`${adminPanelClassName} overflow-hidden rounded-[6px]`}>
      <div className="border-b border-phx-line px-4 py-2.5">
        <h3 className="text-phx-sm font-black uppercase tracking-[0.12em] text-phx-ink">{title}</h3>
      </div>
      <div className="max-h-72 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-4 py-4 text-phx-sm font-medium text-phx-ink-faint">No matched sales.</p>
        ) : (
          rows.map((row) => (
            <div key={row.key} className="flex items-center gap-2 border-b border-phx-paper-2 px-4 py-2 last:border-b-0">
              <span className="min-w-0 flex-1 break-words text-phx-sm font-semibold text-phx-ink-2">{row.label}</span>
              <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-md bg-phx-paper-2">
                <div className="h-full rounded-md bg-phx-accent" style={{ width: `${max > 0 ? Math.max(3, Math.round((row.value / max) * 100)) : 0}%` }} />
              </div>
              <span className="w-20 shrink-0 text-right text-phx-sm font-bold text-phx-ink">{money(row.value)}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

type SalesRowSortKey = "invoicePeriod" | "distributorName" | "productName" | "customerCode" | "customerName" | "qty" | "value";
type SortDirection = "asc" | "desc";

function sortSalesRows(rows: MarketingRoiViewSalesRow[], key: SalesRowSortKey, direction: SortDirection): MarketingRoiViewSalesRow[] {
  const dir = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
  });
}

export function MarketingRequestSalesView({ requestId, viewSalesBasePath }: { requestId: string; viewSalesBasePath: string }) {
  const [data, setData] = React.useState<MarketingRoiViewSales | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [exporting, setExporting] = React.useState(false);
  const [sort, setSort] = React.useState<{ key: SalesRowSortKey; direction: SortDirection }>({ direction: "desc", key: "invoicePeriod" });

  function toggleSort(key: SalesRowSortKey) {
    setSort((current) => (current.key === key ? { direction: current.direction === "asc" ? "desc" : "asc", key } : { direction: "asc", key }));
  }

  function sortArrow(key: SalesRowSortKey) {
    if (sort.key !== key) return "↕";
    return sort.direction === "asc" ? "↑" : "↓";
  }

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
  const sortedRows = React.useMemo(() => (data ? sortSalesRows(data.rows, sort.key, sort.direction) : []), [data, sort]);

  return (
    <WorkspaceErrorBoundary fallbackTitle="View Sales error">
      <div className="space-y-4" dir="auto">
        {loading && !data ? (
          <div className={`${adminSoftPanelClassName} flex items-center gap-2 rounded-[6px] px-4 py-8 text-phx-md font-semibold text-phx-ink-soft`}>
            <LoadingSpinner /> Loading sales for this request…
          </div>
        ) : error ? (
          <div className="rounded-[6px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-phx-md font-semibold text-amber-800">{error}</div>
        ) : data ? (
          <>
            {/* Context */}
            <section className={`${adminPanelClassName} rounded-[6px] p-4 sm:p-5`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-phx-sm font-black uppercase tracking-[0.16em] text-phx-accent">View Sales · {data.context.requestCode}</p>
                  <h2 className="mt-1 text-lg font-black tracking-tight text-phx-ink">{data.context.customerName}</h2>
                  <p className="mt-1 text-phx-sm font-semibold text-phx-ink-soft">
                    {data.context.requesterName ?? "Unknown requester"}
                    {data.context.line ? ` · ${data.context.line}` : ""}
                    {data.context.requestTypeName ? ` · ${data.context.requestTypeName}` : ""}
                    {" · "}{STATUS_LABELS[data.context.status] ?? requestStatusLabel(data.context.status)}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1 text-right">
                  <span className="inline-flex items-center gap-1 rounded-[5px] border border-phx-line bg-phx-paper px-2.5 py-1 text-phx-xs font-bold text-phx-ink-soft">
                    <CalendarRange className="h-3 w-3" /> ROI window {data.context.roiWindowLabel ?? "—"}
                  </span>
                  <span className="text-phx-xs font-semibold text-phx-ink-faint">Sales data as of {data.salesDataAsOf ?? "—"}</span>
                </div>
              </div>

              {/* expected vs actual mini-band */}
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <StatCard accent="orange" label="Cost" value={money(data.context.estimatedCost)} />
                <StatCard accent="sky" label="Required ROI" value={money(data.context.requiredRoiValue)} hint="cost × 10" />
                <StatCard accent="green" label="Actual sales" value={money(data.actualValue)} hint={`${percent(data.coverageRatio)} of required`} />
                <StatCard accent="slate" label="Matched rows" value={units(data.totals.rows)} hint={data.totals.units === null ? "Several products — read by value" : `${units(data.totals.units)} units`} />
              </div>
              {data.context.products.length > 0 ? (
                <p className="mt-3 text-phx-xs font-semibold text-phx-ink-faint">
                  Promoted products: <span className="text-phx-ink-2">{data.context.products.map((product) => product.name).join(", ")}</span>
                </p>
              ) : null}
              <DirectTrackingToggle requestId={requestId} />
            </section>

            {/* Range controls */}
            <section className={`${adminSoftPanelClassName} flex flex-wrap items-end gap-3 rounded-[6px] px-4 py-3`}>
              <div className="flex items-center gap-1.5 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">
                <CalendarRange className="h-3.5 w-3.5" /> Period range
                {data.range.isCustom ? (
                  <span className="rounded-[3px] bg-phx-accent px-1 text-phx-xs text-white">custom</span>
                ) : (
                  <span className="rounded-[3px] bg-phx-ink px-1 text-phx-xs text-white">ROI window</span>
                )}
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-phx-sm font-bold uppercase tracking-wide text-phx-ink-faint">From</span>
                <input type="month" value={from} onChange={(event) => setFrom(event.target.value)} className={phxFieldClassName} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-phx-sm font-bold uppercase tracking-wide text-phx-ink-faint">To</span>
                <input type="month" value={to} onChange={(event) => setTo(event.target.value)} className={phxFieldClassName} />
              </label>
              <button
                type="button"
                onClick={() => void load(from, to)}
                disabled={loading}
                className="inline-flex h-8 items-center gap-1.5 rounded-[6px] bg-phx-accent px-3 text-phx-sm font-black uppercase tracking-wide text-white transition hover:bg-phx-accent-hover disabled:opacity-60"
              >
                {loading ? <LoadingSpinner /> : <Target className="h-3.5 w-3.5" />} Apply range
              </button>
              <button
                type="button"
                onClick={() => { setFrom(""); setTo(""); void load("", ""); }}
                className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-phx-line bg-white px-3 text-phx-sm font-bold text-phx-ink-soft transition hover:border-phx-accent-line hover:text-phx-accent shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)]"
              >
                <RefreshCcw className="h-3.5 w-3.5" /> Reset to ROI window
              </button>
              <button
                type="button"
                onClick={() => void downloadExport()}
                disabled={exporting}
                className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-phx-ink bg-phx-ink px-3 text-phx-sm font-black uppercase tracking-wide text-white transition hover:bg-black disabled:opacity-60"
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
            <section className={`${adminPanelClassName} overflow-hidden rounded-[6px]`}>
              <div className="flex items-center justify-between border-b border-phx-line px-4 py-3">
                <h3 className="text-phx-md font-black uppercase tracking-[0.12em] text-phx-ink">Matched sales rows</h3>
                <span className="inline-flex items-center rounded-[5px] border border-phx-line bg-phx-paper px-2.5 py-1 text-phx-xs font-bold text-phx-ink-soft">{data.rows.length} row{data.rows.length === 1 ? "" : "s"}</span>
              </div>
              <PortalResponsiveDataList
                items={sortedRows}
                getKey={(row, index) => `${row.customerCode}-${row.productCode}-${row.invoicePeriod}-${index}`}
                empty={
                  <PortalEmptyState
                    title="No sales matched"
                    message="No sales matched in this period range."
                  />
                }
                renderCard={(row) => (
                  <PortalRecordCard
                    title={row.productName}
                    meta={`${row.invoicePeriod} · ${row.distributorName}`}
                    status={
                      <span className="whitespace-nowrap text-sm font-black text-phx-ink">
                        {money(row.value)} EGP
                      </span>
                    }
                  >
                    <PortalRecordFields
                      fields={[
                        { label: "Customer code", value: row.customerCode },
                        { label: "Pharmacy", value: row.customerName ?? "—" },
                        { label: "Units", value: units(row.qty) },
                      ]}
                    />
                  </PortalRecordCard>
                )}
                renderTable={() => (
                  <PortalDesktopTable
                    className="text-phx-md"
                    cols={
                      <colgroup>
                        <col className="w-[12%]" />
                        <col className="w-[18%]" />
                        <col className="w-[20%]" />
                        <col className="w-[13%]" />
                        <col className="w-[19%]" />
                        <col className="w-[8%]" />
                        <col className="w-[10%]" />
                      </colgroup>
                    }
                  >
                    <thead className="bg-phx-ink text-phx-sm font-black uppercase tracking-[0.12em] text-white">
                      <tr>
                        <th className="px-3 py-2.5">
                          <button type="button" onClick={() => toggleSort("invoicePeriod")} className="inline-flex items-center gap-1 font-black">Period {sortArrow("invoicePeriod")}</button>
                        </th>
                        <th className="px-3 py-2.5">
                          <button type="button" onClick={() => toggleSort("distributorName")} className="inline-flex items-center gap-1 font-black">Distributor {sortArrow("distributorName")}</button>
                        </th>
                        <th className="px-3 py-2.5">
                          <button type="button" onClick={() => toggleSort("productName")} className="inline-flex items-center gap-1 font-black">Product {sortArrow("productName")}</button>
                        </th>
                        <th className="px-3 py-2.5">
                          <button type="button" onClick={() => toggleSort("customerCode")} className="inline-flex items-center gap-1 font-black">Customer code {sortArrow("customerCode")}</button>
                        </th>
                        <th className="px-3 py-2.5">
                          <button type="button" onClick={() => toggleSort("customerName")} className="inline-flex items-center gap-1 font-black">Pharmacy {sortArrow("customerName")}</button>
                        </th>
                        <th className="px-3 py-2.5 text-right">
                          <button type="button" onClick={() => toggleSort("qty")} className="inline-flex items-center gap-1 font-black">Units {sortArrow("qty")}</button>
                        </th>
                        <th className="px-3 py-2.5 text-right">
                          <button type="button" onClick={() => toggleSort("value")} className="inline-flex items-center gap-1 font-black">Value {sortArrow("value")}</button>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRows.map((row, index) => (
                        <tr key={`${row.customerCode}-${row.productCode}-${row.invoicePeriod}-${index}`} className="border-t border-[#FEE7D2]">
                          <td className="break-words px-3 py-2 font-mono text-phx-sm font-bold text-phx-ink">{row.invoicePeriod}</td>
                          <td className="break-words px-3 py-2 font-medium text-phx-ink-soft">{row.distributorName}</td>
                          <td className="break-words px-3 py-2 font-semibold text-phx-ink-2">{row.productName}</td>
                          <td className="break-words px-3 py-2 font-mono text-phx-sm text-phx-ink-soft">{row.customerCode}</td>
                          <td className="break-words px-3 py-2 font-medium text-phx-ink-soft">{row.customerName ?? "—"}</td>
                          <td className="px-3 py-2 text-right font-semibold text-phx-ink-2">{units(row.qty)}</td>
                          <td className="px-3 py-2 text-right font-bold text-phx-ink">{money(row.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </PortalDesktopTable>
                )}
              />
            </section>

            {/* Reverse lookup */}
            {data.reverseLookup.length > 0 ? (
              <section className={`${adminPanelClassName} overflow-hidden rounded-[6px]`}>
                <div className="flex items-center gap-2 border-b border-phx-line px-4 py-3">
                  <ArrowLeftRight className="h-3.5 w-3.5 text-phx-accent" />
                  <h3 className="text-phx-md font-black uppercase tracking-[0.12em] text-phx-ink">Other requests targeting these pharmacies</h3>
                </div>
                <div className="divide-y divide-phx-paper-2">
                  {data.reverseLookup.map((row) => (
                    <div key={row.requestId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                      <div className="min-w-0">
                        <span className="font-mono text-phx-sm font-bold text-phx-ink">{row.requestCode}</span>
                        <span className="ml-2 text-phx-sm font-semibold text-phx-ink-soft">{row.requesterName ?? ""}</span>
                        <span className="ml-2 text-phx-xs font-medium text-phx-ink-faint">{STATUS_LABELS[row.status] ?? requestStatusLabel(row.status)} · {row.sharedPharmacyCodes.length} shared pharmacy{row.sharedPharmacyCodes.length === 1 ? "" : "s"}</span>
                      </div>
                      <a
                        href={`${viewSalesBasePath}/marketing-requests/${row.requestId}/view-sales`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-[5px] border border-phx-line bg-white px-2 py-1 text-phx-xs font-black text-phx-accent transition hover:border-phx-accent-line hover:bg-phx-accent-soft shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)]"
                      >
                        <ExternalLink className="h-3 w-3" /> View Sales
                      </a>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {!data.salesDataAsOf ? (
              <div className="flex items-center gap-2 rounded-[6px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-phx-sm font-semibold text-amber-800">
                <AlertTriangle className="h-4 w-4 shrink-0" /> No validated sales data is loaded yet, so attribution may be incomplete.
              </div>
            ) : null}
          </>
        ) : null}

        {/* Read-only ROI explainability for this request (loads independently of the sales table).
            Isolated in its own boundary so a fault here can never take down the sales table above. */}
        <WorkspaceErrorBoundary fallbackTitle="Explain ROI error">
          <MarketingRoiExplainPanel requestId={requestId} />
        </WorkspaceErrorBoundary>
      </div>
    </WorkspaceErrorBoundary>
  );
}
