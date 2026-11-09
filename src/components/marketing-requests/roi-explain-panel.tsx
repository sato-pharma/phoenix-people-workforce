"use client";

import * as React from "react";
import { CheckCircle2, HelpCircle, Info, Layers, ListTree, XCircle } from "lucide-react";

import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { LoadingSpinner } from "@/components/ui/loading-state";
import {
  ROI_EXPLAIN_REASON_LABEL,
  type MarketingRoiExplain,
  type RoiExplainReason,
} from "@/lib/marketing-requests/roi-explain";
import { cn } from "@/lib/utils";
import { adminPanelClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";

const moneyFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
function money(value: number) {
  return moneyFormatter.format(Math.round(Number.isFinite(value) ? value : 0));
}
function units(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number.isFinite(value) ? value : 0);
}
function percent(ratio: number) {
  return `${Math.round((Number.isFinite(ratio) ? ratio : 0) * 100)}%`;
}

const REASON_TONE: Record<RoiExplainReason, string> = {
  attributed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  missing_pharmacy_code: "border-rose-200 bg-rose-50 text-rose-800",
  pharmacy_no_product_sales: "border-slate-200 bg-slate-50 text-slate-700",
  product_bridge_issue: "border-rose-200 bg-rose-50 text-rose-800",
  no_validated_coverage: "border-amber-200 bg-amber-50 text-amber-800",
  partial_data_pending: "border-amber-200 bg-amber-50 text-amber-800",
};

function Chip({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[5px] border px-2 py-0.5 text-phx-xs font-bold",
        ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700",
      )}
    >
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {children}
    </span>
  );
}

function SummaryStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={`${adminSoftPanelClassName} rounded-[6px] px-3 py-2.5`}>
      <p className="text-phx-sm font-black uppercase tracking-[0.12em] text-phx-ink-faint">{label}</p>
      <p className="mt-1 text-[16px] font-black leading-none text-phx-ink">{value}</p>
      {hint ? <p className="mt-1 text-phx-xs font-semibold text-phx-ink-faint">{hint}</p> : null}
    </div>
  );
}

