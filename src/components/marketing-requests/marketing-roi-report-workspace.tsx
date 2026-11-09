"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, ClipboardList, ExternalLink, TrendingUp, Users } from "lucide-react";

import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
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
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { adminPanelClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";

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
    <span className={cn("inline-flex items-center rounded-[4px] border px-2 py-0.5 text-phx-sm font-bold uppercase tracking-wide", STATUS_TONE[status])}>
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
    return <div className="px-4 py-8 text-center text-phx-md font-medium text-phx-ink-soft">No marketing requests found for this selection.</div>;
  }

  const detailsButton = (row: RoiBusinessRow) => (
    <button
      type="button"
      onClick={() => onSelectRow(row)}
      className="inline-flex items-center gap-1 rounded-[5px] border border-phx-line bg-white px-2 py-1 text-phx-xs font-black text-phx-accent transition hover:border-phx-accent-line hover:bg-phx-accent-soft shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)]"
    >
      View details
    </button>
  );

  return (
    <PortalResponsiveDataList
      items={rows}
      empty={null}
      getKey={(row) => row.requestId}
      renderCard={(row) => (
        <PortalRecordCard
          accent={selectedRequestId === row.requestId ? "orange" : "slate"}
          title={<span className="font-mono">{row.requestCode}</span>}
          meta={`${secondaryColumnLabel}: ${secondaryColumnValue(row)}`}
          status={<StatusBadge status={row.simpleStatus} />}
          actions={detailsButton(row)}
        >
          <PortalRecordFields
            fields={[
              { label: "Pay date", value: row.payDate ?? "—" },
              { label: "Cost", value: money(row.estimatedCost) },
              { label: "Required ROI", value: money(row.requiredRoiValue) },
              { label: "Forecast ROI", value: money(row.expectedRoiValue) },
              { label: "Actual sales", value: money(row.actualSalesValue) },
              { label: "Actual coverage", value: row.hasSalesData ? percent(row.actualCoverageRatio) : "—" },
              { label: "Main problem", value: ROI_MAIN_PROBLEM_LABEL[row.mainProblem] },
              { label: "Next action", value: ROI_NEXT_ACTION_LABEL[row.nextAction] },
            ]}
          />
        </PortalRecordCard>
      )}
      renderTable={() => (
        <PortalDesktopTable
          cols={
            <colgroup>
              <col className="w-[15%]" />
              <col className="w-[8%]" />
              <col className="w-[8%]" />
              <col className="w-[9%]" />
              <col className="w-[9%]" />
              <col className="w-[9%]" />
              <col className="w-[8%]" />
              <col className="w-[10%]" />
              <col className="w-[16%]" />
              <col className="w-[8%]" />
            </colgroup>
          }
          className="text-phx-sm"
        >
          <thead className="bg-phx-ink text-phx-sm font-black uppercase tracking-[0.1em] text-white">
            <tr>
              <th className="px-3 py-2.5">Request / {secondaryColumnLabel}</th>
              <th className="px-3 py-2.5">Pay date</th>
              <th className="px-3 py-2.5 text-right">Cost</th>
              <th className="px-3 py-2.5 text-right">Required ROI</th>
              <th className="px-3 py-2.5 text-right">Forecast ROI</th>
              <th className="px-3 py-2.5 text-right">Actual sales</th>
              <th className="px-3 py-2.5 text-right">Actual coverage</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5">Main problem / next action</th>
              <th className="px-2 py-2.5 text-right">Details</th>
            </tr>
          </thead>
          <tbody className="bg-white">
            {rows.map((row) => (
              <tr key={row.requestId} className={cn("border-t border-[#FEE7D2]", selectedRequestId === row.requestId && "bg-phx-accent-soft")}>
                <td className="break-words px-3 py-2.5">
                  <span className="block font-mono font-bold text-phx-ink">{row.requestCode}</span>
                  <span className="block font-semibold text-phx-ink-2">{secondaryColumnValue(row)}</span>
                </td>
                <td className="break-words px-3 py-2.5 font-medium text-phx-ink-soft">{row.payDate ?? "—"}</td>
                <td className="px-3 py-2.5 text-right font-medium text-phx-ink-soft">{money(row.estimatedCost)}</td>
                <td className="px-3 py-2.5 text-right font-semibold text-phx-ink-2">{money(row.requiredRoiValue)}</td>
                <td className="px-3 py-2.5 text-right font-medium text-phx-ink-soft">{money(row.expectedRoiValue)}</td>
                <td className="px-3 py-2.5 text-right font-bold text-phx-ink">{money(row.actualSalesValue)}</td>
                <td className="px-3 py-2.5 text-right font-bold text-phx-ink">{row.hasSalesData ? percent(row.actualCoverageRatio) : "—"}</td>
                <td className="px-3 py-2.5"><StatusBadge status={row.simpleStatus} /></td>
                <td className="break-words px-3 py-2.5 text-phx-xs font-semibold text-phx-ink-soft">
                  <span className="block">{ROI_MAIN_PROBLEM_LABEL[row.mainProblem]}</span>
                  <span className="block">{ROI_NEXT_ACTION_LABEL[row.nextAction]}</span>
                </td>
                <td className="px-2 py-2.5 text-right">{detailsButton(row)}</td>
              </tr>
            ))}
          </tbody>
        </PortalDesktopTable>
      )}
    />
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
    <section className={`${adminPanelClassName} overflow-hidden rounded-[6px]`}>
      <div className="flex items-center justify-between border-b border-phx-line px-4 py-3">
        <div>
          <p className="text-phx-sm font-black uppercase tracking-[0.16em] text-phx-accent">Request details</p>
          <h3 className="text-phx-base font-black tracking-tight text-phx-ink">{row.requestCode} · {row.customerName}</h3>
        </div>
        <a
          href={`/admin/marketing-requests/${row.requestId}/view-sales`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-[5px] border border-phx-line bg-white px-2 py-1 text-phx-xs font-black text-phx-accent transition hover:border-phx-accent-line hover:bg-phx-accent-soft shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)]"
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
          <div className="flex items-center gap-2 px-1 py-4 text-phx-md font-semibold text-phx-ink-soft">
            <LoadingSpinner /> Loading attribution details…
          </div>
        ) : error ? (
          <div className="rounded-[6px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-phx-md font-semibold text-amber-800">{error}</div>
        ) : explain ? (
          <>
            {/* 2) Target setup */}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="rounded-[6px] border border-phx-line bg-phx-paper p-3">
                <p className="mb-2 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Target products</p>
                <div className="flex flex-wrap gap-1.5">
                  {explain.targetSetup.products.length === 0 ? (
                    <span className="text-phx-sm font-medium text-phx-ink-faint">No products.</span>
                  ) : (
                    explain.targetSetup.products.map((product) => (
                      <span key={product.code} className="inline-flex items-center rounded-[5px] border border-phx-line bg-white px-2 py-0.5 text-phx-xs font-bold text-phx-ink-2 shadow-[0_1px_1px_rgba(15,23,42,0.05)]">
                        {product.name}
                      </span>
                    ))
                  )}
                </div>
              </div>
              <div className="rounded-[6px] border border-phx-line bg-phx-paper p-3">
                <p className="mb-2 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Target pharmacies</p>
                <div className="flex flex-wrap gap-1.5">
                  {explain.targetSetup.pharmacies.length === 0 ? (
                    <span className="text-phx-sm font-medium text-phx-ink-faint">No pharmacy codes.</span>
                  ) : (
                    explain.targetSetup.pharmacies.map((pharmacy) => (
                      <span key={pharmacy.code} className="inline-flex items-center rounded-[5px] border border-phx-line bg-white px-2 py-0.5 text-phx-xs font-bold text-phx-ink-2 shadow-[0_1px_1px_rgba(15,23,42,0.05)]">
                        {pharmacy.name}
                      </span>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-[6px] border border-phx-line bg-phx-paper p-3 text-phx-sm">
              <p className="mb-1.5 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">ROI window</p>
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
              <summary className="flex cursor-pointer list-none items-center justify-between bg-white px-3 py-2 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink">
                <span className="inline-flex items-center gap-1.5"><ChevronRight className="h-3.5 w-3.5 [details[open]_&]:hidden" /><ChevronDown className="hidden h-3.5 w-3.5 [details[open]_&]:inline" /> Explain ROI ledger (advanced)</span>
                <span className="inline-flex items-center rounded-[5px] border border-phx-line bg-phx-paper px-2 py-0.5 text-phx-xs font-bold text-phx-ink-soft">{explain.ledger.length} row{explain.ledger.length === 1 ? "" : "s"}</span>
              </summary>
              <div className="border-t border-phx-line">
                <PortalResponsiveDataList
                  items={explain.ledger}
                  empty={<p className="px-4 py-4 text-center text-phx-sm font-medium text-phx-ink-soft">No attributed sales rows.</p>}
                  getKey={(ledgerRow) => ledgerRow.ledgerKey}
                  renderCard={(ledgerRow) => (
                    <PortalRecordCard
                      accent="emerald"
                      title={ledgerRow.productName}
                      meta={`${ledgerRow.invoicePeriod} · ${ledgerRow.clientCode}`}
                      status={<span className="text-phx-xs font-bold uppercase text-emerald-700">{ledgerRow.confidence}</span>}
                    >
                      <PortalRecordFields
                        fields={[
                          { label: "SoS row", value: ledgerRow.sosRowId ?? "—" },
                          { label: "Qty", value: units(ledgerRow.qty) },
                          { label: "Value", value: money(ledgerRow.valueCounted) },
                        ]}
                      />
                    </PortalRecordCard>
                  )}
                  renderTable={() => (
                    <PortalDesktopTable
                      cols={
                        <colgroup>
                          <col className="w-[14%]" />
                          <col className="w-[11%]" />
                          <col className="w-[15%]" />
                          <col className="w-[28%]" />
                          <col className="w-[10%]" />
                          <col className="w-[11%]" />
                          <col className="w-[11%]" />
                        </colgroup>
                      }
                      className="text-phx-sm"
                    >
                      <thead className="bg-phx-ink text-phx-sm font-black uppercase tracking-[0.1em] text-white">
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
                        {explain.ledger.map((ledgerRow) => (
                          <tr key={ledgerRow.ledgerKey} className="border-t border-[#FEE7D2]">
                            <td className="break-words px-3 py-1.5 font-mono text-phx-ink-faint">{ledgerRow.sosRowId ?? "—"}</td>
                            <td className="break-words px-3 py-1.5 font-mono font-bold text-phx-ink">{ledgerRow.invoicePeriod}</td>
                            <td className="break-words px-3 py-1.5 font-mono text-phx-ink-soft">{ledgerRow.clientCode}</td>
                            <td className="break-words px-3 py-1.5 font-semibold text-phx-ink-2">{ledgerRow.productName}</td>
                            <td className="px-3 py-1.5 text-right font-semibold text-phx-ink-2">{units(ledgerRow.qty)}</td>
                            <td className="px-3 py-1.5 text-right font-bold text-phx-ink">{money(ledgerRow.valueCounted)}</td>
                            <td className="break-words px-3 py-1.5 font-bold uppercase text-emerald-700">{ledgerRow.confidence}</td>
                          </tr>
                        ))}
                      </tbody>
                    </PortalDesktopTable>
                  )}
                />
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
    <div className={`${adminSoftPanelClassName} rounded-[6px] px-3 py-2.5`}>
      <p className="text-phx-sm font-black uppercase tracking-[0.12em] text-phx-ink-faint">{label}</p>
      <p className="mt-1 text-phx-base font-black leading-none text-phx-ink">{value}</p>
      {hint ? <p className="mt-1 truncate text-phx-xs font-semibold text-phx-ink-faint" title={hint}>{hint}</p> : null}
    </div>
  );
}

type Tab = "requester" | "customer" | "performance";

function CohortTable({ entityLabel, title, hint, rows, showForecast }: { entityLabel: string; title: string; hint: string; rows: RoiCohortRow[]; showForecast?: boolean }) {
  return (
    <section className={`${adminPanelClassName} overflow-hidden rounded-[6px]`}>
      <div className="border-b border-phx-line px-4 py-2.5">
        <h3 className="text-phx-md font-black text-phx-ink">{title}</h3>
        <p className="text-phx-xs font-medium text-phx-ink-soft">{hint}</p>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-phx-sm font-medium text-phx-ink-faint">No data.</div>
      ) : (
        <PortalResponsiveDataList
          items={rows}
          empty={null}
          getKey={(row) => row.key}
          renderCard={(row) => (
            <PortalRecordCard accent="slate" title={row.label}>
              <PortalRecordFields
                fields={[
                  { label: "Reqs", value: row.requestCount },
                  { label: "Cost", value: money(row.totalCost) },
                  { label: "Actual", value: money(row.totalActual) },
                  { label: "Coverage", value: percent(row.coverageRatio) },
                  { label: "Efficiency", value: `${row.efficiencyRatio.toFixed(2)}×` },
                  ...(showForecast
                    ? [{ label: "Forecast acc.", value: row.forecastAccuracyRatio === null ? "—" : percent(row.forecastAccuracyRatio) }]
                    : []),
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className={showForecast ? "w-[28%]" : "w-[32%]"} />
                  <col className="w-[10%]" />
                  <col className={showForecast ? "w-[14%]" : "w-[16%]"} />
                  <col className={showForecast ? "w-[14%]" : "w-[16%]"} />
                  <col className={showForecast ? "w-[12%]" : "w-[13%]"} />
                  <col className={showForecast ? "w-[12%]" : "w-[13%]"} />
                  {showForecast ? <col className="w-[10%]" /> : null}
                </colgroup>
              }
              className="text-phx-sm"
            >
              <thead className="bg-phx-paper text-phx-sm font-bold uppercase tracking-[0.08em] text-phx-ink-soft">
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
                    <td className="break-words px-3 py-2 font-bold text-phx-ink">{row.label}</td>
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
            </PortalDesktopTable>
          )}
        />
      )}
    </section>
  );
}

function PerformanceCohorts({ cohorts, loading, error }: { cohorts: RoiCohorts | null; loading: boolean; error: string | null }) {
  if (loading) {
    return (
      <div className={`${adminSoftPanelClassName} flex items-center gap-2 rounded-[6px] px-4 py-8 text-phx-md font-medium text-phx-ink-soft`}>
        <LoadingSpinner /> Building performance cohorts…
      </div>
    );
  }
  if (error) {
    return <div className="rounded-[6px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-phx-md font-semibold text-amber-800">{error}</div>;
  }
  if (!cohorts) return null;
  return (
    <div className="space-y-4">
      <p className="rounded-[6px] border border-phx-line bg-phx-paper px-3.5 py-2 text-phx-xs font-medium text-phx-ink-soft">
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
        <div className={`${adminSoftPanelClassName} inline-flex rounded-[6px] p-1`}>
          <button
            type="button"
            onClick={() => switchTab("requester")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-phx-sm font-black transition",
              tab === "requester" ? "bg-phx-ink text-white" : "text-phx-ink-soft hover:bg-phx-paper",
            )}
          >
            <Users className="h-3.5 w-3.5" /> By Requester
          </button>
          <button
            type="button"
            onClick={() => switchTab("customer")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-phx-sm font-black transition",
              tab === "customer" ? "bg-phx-ink text-white" : "text-phx-ink-soft hover:bg-phx-paper",
            )}
          >
            <ClipboardList className="h-3.5 w-3.5" /> By Customer
          </button>
          <button
            type="button"
            onClick={() => switchTab("performance")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-phx-sm font-black transition",
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
        <div className={`${adminPanelClassName} rounded-[6px] p-3`}>
          {tab === "requester" ? (
            <label className="block text-phx-sm font-bold text-phx-ink-2">
              Requester
              <select
                value={selectedRequesterHrId}
                onChange={(event) => {
                  setSelectedRequesterHrId(event.target.value);
                  void loadRows("requester", event.target.value);
                }}
                disabled={optionsLoading}
                className={`${phxSelectClassName} mt-1 block max-w-md`}
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
            <label className="block text-phx-sm font-bold text-phx-ink-2">
              Customer
              <select
                value={selectedCustomerName}
                onChange={(event) => {
                  setSelectedCustomerName(event.target.value);
                  void loadRows("customer", event.target.value);
                }}
                disabled={optionsLoading}
                className={`${phxSelectClassName} mt-1 block max-w-md`}
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
        <section className={`${adminPanelClassName} overflow-hidden rounded-[6px]`}>
          {rowsLoading ? (
            <div className="flex items-center gap-2 px-4 py-8 text-phx-md font-medium text-phx-ink-soft">
              <LoadingSpinner /> Loading marketing requests…
            </div>
          ) : rowsError ? (
            <div className="m-4 rounded-[6px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-phx-md font-semibold text-amber-800">{rowsError}</div>
          ) : (!selectedRequesterHrId && tab === "requester") || (!selectedCustomerName && tab === "customer") ? (
            <div className="px-4 py-8 text-center text-phx-md font-medium text-phx-ink-soft">
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
