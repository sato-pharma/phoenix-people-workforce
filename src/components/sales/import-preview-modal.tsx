"use client";

import { AlertTriangle, CheckCircle2, Loader2, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { BrickSuggestionView } from "@/lib/sales/brick-suggestions";
import type { ImportPreviewDiff } from "@/lib/sales/import-preview";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import type { DistributorSalesValidationResult } from "@/lib/sales/monthly-distributor-import";

export type PreviewResult = DistributorSalesValidationResult & {
  previewDiff?: ImportPreviewDiff;
  suggestions?: BrickSuggestionView[];
};

type Props = {
  committing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  result: PreviewResult;
};

type AcceptResponse = {
  data?: { accepted: number; failed: number; results: { customerCode: string; error?: string; ok: boolean }[] };
  error?: string;
  message?: string;
  success: boolean;
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

// Smart brick suggestions — each row is a customer with no mapping yet, matched (by name, or
// name+address) to an already-mapped twin (possibly another distributor). Accepting writes to the
// mapping sheet via /accept-mappings; the user then re-runs Preview to see the customers resolve.
function SuggestionsSection({ suggestions }: { suggestions: BrickSuggestionView[] }) {
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [busyAll, setBusyAll] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (suggestions.length === 0) return null;

  const pendingHigh = suggestions.filter((s) => s.confidence === "high" && !accepted.has(s.customerCode));
  const busy = busyAll || busyCode !== null;

  async function accept(items: BrickSuggestionView[]) {
    if (items.length === 0) return;
    const mappings = items.map((s) => ({
      address: s.address,
      brickId: s.suggestedBrickId,
      customerCode: s.customerCode,
      customerName: s.customerName,
      distributorCode: s.distributorCode,
    }));
    try {
      const response = await fetch("/api/sales/monthly-import/accept-mappings", {
        body: JSON.stringify({ mappings }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({ success: false }))) as AcceptResponse;
      const okCodes = (payload.data?.results ?? []).filter((r) => r.ok).map((r) => r.customerCode);
      if (okCodes.length > 0) setAccepted((prev) => new Set([...prev, ...okCodes]));
      setMessage(payload.message ?? payload.error ?? "Done.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to add mappings.");
    }
  }

  const acceptOne = (s: BrickSuggestionView) => {
    setBusyCode(s.customerCode);
    void accept([s]).finally(() => setBusyCode(null));
  };
  const acceptAllHigh = () => {
    setBusyAll(true);
    void accept(pendingHigh).finally(() => setBusyAll(false));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">
          <Sparkles className="h-3.5 w-3.5 text-[#F97316]" />
          Suggested mappings ({formatNumber(suggestions.length)})
        </p>
        {pendingHigh.length > 0 ? (
          <Button
            className="h-8 gap-1.5 rounded-lg bg-[#0B0B0B] text-xs font-black text-white hover:bg-[#F97316]"
            disabled={busy}
            onClick={acceptAllHigh}
            type="button"
          >
            {busyAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            Accept all high ({pendingHigh.length})
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-[#64748B]">
        Matched to an already-mapped customer with the same name (or name + address). Accepting writes to the mapping sheet — re-run Preview to see them resolve.
      </p>
      <div className="overflow-hidden rounded-lg border border-[#E2E8F0]">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#F8FAFC] text-left text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Suggested brick</th>
              <th className="px-3 py-2">Match</th>
              <th className="px-3 py-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {suggestions.map((s) => {
              const isAccepted = accepted.has(s.customerCode);
              return (
                <tr key={s.customerCode} className="border-t border-[#EEF2F7]">
                  <td className="px-3 py-1.5">
                    <span className="font-semibold text-[#0F172A]">{s.customerCode}</span>
                    {s.customerName ? <span className="block max-w-[160px] truncate text-xs text-[#64748B]">{s.customerName}</span> : null}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="font-medium text-[#0F172A]">{s.brickName}</span>
                    <span className="block text-xs text-[#94A3B8]">from {s.sourceDistributorCode}</span>
                  </td>
                  <td className="px-3 py-1.5">
                    <Badge variant={s.confidence === "high" ? "success" : "neutral"}>
                      {s.confidence === "high" ? "name + address" : "name only"}
                    </Badge>
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {isAccepted ? (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Added
                      </span>
                    ) : (
                      <Button
                        className="h-7 rounded-md px-3 text-xs font-bold"
                        disabled={busy}
                        onClick={() => acceptOne(s)}
                        type="button"
                        variant="secondary"
                      >
                        {busyCode === s.customerCode ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Accept"}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {message ? <p className="text-xs font-semibold text-emerald-700">{message}</p> : null}
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

          <SuggestionsSection suggestions={result.suggestions ?? []} />

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
