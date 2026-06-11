"use client";

import { ChevronRight, Package } from "lucide-react";
import { useState } from "react";

import { ChartCard } from "@/components/cards/chart-card";
import { SectionHeader } from "@/components/ui/section-header";
import { SiDeltaBadge } from "@/components/sales/intelligence/si-delta-badge";
import { shareText } from "@/components/sales/intelligence/si-format";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import type { SiMovers, SiProductRow } from "@/lib/sales/intelligence/types";
import { cn } from "@/lib/utils";

const PREVIEW_ROWS = 12;

// Product Pareto table. The cumulative-share column renders an in-cell progress bar so the
// Pareto cliff is visible INSIDE the table; every row is a door into the product drill-down.
export function SiProductsTable({
  products,
  movers,
  moversPending,
  onOpenProduct,
}: {
  products: SiProductRow[];
  movers: SiMovers | null;
  moversPending: boolean;
  onOpenProduct: (productCode: string, productName: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? products : products.slice(0, PREVIEW_ROWS);
  const momByKey = movers
    ? new Map(
        [...movers.products.gainers, ...movers.products.decliners, ...movers.products.entrants]
          .map((mover) => [mover.key, mover.deltaPct]),
      )
    : null;

  return (
    <ChartCard className="p-5">
      <SectionHeader
        icon={Package}
        subtitle="Every row opens the product drill-down — daily curve, distributor and region splits, and its top customers."
        title="Product Performance"
      />
      <div className="mt-4 overflow-x-auto" id="products">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead>
            <tr>
              <th className="px-3 py-2 text-xs font-black uppercase tracking-wide">#</th>
              <th className="px-3 py-2 text-xs font-black uppercase tracking-wide">Product</th>
              <th className="px-3 py-2 text-xs font-black uppercase tracking-wide">Line</th>
              <th className="px-3 py-2 text-right text-xs font-black uppercase tracking-wide">Units</th>
              <th className="px-3 py-2 text-right text-xs font-black uppercase tracking-wide">Value</th>
              <th className="px-3 py-2 text-right text-xs font-black uppercase tracking-wide">Share</th>
              <th className="px-3 py-2 text-xs font-black uppercase tracking-wide">Cum. Share</th>
              <th className="px-3 py-2 text-right text-xs font-black uppercase tracking-wide">MoM</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {visible.map((product, index) => (
              <tr
                className="group cursor-pointer transition hover:bg-orange-50"
                key={product.code}
                onClick={() => onOpenProduct(product.code, product.name)}
              >
                <td className="w-10 px-3 py-2 text-center text-xs font-black tabular-nums text-[#64748B]">{index + 1}</td>
                <td className="px-3 py-2 font-bold text-[#0F172A] transition group-hover:text-[#F97316]">{product.name}</td>
                <td className="px-3 py-2 text-[#64748B]">{product.officialLine}</td>
                <td className="px-3 py-2 text-right tabular-nums text-[#64748B]">{formatNumber(product.units)}</td>
                <td className="px-3 py-2 text-right font-black tabular-nums text-[#0F172A]">{formatCurrency(product.value)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-[#64748B]">{shareText(product.share)}</td>
                <td className="w-32 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-16 shrink-0 bg-orange-500/15">
                      <div className="h-full bg-orange-500" style={{ width: `${Math.min(product.cumulativeShare * 100, 100)}%` }} />
                    </div>
                    <span className="text-[11px] font-bold tabular-nums text-[#94A3B8]">{(product.cumulativeShare * 100).toFixed(0)}%</span>
                  </div>
                </td>
                <td className="px-3 py-2 text-right">
                  <SiDeltaBadge pct={momByKey ? momByKey.get(product.code) ?? null : null} pending={moversPending} />
                </td>
                <td className="w-8 px-2 py-2">
                  <ChevronRight className="h-3.5 w-3.5 text-transparent transition group-hover:text-[#F97316]" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {products.length > PREVIEW_ROWS && (
        <button
          className={cn("mt-3 text-[11px] font-black text-[#F97316] hover:underline")}
          onClick={() => setShowAll((current) => !current)}
          type="button"
        >
          {showAll ? "Show top 12" : `View all ${products.length} products`}
        </button>
      )}
    </ChartCard>
  );
}
