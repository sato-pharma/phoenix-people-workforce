"use client";

import { Loader2, X } from "lucide-react";
import { useEffect } from "react";

import { DailyRhythmChart } from "@/components/sales/intelligence/si-daily-rhythm";
import { SiDeltaBadge } from "@/components/sales/intelligence/si-delta-badge";
import { compactEGP, compactNumber, shareText } from "@/components/sales/intelligence/si-format";
import { formatCurrency } from "@/lib/sales/format";
import type { SiProductDrill, SiRanked } from "@/lib/sales/intelligence/types";
import { cn } from "@/lib/utils";

function SplitBars({ rows, title }: { rows: SiRanked[]; title: string }) {
  const max = Math.max(...rows.map((row) => row.value), 1);
  return (
    <div>
      <p className="mb-2 text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]">{title}</p>
      <div className="space-y-2">
        {rows.slice(0, 8).map((row) => (
          <div className="grid grid-cols-[minmax(0,1fr)_72px] items-center gap-2" key={row.name}>
            <div className="min-w-0">
              <p className="truncate text-[11px] font-bold text-[#0F172A]">{row.name}</p>
              <div className="mt-0.5 h-1.5 bg-[#F1F5F9]">
                <div className="h-full bg-gradient-to-r from-blue-500 to-blue-300" style={{ width: `${Math.max((row.value / max) * 100, 4)}%` }} />
              </div>
            </div>
            <p className="text-right text-[11px] font-black tabular-nums text-[#0F172A]">{compactEGP(row.value)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// Right slide-over: everything about ONE product. Opens instantly from already-loaded row data;
// the drill payload streams in. URL-driven (?product=CODE) so it's deep-linkable.
export function SiProductDrilldown({
  open,
  productName,
  drill,
  loading,
  error,
  onClose,
}: {
  open: boolean;
  /** name from the already-loaded table row — renders the header before the fetch lands */
  productName: string | null;
  drill: SiProductDrill | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div aria-modal="true" className="fixed inset-0 z-50" role="dialog">
      <button aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} type="button" />
      <aside className="absolute inset-y-0 right-0 flex w-full flex-col bg-white shadow-[-24px_0_60px_rgba(0,0,0,0.25)] md:w-[560px]">
        {/* Dark header band */}
        <div className="relative shrink-0 bg-[#0B0B0B] p-5 text-white">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-500/0 via-blue-400/80 to-blue-500/0" />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-blue-300">Product Drill-Down</p>
              <h2 className="mt-1 truncate text-lg font-black">{drill?.productName ?? productName ?? "…"}</h2>
              {drill && (
                <p className="mt-0.5 text-[11px] font-bold text-slate-400">
                  {drill.officialLine} · {shareText(drill.shareOfScopedTotal)} of scoped value · {drill.period}
                </p>
              )}
            </div>
            <button
              className="flex h-9 w-9 shrink-0 items-center justify-center border border-white/20 bg-white/10 text-slate-200 transition hover:bg-white/20"
              onClick={onClose}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {drill && (
            <div className="mt-3 flex items-end gap-5">
              <div>
                <p className="text-3xl font-black tabular-nums">EGP {compactEGP(drill.totals.value)}</p>
                <p className="text-[11px] font-bold text-slate-400">{compactNumber(drill.totals.units)} units</p>
              </div>
              <div className="flex flex-col gap-1 pb-1">
                <SiDeltaBadge label="MoM" pct={drill.compare.value.pct} surface="dark" />
                {drill.avgRealizedPrice !== null && (
                  <span className="text-[10px] font-bold text-slate-400">Avg price EGP {drill.avgRealizedPrice.toFixed(1)}</span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm font-bold text-[#94A3B8]">
              <Loader2 className="h-4 w-4 animate-spin text-[#1E3A5F]" /> Loading product intelligence…
            </div>
          ) : error ? (
            <p className="border border-rose-200 bg-rose-50 p-4 text-sm font-bold text-rose-700">{error}</p>
          ) : drill ? (
            <div className="space-y-6">
              {drill.daily && (
                <div>
                  <p className="mb-2 text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]">Daily Sales</p>
                  <DailyRhythmChart compact curve={drill.daily} />
                </div>
              )}
              <SplitBars rows={drill.distributors} title="By Distributor" />
              <SplitBars rows={drill.regions} title="By Region" />
              <div>
                <p className="mb-2 text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]">
                  Top Customers for this Product
                </p>
                {drill.customers.length === 0 ? (
                  <p className="py-4 text-center text-xs font-bold text-[#94A3B8]">No customer-level rows in scope.</p>
                ) : (
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr>
                        <th className="px-2 py-1.5 text-[10px] font-black uppercase tracking-wide">Customer</th>
                        <th className="px-2 py-1.5 text-[10px] font-black uppercase tracking-wide">Distributor</th>
                        <th className="px-2 py-1.5 text-right text-[10px] font-black uppercase tracking-wide">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {drill.customers.map((customer, index) => (
                        <tr key={`${customer.name}:${index}`}>
                          <td className={cn("px-2 py-1.5 text-xs font-bold text-[#0F172A]", index < 3 && "bg-blue-50")}>{customer.name}</td>
                          <td className="px-2 py-1.5 text-xs text-[#64748B]">{customer.distributorName}</td>
                          <td className="px-2 py-1.5 text-right text-xs font-black tabular-nums text-[#0F172A]">{formatCurrency(customer.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          ) : null}
        </div>

        {/* Mobile close bar */}
        <div className="shrink-0 border-t border-[#E2E8F0] p-3 md:hidden">
          <button className="h-11 w-full bg-[#0B0B0B] text-sm font-black text-white" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </aside>
    </div>
  );
}
