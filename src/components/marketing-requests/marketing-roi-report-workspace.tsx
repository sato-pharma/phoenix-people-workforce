"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, ClipboardList, ExternalLink, TrendingUp, Users } from "lucide-react";

import { LoadingSpinner } from "@/components/ui/loading-state";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import {
  ROI_MAIN_PROBLEM_LABEL,
  ROI_NEXT_ACTION_LABEL,
  SIMPLE_ROI_STATUS_LABEL,
  type RoiBusinessRow,
  type RoiCohortRow,
  type RoiCohorts,
  type SimpleRoiStatus,
} from "@/lib/marketing-requests/roi-business-report";
import type { MarketingRoiExplain } from "@/lib/marketing-requests/roi-explain";
import { cn } from "@/lib/utils";

const moneyFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
function money(value: number) {
  return moneyFormatter.format(Math.round(Number.isFinite(value) ? value : 0));
}
function units(value: number) {
  return moneyFormatter.format(Number.isFinite(value) ? value : 0);
}
function percent(ratio: number) {
  return `${Math.round((Number.isFinite(ratio) ? ratio : 0) * 100)}%`;
}

type Options = { requesters: Array<{ hrId: string; name: string; requestCount: number }>; customers: Array<{ name: string; requestCount: number }> };

const STATUS_TONE: Record<SimpleRoiStatus, string> = {
  good: "border-emerald-200 bg-emerald-50 text-emerald-700",
  behind: "border-amber-200 bg-amber-50 text-amber-700",
  data_pending: "border-sky-200 bg-sky-50 text-sky-700",
  no_sales: "border-slate-200 bg-slate-50 text-slate-500",
  needs_review: "border-rose-200 bg-rose-50 text-rose-700",
};

function StatusBadge({ status }: { status: SimpleRoiStatus }) {
  return (
    <span className={cn("inline-flex items-center rounded-[4px] border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide", STATUS_TONE[status])}>
      {SIMPLE_ROI_STATUS_LABEL[status]}
    </span>
  );
}

async function fetchJson<T>(url: string): Promise<{ data: T | null; error: string | null }> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) return { data: null, error: payload?.message ?? "Request failed." };
    return { data: payload as T, error: null };
  } catch {
    return { data: null, error: "Request failed." };
  }
}