export function MarketingRoiExplainPanel({ requestId }: { requestId: string }) {
  const [data, setData] = React.useState<MarketingRoiExplain | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/marketing-requests/${requestId}/roi-explain`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        setData(null);
        setError(payload.message ?? "Unable to explain ROI for this request.");
        return;
      }
      setData(payload as MarketingRoiExplain);
    } catch {
      setData(null);
      setError("Unable to explain ROI for this request.");
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  return (
    <section className={`${adminPanelClassName} overflow-hidden rounded-[6px]`}>
      <div className="flex items-center gap-2 border-b border-phx-line px-4 py-3">
        <ListTree className="h-4 w-4 text-phx-accent" />
        <h3 className="text-phx-md font-black uppercase tracking-[0.12em] text-phx-ink">Explain ROI · Attribution Details</h3>
      </div>

      {loading && !data ? (
        <div className="flex items-center gap-2 px-4 py-6 text-phx-md font-semibold text-phx-ink-soft">
          <LoadingSpinner /> Explaining ROI for this request…
        </div>
      ) : error ? (
        <div className="m-4 rounded-[6px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-phx-md font-semibold text-amber-800">{error}</div>
      ) : data ? (
        <div className="space-y-4 p-4">
          {/* Diagnostic reason — the "why" up top */}
          <div className={cn("flex items-start gap-2 rounded-[6px] border px-3.5 py-3", REASON_TONE[data.diagnostic.reason])}>
            {data.diagnostic.reason === "attributed" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <Info className="mt-0.5 h-4 w-4 shrink-0" />}
            <div>
              <p className="text-phx-md font-black">{ROI_EXPLAIN_REASON_LABEL[data.diagnostic.reason]}</p>
              <p className="mt-0.5 text-phx-sm font-semibold">
                {data.diagnostic.pharmaciesFound}/{data.diagnostic.pharmaciesTargeted} pharmacies found in SoS ·{" "}
                {data.diagnostic.productsMatched}/{data.diagnostic.productsTargeted} products bridged ·{" "}
                {data.diagnostic.monthsCovered}/{data.diagnostic.monthsInWindow} ROI months validated
                {data.diagnostic.monthsPending > 0 ? ` · ${data.diagnostic.monthsPending} pending` : ""}
              </p>
            </div>
          </div>

          {/* 1) Request summary */}
          <div>
            <p className="mb-1.5 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Request summary</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <SummaryStat label="Request" value={data.summary.requestCode} hint={data.summary.customerName} />
              <SummaryStat label="Pay date" value={data.summary.payDate ?? "—"} hint={data.summary.roiWindowLabel ?? "no window"} />
              <SummaryStat label="Required ROI" value={money(data.summary.requiredRoiValue)} />
              <SummaryStat label="Forecast ROI" value={money(data.summary.expectedRoiValue)} />
              <SummaryStat label="Actual sales" value={money(data.summary.actualSalesValue)} />
              <SummaryStat label="Actual coverage" value={percent(data.summary.actualCoverageRatio)} hint={`SoS as of ${data.summary.salesDataAsOf ?? "n/a"}`} />
            </div>
          </div>

          {/* 2) Target setup */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="rounded-[6px] border border-phx-line bg-phx-paper p-3">
              <p className="mb-2 flex items-center gap-1.5 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">
                <Layers className="h-3.5 w-3.5" /> Target products ({data.diagnostic.productsMatched}/{data.diagnostic.productsTargeted} bridged)
              </p>
              <div className="flex flex-wrap gap-1.5">
                {data.targetSetup.products.length === 0 ? (
                  <span className="text-phx-sm font-medium text-phx-ink-faint">No products.</span>
                ) : (
                  data.targetSetup.products.map((product) => (
                    <Chip key={product.code} ok={product.matchedToSos}>
                      {product.name}
                      {product.matchedToSos && product.sosProductCode ? ` → ${product.sosProductCode}` : " (no SoS match)"}
                    </Chip>
                  ))
                )}
              </div>
            </div>
            <div className="rounded-[6px] border border-phx-line bg-phx-paper p-3">
              <p className="mb-2 flex items-center gap-1.5 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">
                <HelpCircle className="h-3.5 w-3.5" /> Target pharmacy codes ({data.diagnostic.pharmaciesFound}/{data.diagnostic.pharmaciesTargeted} in SoS)
              </p>
              <div className="flex flex-wrap gap-1.5">
                {data.targetSetup.pharmacies.length === 0 ? (
                  <span className="text-phx-sm font-medium text-phx-ink-faint">No pharmacy codes.</span>
                ) : (
                  data.targetSetup.pharmacies.map((pharmacy) => (
                    <Chip key={pharmacy.code} ok={pharmacy.foundInSos}>
                      <span className="font-mono">{pharmacy.code}</span>
                      {pharmacy.foundInSos ? "" : " (missing)"}
                    </Chip>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="rounded-[6px] border border-phx-line bg-phx-paper p-3 text-phx-sm">
              <p className="mb-1.5 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Distributor rollup / family used</p>
              {data.targetSetup.distributorFamilies.length === 0 ? (
                <span className="text-phx-sm font-medium text-phx-ink-faint">No mapped distributor (Office/Direct are not attributed).</span>
              ) : (
                <ul className="space-y-1">
                  {data.targetSetup.distributorFamilies.map((family) => (
                    <li key={`${family.marketingDistributor}-${family.parentDistributorCode}`} className="font-semibold text-phx-ink-2">
                      {family.marketingDistributor} <span className="text-phx-ink-faint">→ {family.parentDistributorCode} ({family.sosDistributorCodes.join(", ")})</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-[6px] border border-phx-line bg-phx-paper p-3 text-phx-sm">
              <p className="mb-1.5 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Validated SoS periods in window</p>
              <p className="font-semibold text-phx-ink-2">
                Validated: <span className="text-emerald-700">{data.targetSetup.validatedPeriodsInWindow.join(", ") || "none"}</span>
              </p>
              {data.targetSetup.pendingPeriodsInWindow.length > 0 ? (
                <p className="mt-1 font-semibold text-phx-ink-2">
                  Pending: <span className="text-amber-700">{data.targetSetup.pendingPeriodsInWindow.join(", ")}</span>
                </p>
              ) : null}
            </div>
          </div>

          {/* 3) Attributed sales ledger */}
          <div className="overflow-hidden rounded-[6px] border border-phx-line">
            <div className="flex items-center justify-between border-b border-phx-line bg-white px-3 py-2">
              <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink">Attributed sales ledger</p>
              <span className="inline-flex items-center rounded-[5px] border border-phx-line bg-phx-paper px-2 py-0.5 text-phx-xs font-bold text-phx-ink-soft">
                {data.ledger.length} row{data.ledger.length === 1 ? "" : "s"}
              </span>
            </div>
            <PortalResponsiveDataList
              items={data.ledger}
              empty={<p className="px-4 py-5 text-center text-phx-sm font-medium text-phx-ink-soft">No attributed sales rows.</p>}
              getKey={(row) => row.ledgerKey}
              renderCard={(row) => (
                <PortalRecordCard
                  accent="emerald"
                  title={row.productName}
                  meta={`${row.invoicePeriod} · ${row.distributorCode} · ${row.clientCode}`}
                  status={<span className="text-phx-xs font-bold uppercase text-emerald-700">{row.confidence}</span>}
                >
                  <PortalRecordFields
                    fields={[
                      { label: "SoS row", value: row.sosRowId ?? "—" },
                      { label: "Qty", value: units(row.qty) },
                      { label: "Value counted", value: money(row.valueCounted) },
                      { label: "Match", value: row.matchReason },
                    ]}
                  />
                </PortalRecordCard>
              )}
              renderTable={() => (
                <PortalDesktopTable
                  cols={
                    <colgroup>
                      <col className="w-[13%]" />
                      <col className="w-[16%]" />
                      <col className="w-[15%]" />
                      <col className="w-[24%]" />
                      <col className="w-[9%]" />
                      <col className="w-[12%]" />
                      <col className="w-[11%]" />
                    </colgroup>
                  }
                  className="text-phx-sm"
                >
                  <thead className="bg-phx-ink text-phx-sm font-black uppercase tracking-[0.1em] text-white">
                    <tr>
                      <th className="px-3 py-2">SoS row</th>
                      <th className="px-3 py-2">Period / distributor</th>
                      <th className="px-3 py-2">Client code</th>
                      <th className="px-3 py-2">Product</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2 text-right">Value counted</th>
                      <th className="px-3 py-2">Match / confidence</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white">
                    {data.ledger.map((row) => (
                      <tr key={row.ledgerKey} className="border-t border-[#FEE7D2]">
                        <td className="break-words px-3 py-1.5 font-mono text-phx-ink-faint">{row.sosRowId ?? "—"}</td>
                        <td className="break-words px-3 py-1.5">
                          <span className="block font-mono font-bold text-phx-ink">{row.invoicePeriod}</span>
                          <span className="block font-medium text-phx-ink-soft">{row.distributorCode}</span>
                        </td>
                        <td className="break-words px-3 py-1.5 font-mono text-phx-ink-soft">{row.clientCode}</td>
                        <td className="break-words px-3 py-1.5 font-semibold text-phx-ink-2">{row.productName}</td>
                        <td className="px-3 py-1.5 text-right font-semibold text-phx-ink-2">{units(row.qty)}</td>
                        <td className="px-3 py-1.5 text-right font-bold text-phx-ink">{money(row.valueCounted)}</td>
                        <td className="break-words px-3 py-1.5">
                          <span className="inline-flex items-center rounded-[4px] border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-phx-sm font-bold uppercase tracking-wide text-emerald-700" title={row.matchReason}>
                            {row.confidence}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </PortalDesktopTable>
              )}
            />
          </div>
          <p className="text-phx-sm font-medium text-phx-ink-faint">
            Ledger reflects the current exact attribution (distributor + pharmacy code + product + period) and reconciles to the actual sales above. Read-only — nothing here changes attribution.
          </p>
        </div>
      ) : null}
    </section>
  );
}
