"use client";

import { AlertTriangle, Loader2, X } from "lucide-react";
import { createPortal } from "react-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ImportPreviewDiff } from "@/lib/sales/import-preview";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import type { DistributorSalesValidationResult } from "@/lib/sales/monthly-distributor-import";

export type PreviewResult = DistributorSalesValidationResult & { previewDiff?: ImportPreviewDiff };

type Props = {
  committing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  result: PreviewResult;
};

function StatCard({ label, tone = "neutral", value }: { label: string; tone?: "good" | "warn" | "bad" | "neutral"; value: string }) {
  const toneClass =
    tone === "good"
      ? "text-emerald-600"
      : tone === "warn"
        ? "text-orange-600"
        : tone === "bad"
          ? "text-red-600"
          : "text-slate-900";
  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3">
      <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">{label}</p>
      <p className={`mt-1 text-xl font-black tabular-nums ${toneClass}`}>{value}</p>
    </div>
  );
}

function ChipList({ items, more }: { items: string[]; more: number }) {
  if (items.length === 0) return <p className="text-sm text-[#64748B]">None.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span key={item} className="rounded-md border border-[#E2E8F0] bg-white px-2 py-0.5 text-xs font-medium text-[#0F172A]">
          {item}
        </span>
      ))}
      {more > 0 ? <span className="rounded-md bg-[#F1F5F9] px-2 py-0.5 text-xs font-semibold text-[#64748B]">+{formatNumber(more)} more</span> : null}
    </div>
  );
}

export function ImportPreviewModal({ committing, onCancel, onConfirm, result }: Props) {
  if (typeof document === "undefined") return null;

  const diff = result.previewDiff;
  const blocked = result.status === "blocked";
  const distributorLabel = result.distributor?.name ?? result.distributor?.code ?? "";
  const newMore = diff ? Math.max(0, diff.newCustomers - diff.newCustomerCodes.length) : 0;
  const productMore = diff ? Math.max(0, diff.unmappedProductsCount - diff.unmappedProducts.length) : 0;

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-[#020617]/65 p-4 backdrop-blur-sm">
      <div className="my-6 w-full max-w-2xl rounded-lg border border-[#D8E0EA] bg-white shadow-[0_28px_90px_rgba(15,23,42,0.3)]">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-[#E2E8F0] px-6 py-5">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-black tracking-tight text-slate-950">Review import</h2>
              <Badge variant={blocked ? "danger" : "success"}>{blocked ? "blocked" : "ready"}</Badge>
            </div>
            <p className="mt-1 text-sm text-[#64748B]">
              {distributorLabel}
              {result.period ? ` · ${result.period}` : ""} · {result.sheetName}
            </p>
          </div>
          <button
            aria-label="Close"
            className="rounded-md p-1 text-[#64748B] transition hover:bg-[#F1F5F9] hover:text-slate-900"
            onClick={onCancel}
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-5 px-6 py-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatCard
              label="Rows resolved"
              tone={blocked ? "bad" : "good"}
              value={`${diff?.resolvedRowsPct ?? 0}%`}
            />
            <StatCard label="Importable rows" value={`${formatNumber(result.importableRows)} / ${formatNumber(result.rowCount)}`} />
            <StatCard label="Importable value" value={formatCurrency(diff?.importableValue ?? result.totals.totalValue)} />
          </div>

          {blocked ? (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                <span className="font-semibold">Nothing will be imported.</span> {formatNumber(result.failedRows)} row
                {result.failedRows === 1 ? "" : "s"} are unmapped — map the unknowns below, then re-upload.
              </p>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="New customers" tone={diff && diff.newCustomers > 0 ? "warn" : "neutral"} value={formatNumber(diff?.newCustomers ?? 0)} />
            <StatCard label="Mapped customers" value={formatNumber(diff?.mappedCustomers ?? 0)} />
            <StatCard label="Unmapped products" tone={diff && diff.unmappedProductsCount > 0 ? "warn" : "neutral"} value={formatNumber(diff?.unmappedProductsCount ?? 0)} />
            <StatCard label="Brick drift" tone={diff && diff.brickDriftCount > 0 ? "bad" : "neutral"} value={formatNumber(diff?.brickDriftCount ?? 0)} />
          </div>

          {diff && diff.newCustomers > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">New customers (need mapping)</p>
              <ChipList items={diff.newCustomerCodes} more={newMore} />
            </div>
          ) : null}

          {diff && diff.unmappedProductsCount > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">Unmapped products</p>
              <ChipList items={diff.unmappedProducts} more={productMore} />
            </div>
          ) : null}

          {diff && diff.brickDriftSamples.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">Brick drift — resolved brick ≠ stored mapping</p>
              <div className="overflow-hidden rounded-lg border border-[#E2E8F0]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-[#F8FAFC] text-left text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
                      <th className="px-3 py-2">Customer</th>
                      <th className="px-3 py-2">Stored brick</th>
                      <th className="px-3 py-2">Resolved brick</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diff.brickDriftSamples.map((row) => (
                      <tr key={row.customerCode} className="border-t border-[#EEF2F7]">
                        <td className="px-3 py-1.5 font-medium text-[#0F172A]">{row.customerCode}</td>
                        <td className="px-3 py-1.5 text-[#64748B]">{row.mappedBrickId}</td>
                        <td className="px-3 py-1.5 text-orange-600">{row.resolvedBrickId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-[#E2E8F0] px-6 py-4">
          <Button className="h-10 rounded-xl" disabled={committing} onClick={onCancel} type="button" variant="secondary">
            Cancel
          </Button>
          <Button
            className="h-10 gap-2 rounded-xl bg-[#0B0B0B] font-black text-white transition hover:bg-[#F97316] disabled:opacity-50"
            disabled={blocked || committing}
            onClick={onConfirm}
            type="button"
          >
            {committing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Confirm import
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
