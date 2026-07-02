"use client";

import * as React from "react";
import { CheckCircle2, HelpCircle, Info, Layers, ListTree, XCircle } from "lucide-react";

import { LoadingSpinner } from "@/components/ui/loading-state";
import {
  ROI_EXPLAIN_REASON_LABEL,
  type MarketingRoiExplain,
  type RoiExplainReason,
} from "@/lib/marketing-requests/roi-explain";
import { cn } from "@/lib/utils";

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
        "inline-flex items-center gap-1 rounded-[5px] border px-2 py-0.5 text-[11px] font-bold",
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
    <div className="rounded-[6px] border border-[#E2E8F0] bg-white px-3 py-2.5">
      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">{label}</p>
      <p className="mt-1 text-[16px] font-black leading-none text-[#0F172A]">{value}</p>
      {hint ? <p className="mt-1 text-[11px] font-semibold text-[#94A3B8]">{hint}</p> : null}
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
    <section className="overflow-hidden rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-[#E2E8F0] px-4 py-3">
        <ListTree className="h-4 w-4 text-[#F97316]" />
        <h3 className="text-[13px] font-black uppercase tracking-[0.12em] text-[#0F172A]">Explain ROI · Attribution Details</h3>
      </div>

      {loading && !data ? (
        <div className="flex items-center gap-2 px-4 py-6 text-[13px] font-semibold text-[#64748B]">
          <LoadingSpinner /> Explaining ROI for this request…
        </div>
      ) : error ? (
        <div className="m-4 rounded-[6px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] font-semibold text-amber-800">{error}</div>
      ) : data ? (
        <div className="space-y-4 p-4">
          {/* Diagnostic reason — the "why" up top */}
          <div className={cn("flex items-start gap-2 rounded-[6px] border px-3.5 py-3", REASON_TONE[data.diagnostic.reason])}>
            {data.diagnostic.reason === "attributed" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <Info className="mt-0.5 h-4 w-4 shrink-0" />}
            <div>
              <p className="text-[13px] font-black">{ROI_EXPLAIN_REASON_LABEL[data.diagnostic.reason]}</p>
              <p className="mt-0.5 text-[12px] font-semibold">
                {data.diagnostic.pharmaciesFound}/{data.diagnostic.pharmaciesTargeted} pharmacies found in SoS ·{" "}
                {data.diagnostic.productsMatched}/{data.diagnostic.productsTargeted} products bridged ·{" "}
                {data.diagnostic.monthsCovered}/{data.diagnostic.monthsInWindow} ROI months validated
                {data.diagnostic.monthsPending > 0 ? ` · ${data.diagnostic.monthsPending} pending` : ""}
              </p>
            </div>
          </div>

          {/* 1) Request summary */}
          <div>
            <p className="mb-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Request summary</p>
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
            <div className="rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] p-3">
              <p className="mb-2 flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">
                <Layers className="h-3.5 w-3.5" /> Target products ({data.diagnostic.productsMatched}/{data.diagnostic.productsTargeted} bridged)
              </p>
              <div className="flex flex-wrap gap-1.5">
                {data.targetSetup.products.length === 0 ? (
                  <span className="text-[12px] font-medium text-[#94A3B8]">No products.</span>
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
            <div className="rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] p-3">
              <p className="mb-2 flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">
                <HelpCircle className="h-3.5 w-3.5" /> Target pharmacy codes ({data.diagnostic.pharmaciesFound}/{data.diagnostic.pharmaciesTargeted} in SoS)
              </p>
              <div className="flex flex-wrap gap-1.5">
                {data.targetSetup.pharmacies.length === 0 ? (
                  <span className="text-[12px] font-medium text-[#94A3B8]">No pharmacy codes.</span>
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
            <div className="rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] p-3 text-[12px]">
              <p className="mb-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Distributor rollup / family used</p>
              {data.targetSetup.distributorFamilies.length === 0 ? (
                <span className="text-[12px] font-medium text-[#94A3B8]">No mapped distributor (Office/Direct are not attributed).</span>
              ) : (
                <ul className="space-y-1">
                  {data.targetSetup.distributorFamilies.map((family) => (
                    <li key={`${family.marketingDistributor}-${family.parentDistributorCode}`} className="font-semibold text-[#334155]">
                      {family.marketingDistributor} <span className="text-[#94A3B8]">→ {family.parentDistributorCode} ({family.sosDistributorCodes.join(", ")})</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] p-3 text-[12px]">
              <p className="mb-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Validated SoS periods in window</p>
              <p className="font-semibold text-[#334155]">
                Validated: <span className="text-emerald-700">{data.targetSetup.validatedPeriodsInWindow.join(", ") || "none"}</span>
              </p>
              {data.targetSetup.pendingPeriodsInWindow.length > 0 ? (
                <p className="mt-1 font-semibold text-[#334155]">
                  Pending: <span className="text-amber-700">{data.targetSetup.pendingPeriodsInWindow.join(", ")}</span>
                </p>
              ) : null}
            </div>
          </div>

          {/* 3) Attributed sales ledger */}
          <div className="overflow-hidden rounded-[6px] border border-[#E2E8F0]">
            <div className="flex items-center justify-between border-b border-[#E2E8F0] bg-white px-3 py-2">
              <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[#0F172A]">Attributed sales ledger</p>
              <span className="inline-flex items-center rounded-[5px] border border-[#E2E8F0] bg-[#F8FAFC] px-2 py-0.5 text-[11px] font-bold text-[#64748B]">
                {data.ledger.length} row{data.ledger.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[920px] border-collapse text-left text-[12px]">
                <thead className="bg-[#0F172A] text-[10px] font-black uppercase tracking-[0.1em] text-white">
                  <tr>
                    <th className="px-3 py-2">SoS row</th>
                    <th className="px-3 py-2">Period</th>
                    <th className="px-3 py-2">Distributor</th>
                    <th className="px-3 py-2">Client code</th>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Value counted</th>
                    <th className="px-3 py-2">Match / confidence</th>
                  </tr>
                </thead>
                <tbody className="bg-white">
                  {data.ledger.length === 0 ? (
                    <tr><td className="px-4 py-5 text-center text-[12px] font-medium text-[#64748B]" colSpan={8}>No attributed sales rows.</td></tr>
                  ) : (
                    data.ledger.map((row) => (
                      <tr key={row.ledgerKey} className="border-t border-[#FEE7D2]">
                        <td className="px-3 py-1.5 font-mono text-[#94A3B8]">{row.sosRowId ?? "—"}</td>
                        <td className="px-3 py-1.5 font-mono font-bold text-[#0F172A]">{row.invoicePeriod}</td>
                        <td className="px-3 py-1.5 font-medium text-[#64748B]">{row.distributorCode}</td>
                        <td className="px-3 py-1.5 font-mono text-[#64748B]">{row.clientCode}</td>
                        <td className="px-3 py-1.5 font-semibold text-[#334155]">{row.productCode}</td>
                        <td className="px-3 py-1.5 text-right font-semibold text-[#475569]">{units(row.qty)}</td>
                        <td className="px-3 py-1.5 text-right font-bold text-[#0F172A]">{money(row.valueCounted)}</td>
                        <td className="px-3 py-1.5">
                          <span className="inline-flex items-center rounded-[4px] border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700" title={row.matchReason}>
                            {row.confidence}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-[10px] font-medium text-[#94A3B8]">
            Ledger reflects the current exact attribution (distributor + pharmacy code + product + period) and reconciles to the actual sales above. Read-only — nothing here changes attribution.
          </p>
        </div>
      ) : null}
    </section>
  );
}
