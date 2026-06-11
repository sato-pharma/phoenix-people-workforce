"use client";

import { TrendingUp } from "lucide-react";

import { ChartCard } from "@/components/cards/chart-card";
import { SectionHeader } from "@/components/ui/section-header";
import { SiDeltaBadge } from "@/components/sales/intelligence/si-delta-badge";
import { compactEGP } from "@/components/sales/intelligence/si-format";
import type { SiMoverRow, SiMovers, SiProductRow } from "@/lib/sales/intelligence/types";
import { cn } from "@/lib/utils";

function MoverBar({ mover, maxAbs, direction, onOpen }: {
  mover: SiMoverRow;
  maxAbs: number;
  direction: "gain" | "loss";
  onOpen?: (productCode: string) => void;
}) {
  const widthPct = Math.max((Math.abs(mover.deltaValue) / maxAbs) * 100, 3);
  const gain = direction === "gain";
  return (
    <button
      className="group grid w-full grid-cols-[minmax(0,1fr)_96px] items-center gap-3 text-left"
      onClick={onOpen ? () => onOpen(mover.key) : undefined}
      type="button"
    >
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs font-bold text-[#0F172A] transition group-hover:text-[#F97316]">
            {mover.name}
            {mover.officialLine && <span className="ml-2 text-[10px] font-bold text-[#94A3B8]">{mover.officialLine}</span>}
          </p>
        </div>
        {/* Diverging bar: gains grow right from center, losses grow left. */}
        <div className="mt-1 flex h-2.5 w-full">
          <div className="flex w-1/2 justify-end">
            {!gain && <div className="h-full bg-rose-500" style={{ width: `${widthPct}%` }} />}
          </div>
          <div className="w-px shrink-0 bg-[#CBD5E1]" />
          <div className="w-1/2">
            {gain && <div className="h-full bg-emerald-500" style={{ width: `${widthPct}%` }} />}
          </div>
        </div>
      </div>
      <div className="text-right">
        <p className={cn("text-xs font-black tabular-nums", gain ? "text-emerald-700" : "text-rose-700")}>
          {gain ? "+" : "−"}EGP {compactEGP(Math.abs(mover.deltaValue))}
        </p>
        <SiDeltaBadge pct={mover.deltaPct} />
      </div>
    </button>
  );
}

// Product movers vs the prior month — diverging center-axis list. With no baseline month the
// component swaps WHOLESALE to a top-products bar list (never half-renders fake deltas).
export function SiProductMovers({
  movers,
  topProducts,
  pending,
  onOpenProduct,
}: {
  movers: SiMovers | null;
  topProducts: SiProductRow[];
  pending: boolean;
  onOpenProduct?: (productCode: string) => void;
}) {
  const hasBaseline = movers !== null && movers.priorPeriod !== null;
  const gainers = movers?.products.gainers.slice(0, 5) ?? [];
  const decliners = movers?.products.decliners.slice(0, 5) ?? [];
  const maxAbs = Math.max(
    ...gainers.map((mover) => Math.abs(mover.deltaValue)),
    ...decliners.map((mover) => Math.abs(mover.deltaValue)),
    1,
  );

  return (
    <ChartCard className="h-full p-5">
      <SectionHeader
        action={hasBaseline ? (
          <span className="border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-[#64748B]">
            vs {movers?.priorPeriod}
          </span>
        ) : undefined}
        icon={TrendingUp}
        subtitle={hasBaseline ? "Top gainers and decliners by value vs the prior month." : "Top products by value."}
        title={hasBaseline ? "Product Movers" : "Top Products"}
      />
      <div className="mt-4">
        {pending ? (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div className="h-9 animate-pulse bg-[#F8FAFC]" key={index} />
            ))}
          </div>
        ) : hasBaseline ? (
          <div className="space-y-5">
            {gainers.length === 0 && decliners.length === 0 ? (
              <p className="py-6 text-center text-xs font-bold text-[#94A3B8]">No movement vs the prior month.</p>
            ) : (
              <>
                <div className="space-y-3">
                  {gainers.map((mover) => (
                    <MoverBar direction="gain" key={mover.key} maxAbs={maxAbs} mover={mover} onOpen={onOpenProduct} />
                  ))}
                </div>
                {decliners.length > 0 && (
                  <div className="space-y-3 border-t border-[#EEF2F7] pt-4">
                    {decliners.map((mover) => (
                      <MoverBar direction="loss" key={mover.key} maxAbs={maxAbs} mover={mover} onOpen={onOpenProduct} />
                    ))}
                  </div>
                )}
                {(movers?.products.entrants.length ?? 0) > 0 && (
                  <p className="border-t border-[#EEF2F7] pt-3 text-[10px] font-bold text-[#64748B]">
                    New this month: {movers?.products.entrants.slice(0, 4).map((mover) => mover.name).join(", ")}
                  </p>
                )}
                {(movers?.products.lost.length ?? 0) > 0 && (
                  <p className="text-[10px] font-bold text-rose-600">
                    Dropped out: {movers?.products.lost.slice(0, 4).map((mover) => mover.name).join(", ")}
                  </p>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-[11px] font-bold text-[#64748B]">
              First imported month — movers need a prior period.
            </p>
            {topProducts.slice(0, 8).map((product) => {
              const max = Math.max(...topProducts.slice(0, 8).map((row) => row.value), 1);
              return (
                <button
                  className="group grid w-full grid-cols-[minmax(0,1fr)_88px] items-center gap-3 text-left"
                  key={product.code}
                  onClick={onOpenProduct ? () => onOpenProduct(product.code) : undefined}
                  type="button"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-bold text-[#0F172A] transition group-hover:text-[#F97316]">{product.name}</p>
                    <div className="mt-1 h-2 bg-[#F1F5F9]">
                      <div className="h-full bg-gradient-to-r from-orange-500 to-orange-300" style={{ width: `${Math.max((product.value / max) * 100, 4)}%` }} />
                    </div>
                  </div>
                  <p className="text-right text-xs font-black tabular-nums text-[#0F172A]">EGP {compactEGP(product.value)}</p>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </ChartCard>
  );
}