function RoiReportTable({
  rows,
  secondaryColumnLabel,
  secondaryColumnValue,
  onSelectRow,
  selectedRequestId,
}: {
  rows: RoiBusinessRow[];
  secondaryColumnLabel: string;
  secondaryColumnValue: (row: RoiBusinessRow) => string;
  onSelectRow: (row: RoiBusinessRow) => void;
  selectedRequestId: string | null;
}) {
  if (rows.length === 0) {
    return <div className="px-4 py-8 text-center text-[13px] font-medium text-phx-ink-soft">No marketing requests found for this selection.</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1100px] border-collapse text-left text-[12px]">
        <thead className="bg-phx-ink text-[10px] font-black uppercase tracking-[0.1em] text-white">
          <tr>
            <th className="px-3 py-2.5">Request</th>
            <th className="px-3 py-2.5">{secondaryColumnLabel}</th>
            <th className="px-3 py-2.5">Pay date</th>
            <th className="px-3 py-2.5 text-right">Cost</th>
            <th className="px-3 py-2.5 text-right">Required ROI</th>
            <th className="px-3 py-2.5 text-right">Forecast ROI</th>
            <th className="px-3 py-2.5 text-right">Actual sales</th>
            <th className="px-3 py-2.5 text-right">Actual coverage</th>
            <th className="px-3 py-2.5">Status</th>
            <th className="px-3 py-2.5">Main problem</th>
            <th className="px-3 py-2.5">Next action</th>
            <th className="px-2 py-2.5 text-right">Details</th>
          </tr>
        </thead>
        <tbody className="bg-white">
          {rows.map((row) => (
            <tr key={row.requestId} className={cn("border-t border-[#FEE7D2]", selectedRequestId === row.requestId && "bg-phx-accent-soft")}>
              <td className="px-3 py-2.5 font-mono font-bold text-phx-ink">{row.requestCode}</td>
              <td className="px-3 py-2.5 font-semibold text-phx-ink-2">{secondaryColumnValue(row)}</td>
              <td className="px-3 py-2.5 font-medium text-phx-ink-soft">{row.payDate ?? "—"}</td>
              <td className="px-3 py-2.5 text-right font-medium text-phx-ink-soft">{money(row.estimatedCost)}</td>
              <td className="px-3 py-2.5 text-right font-semibold text-phx-ink-2">{money(row.requiredRoiValue)}</td>
              <td className="px-3 py-2.5 text-right font-medium text-phx-ink-soft">{money(row.expectedRoiValue)}</td>
              <td className="px-3 py-2.5 text-right font-bold text-phx-ink">{money(row.actualSalesValue)}</td>
              <td className="px-3 py-2.5 text-right font-bold text-phx-ink">{row.hasSalesData ? percent(row.actualCoverageRatio) : "—"}</td>
              <td className="px-3 py-2.5"><StatusBadge status={row.simpleStatus} /></td>
              <td className="px-3 py-2.5 text-[11px] font-semibold text-phx-ink-soft">{ROI_MAIN_PROBLEM_LABEL[row.mainProblem]}</td>
              <td className="px-3 py-2.5 text-[11px] font-semibold text-phx-ink-soft">{ROI_NEXT_ACTION_LABEL[row.nextAction]}</td>
              <td className="px-2 py-2.5 text-right">
                <button
                  type="button"
                  onClick={() => onSelectRow(row)}
                  className="inline-flex items-center gap-1 rounded-[5px] border border-phx-line bg-white px-2 py-1 text-[11px] font-black text-phx-accent transition hover:border-phx-accent-line hover:bg-phx-accent-soft"
                >
                  View details
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RequestDetailPanel({ row }: { row: RoiBusinessRow }) {
  const [explain, setExplain] = React.useState<MarketingRoiExplain | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setLoading(true);
      setError(null);
      setExplain(null);
      const { data, error: fetchError } = await fetchJson<MarketingRoiExplain>(`/api/marketing-requests/${row.requestId}/roi-explain`);
      if (cancelled) return;
      if (fetchError) setError(fetchError);
      else setExplain(data);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [row.requestId]);

  return (
    <section className="overflow-hidden rounded-[6px] border border-phx-line bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-phx-line px-4 py-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-phx-accent">Request details</p>
          <h3 className="text-[14px] font-black tracking-tight text-phx-ink">{row.requestCode} · {row.customerName}</h3>
        </div>
        <a
          href={`/admin/marketing-requests/${row.requestId}/view-sales`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-[5px] border border-phx-line bg-white px-2 py-1 text-[11px] font-black text-phx-accent transition hover:border-phx-accent-line hover:bg-phx-accent-soft"
        >
          <ExternalLink className="h-3 w-3" /> View Sales
        </a>
      </div>

      <div className="space-y-4 p-4">
        {/* 1) Request summary — business wording, forecast vs actual side by side. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          <SummaryStat label="Pay date" value={row.payDate ?? "—"} hint={row.roiWindow ?? "no window"} />
          <SummaryStat label="Required ROI" value={money(row.requiredRoiValue)} />
          <SummaryStat label="Forecast ROI" value={money(row.expectedRoiValue)} />
          <SummaryStat label="Actual sales" value={money(row.actualSalesValue)} />
          <SummaryStat label="Actual coverage" value={row.hasSalesData ? percent(row.actualCoverageRatio) : "—"} />
          <SummaryStat label="Status" value={SIMPLE_ROI_STATUS_LABEL[row.simpleStatus]} />
          <SummaryStat label="Next action" value={ROI_NEXT_ACTION_LABEL[row.nextAction]} hint={ROI_MAIN_PROBLEM_LABEL[row.mainProblem]} />
        </div>

        {loading ? (
          <div className="flex items-center gap-2 px-1 py-4 text-[13px] font-semibold text-phx-ink-soft">
            <LoadingSpinner /> Loading attribution details…
          </div>
        ) : error ? (
          <div className="rounded-[6px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] font-semibold text-amber-800">{error}</div>
        ) : explain ? (
          <>
            {/* 2) Target setup */}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="rounded-[6px] border border-phx-line bg-phx-paper p-3">
                <p className="mb-2 text-[11px] font-black uppercase tracking-[0.12em] text-phx-ink-faint">Target products</p>
                <div className="flex flex-wrap gap-1.5">
                  {explain.targetSetup.products.length === 0 ? (
                    <span className="text-[12px] font-medium text-phx-ink-faint">No products.</span>
                  ) : (
                    explain.targetSetup.products.map((product) => (
                      <span key={product.code} className="inline-flex items-center rounded-[5px] border border-phx-line bg-white px-2 py-0.5 text-[11px] font-bold text-phx-ink-2">
                        {product.name}
                      </span>
                    ))
                  )}
                </div>
              </div>
              <div className="rounded-[6px] border border-phx-line bg-phx-paper p-3">
                <p className="mb-2 text-[11px] font-black uppercase tracking-[0.12em] text-phx-ink-faint">Target pharmacies</p>
                <div className="flex flex-wrap gap-1.5">
                  {explain.targetSetup.pharmacies.length === 0 ? (
                    <span className="text-[12px] font-medium text-phx-ink-faint">No pharmacy codes.</span>
                  ) : (
                    explain.targetSetup.pharmacies.map((pharmacy) => (
                      <span key={pharmacy.code} className="inline-flex items-center rounded-[5px] border border-phx-line bg-white px-2 py-0.5 text-[11px] font-bold text-phx-ink-2">
                        {pharmacy.name}
                      </span>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-[6px] border border-phx-line bg-phx-paper p-3 text-[12px]">
              <p className="mb-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-phx-ink-faint">ROI window</p>
              <p className="font-semibold text-phx-ink-2">
                Validated: <span className="text-emerald-700">{explain.targetSetup.validatedPeriodsInWindow.join(", ") || "none"}</span>
                {explain.targetSetup.pendingPeriodsInWindow.length > 0 ? (
                  <>
                    {" · "}Pending: <span className="text-amber-700">{explain.targetSetup.pendingPeriodsInWindow.join(", ")}</span>
                  </>
                ) : null}
              </p>
            </div>

            {/* 3) Attributed sales ledger — collapsed by default; sos_row_id lives only here. */}
            <details className="overflow-hidden rounded-[6px] border border-phx-line">
              <summary className="flex cursor-pointer list-none items-center justify-between bg-white px-3 py-2 text-[11px] font-black uppercase tracking-[0.12em] text-phx-ink">
                <span className="inline-flex items-center gap-1.5"><ChevronRight className="h-3.5 w-3.5 [details[open]_&]:hidden" /><ChevronDown className="hidden h-3.5 w-3.5 [details[open]_&]:inline" /> Explain ROI ledger (advanced)</span>
                <span className="inline-flex items-center rounded-[5px] border border-phx-line bg-phx-paper px-2 py-0.5 text-[11px] font-bold text-phx-ink-soft">{explain.ledger.length} row{explain.ledger.length === 1 ? "" : "s"}</span>
              </summary>
              <div className="overflow-x-auto border-t border-phx-line">
                <table className="w-full min-w-[820px] border-collapse text-left text-[12px]">
                  <thead className="bg-phx-ink text-[10px] font-black uppercase tracking-[0.1em] text-white">
                    <tr>
                      <th className="px-3 py-2">SoS row</th>
                      <th className="px-3 py-2">Period</th>
                      <th className="px-3 py-2">Client code</th>
                      <th className="px-3 py-2">Product</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2 text-right">Value</th>
                      <th className="px-3 py-2">Confidence</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white">
                    {explain.ledger.length === 0 ? (
                      <tr><td className="px-4 py-4 text-center text-[12px] font-medium text-phx-ink-soft" colSpan={7}>No attributed sales rows.</td></tr>
                    ) : (
                      explain.ledger.map((ledgerRow) => (
                        <tr key={ledgerRow.ledgerKey} className="border-t border-[#FEE7D2]">
                          <td className="px-3 py-1.5 font-mono text-phx-ink-faint">{ledgerRow.sosRowId ?? "—"}</td>
                          <td className="px-3 py-1.5 font-mono font-bold text-phx-ink">{ledgerRow.invoicePeriod}</td>
                          <td className="px-3 py-1.5 font-mono text-phx-ink-soft">{ledgerRow.clientCode}</td>
                          <td className="px-3 py-1.5 font-semibold text-phx-ink-2">{ledgerRow.productName}</td>
                          <td className="px-3 py-1.5 text-right font-semibold text-phx-ink-2">{units(ledgerRow.qty)}</td>
                          <td className="px-3 py-1.5 text-right font-bold text-phx-ink">{money(ledgerRow.valueCounted)}</td>
                          <td className="px-3 py-1.5 font-bold uppercase text-emerald-700">{ledgerRow.confidence}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        ) : null}
      </div>
    </section>
  );
}

function SummaryStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-[6px] border border-phx-line bg-white px-3 py-2.5">
      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-phx-ink-faint">{label}</p>
      <p className="mt-1 text-[14px] font-black leading-none text-phx-ink">{value}</p>
      {hint ? <p className="mt-1 truncate text-[11px] font-semibold text-phx-ink-faint" title={hint}>{hint}</p> : null}
    </div>
  );
}

type Tab = "requester" | "customer" | "performance";

function CohortTable({ entityLabel, title, hint, rows, showForecast }: { entityLabel: string; title: string; hint: string; rows: RoiCohortRow[]; showForecast?: boolean }) {
  return (
    <section className="overflow-hidden rounded-[6px] border border-phx-line bg-white shadow-sm">
      <div className="border-b border-phx-line px-4 py-2.5">
        <h3 className="text-[13px] font-black text-phx-ink">{title}</h3>
        <p className="text-[11px] font-medium text-phx-ink-soft">{hint}</p>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] font-medium text-phx-ink-faint">No data.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead className="bg-phx-paper text-[10px] font-bold uppercase tracking-[0.08em] text-phx-ink-soft">
              <tr>
                <th className="px-3 py-2">{entityLabel}</th>
                <th className="px-3 py-2 text-right">Reqs</th>
                <th className="px-3 py-2 text-right">Cost</th>
                <th className="px-3 py-2 text-right">Actual</th>
                <th className="px-3 py-2 text-right">Coverage</th>
                <th className="px-3 py-2 text-right">Efficiency</th>
                {showForecast ? <th className="px-3 py-2 text-right">Forecast acc.</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-phx-paper-2">
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className="px-3 py-2 font-bold text-phx-ink">{row.label}</td>
                  <td className="px-3 py-2 text-right text-phx-ink-2">{row.requestCount}</td>
                  <td className="px-3 py-2 text-right text-phx-ink-2">{money(row.totalCost)}</td>
                  <td className="px-3 py-2 text-right font-bold text-phx-ink">{money(row.totalActual)}</td>
                  <td className="px-3 py-2 text-right text-phx-ink-2">{percent(row.coverageRatio)}</td>
                  <td className="px-3 py-2 text-right font-bold text-phx-ink">{row.efficiencyRatio.toFixed(2)}×</td>
                  {showForecast ? (
                    <td className="px-3 py-2 text-right text-phx-ink-2">
                      {row.forecastAccuracyRatio === null ? "—" : percent(row.forecastAccuracyRatio)}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PerformanceCohorts({ cohorts, loading, error }: { cohorts: RoiCohorts | null; loading: boolean; error: string | null }) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-[6px] border border-phx-line bg-white px-4 py-8 text-[13px] font-medium text-phx-ink-soft shadow-sm">
        <LoadingSpinner /> Building performance cohorts…
      </div>
    );
  }
  if (error) {
    return <div className="rounded-[6px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] font-semibold text-amber-800">{error}</div>;
  }
  if (!cohorts) return null;
  return (
    <div className="space-y-4">
      <p className="rounded-[6px] border border-phx-line bg-phx-paper px-3.5 py-2 text-[11px] font-medium text-phx-ink-soft">
        ROI-weighted across every visible request. <b>Efficiency</b> = EGP returned per EGP spent · <b>Coverage</b> = actual ÷ required · <b>Forecast acc.</b> = actual ÷ forecast. Approver-role totals can exceed the whole — a request with several approvers counts under each.
      </p>
      <CohortTable entityLabel="Request type" title="By request type" hint="Which activity types actually return." rows={cohorts.byRequestType} showForecast />
      <CohortTable entityLabel="Requester" title="By requester" hint="Realized return and forecast accuracy per requester." rows={cohorts.byRequester} showForecast />
      <CohortTable entityLabel="Approver role" title="By approver role" hint="Do MM-approved campaigns beat DM-approved?" rows={cohorts.byApproverRole} showForecast />
      <CohortTable entityLabel="Line" title="Efficiency league — by line" hint="Ranked by EGP returned per EGP spent." rows={cohorts.byLine} />
      <CohortTable entityLabel="Region" title="Efficiency league — by region" hint="Ranked by EGP returned per EGP spent." rows={cohorts.byRegion} />
    </div>
  );
}

export function MarketingRoiReportWorkspace() {
  const [tab, setTab] = React.useState<Tab>("requester");
  const [options, setOptions] = React.useState<Options>({ customers: [], requesters: [] });
  const [optionsLoading, setOptionsLoading] = React.useState(true);
  const [selectedRequesterHrId, setSelectedRequesterHrId] = React.useState("");
  const [selectedCustomerName, setSelectedCustomerName] = React.useState("");
  const [rows, setRows] = React.useState<RoiBusinessRow[]>([]);
  const [rowsLoading, setRowsLoading] = React.useState(false);
  const [rowsError, setRowsError] = React.useState<string | null>(null);
  const [selectedRow, setSelectedRow] = React.useState<RoiBusinessRow | null>(null);
  const [cohorts, setCohorts] = React.useState<RoiCohorts | null>(null);
  const [cohortsLoading, setCohortsLoading] = React.useState(false);
  const [cohortsError, setCohortsError] = React.useState<string | null>(null);

  React.useEffect(() => {
    void (async () => {
      const { data } = await fetchJson<Options>("/api/marketing-requests/roi-business-report");
      if (data) setOptions(data);
      setOptionsLoading(false);
    })();
  }, []);

  const loadRows = React.useCallback(async (nextTab: Tab, value: string) => {
    if (!value) {
      setRows([]);
      return;
    }
    setRowsLoading(true);
    setRowsError(null);
    setSelectedRow(null);
    const query = nextTab === "requester"
      ? `groupBy=requester&value=${encodeURIComponent(value)}`
      : `groupBy=customer&value=${encodeURIComponent(value)}`;
    const { data, error } = await fetchJson<{ rows: RoiBusinessRow[] }>(`/api/marketing-requests/roi-business-report?${query}`);
    if (error) setRowsError(error);
    setRows(data?.rows ?? []);
    setRowsLoading(false);
  }, []);

  const loadCohorts = React.useCallback(async () => {
    setCohortsLoading(true);
    setCohortsError(null);
    const { data, error } = await fetchJson<RoiCohorts>("/api/marketing-requests/roi-business-report?groupBy=cohorts");
    if (error) setCohortsError(error);
    setCohorts(data);
    setCohortsLoading(false);
  }, []);

  function switchTab(nextTab: Tab) {
    setTab(nextTab);
    setRows([]);
    setSelectedRow(null);
    setRowsError(null);
    if (nextTab === "performance") {
      if (!cohorts && !cohortsLoading) void loadCohorts();
      return;
    }
    void loadRows(nextTab, nextTab === "requester" ? selectedRequesterHrId : selectedCustomerName);
  }

  return (
    <WorkspaceErrorBoundary fallbackTitle="Marketing ROI Report error">
      <div className="space-y-4">
        {/* Tabs */}
        <div className="inline-flex rounded-[6px] border border-phx-line bg-white p-1 shadow-sm">
          <button
            type="button"
            onClick={() => switchTab("requester")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-[12px] font-black transition",
              tab === "requester" ? "bg-phx-ink text-white" : "text-phx-ink-soft hover:bg-phx-paper",
            )}
          >
            <Users className="h-3.5 w-3.5" /> By Requester
          </button>
          <button
            type="button"
            onClick={() => switchTab("customer")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-[12px] font-black transition",
              tab === "customer" ? "bg-phx-ink text-white" : "text-phx-ink-soft hover:bg-phx-paper",
            )}
          >
            <ClipboardList className="h-3.5 w-3.5" /> By Customer
          </button>
          <button
            type="button"
            onClick={() => switchTab("performance")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-[12px] font-black transition",
              tab === "performance" ? "bg-phx-ink text-white" : "text-phx-ink-soft hover:bg-phx-paper",
            )}
          >
            <TrendingUp className="h-3.5 w-3.5" /> Performance
          </button>
        </div>

        {tab === "performance" ? (
          <PerformanceCohorts cohorts={cohorts} loading={cohortsLoading} error={cohortsError} />
        ) : (
          <>
        {/* Selector */}
        <div className="rounded-[6px] border border-phx-line bg-white p-3 shadow-sm">
          {tab === "requester" ? (
            <label className="block text-[12px] font-bold text-phx-ink-2">
              Requester
              <select
                value={selectedRequesterHrId}
                onChange={(event) => {
                  setSelectedRequesterHrId(event.target.value);
                  void loadRows("requester", event.target.value);
                }}
                disabled={optionsLoading}
                className="mt-1 block w-full max-w-md rounded-[5px] border border-phx-line bg-white px-2.5 py-2 text-[13px] font-semibold text-phx-ink"
              >
                <option value="">{optionsLoading ? "Loading requesters…" : "Select a requester…"}</option>
                {options.requesters.map((requester) => (
                  <option key={requester.hrId} value={requester.hrId}>
                    {requester.name} ({requester.requestCount})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="block text-[12px] font-bold text-phx-ink-2">
              Customer
              <select
                value={selectedCustomerName}
                onChange={(event) => {
                  setSelectedCustomerName(event.target.value);
                  void loadRows("customer", event.target.value);
                }}
                disabled={optionsLoading}
                className="mt-1 block w-full max-w-md rounded-[5px] border border-phx-line bg-white px-2.5 py-2 text-[13px] font-semibold text-phx-ink"
              >
                <option value="">{optionsLoading ? "Loading customers…" : "Select a customer…"}</option>
                {options.customers.map((customer) => (
                  <option key={customer.name} value={customer.name}>
                    {customer.name} ({customer.requestCount})
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {/* Results table */}
        <section className="overflow-hidden rounded-[6px] border border-phx-line bg-white shadow-sm">
          {rowsLoading ? (
            <div className="flex items-center gap-2 px-4 py-8 text-[13px] font-medium text-phx-ink-soft">
              <LoadingSpinner /> Loading marketing requests…
            </div>
          ) : rowsError ? (
            <div className="m-4 rounded-[6px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] font-semibold text-amber-800">{rowsError}</div>
          ) : (!selectedRequesterHrId && tab === "requester") || (!selectedCustomerName && tab === "customer") ? (
            <div className="px-4 py-8 text-center text-[13px] font-medium text-phx-ink-soft">
              {tab === "requester" ? "Select a requester to see their marketing requests." : "Select a customer to see their marketing request history."}
            </div>
          ) : (
            <RoiReportTable
              rows={rows}
              secondaryColumnLabel={tab === "requester" ? "Customer" : "Requester"}
              secondaryColumnValue={(row) => (tab === "requester" ? row.customerName : row.requesterName ?? row.requesterHrId)}
              onSelectRow={setSelectedRow}
              selectedRequestId={selectedRow?.requestId ?? null}
            />
          )}
        </section>

        {selectedRow ? <RequestDetailPanel row={selectedRow} /> : null}
          </>
        )}
      </div>
    </WorkspaceErrorBoundary>
  );
}
