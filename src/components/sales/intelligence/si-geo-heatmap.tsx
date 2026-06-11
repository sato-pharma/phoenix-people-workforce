"use client";

import { useState } from "react";

import { formatCurrency } from "@/lib/sales/format";
import type { SiAreaRow, SiRanked } from "@/lib/sales/intelligence/types";
import { cn } from "@/lib/utils";

// Region → area heatmap. Each area tile is shaded from pale to deep orange by its value share;
// hovering reveals the exact value/units/share. Pure SVG/CSS (Google Maps is reserved for the
// outstation module). Underperformers (bottom quartile by value, with non-zero sales) get a ring.
export function SiGeoHeatmap({ regions, areas }: { regions: SiRanked[]; areas: SiAreaRow[] }) {
  const [hovered, setHovered] = useState<string | null>(null);
  if (areas.length === 0) {
    return <p className="px-5 py-10 text-center text-sm text-[#94A3B8]">No geography in scope for this month.</p>;
  }
  const maxValue = Math.max(...areas.map((area) => area.value), 1);
  const nonZero = areas.filter((area) => area.value > 0).map((area) => area.value).sort((a, b) => a - b);
  const weakThreshold = nonZero.length > 0 ? nonZero[Math.floor(nonZero.length * 0.25)] : 0;

  return (
    <div className="space-y-5 p-4 md:p-5">
      {/* Region totals strip */}
      <div className="flex flex-wrap gap-2">
        {regions.map((region) => (
          <div key={region.name} className="flex items-center gap-2 border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5">
            <span className="text-xs font-black text-[#0F172A]">{region.name}</span>
            <span className="text-[11px] font-bold text-[#64748B]">{formatCurrency(region.value)}</span>
            <span className="text-[10px] font-black text-[#F97316]">{(region.share * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>

      {/* Area heat grid */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {areas.map((area) => {
          const intensity = area.value / maxValue;
          const alpha = area.value > 0 ? 0.14 + intensity * 0.82 : 0.04;
          const deep = alpha > 0.58;
          const weak = area.value > 0 && area.value <= weakThreshold;
          const key = `${area.regionName}:${area.name}`;
          return (
            <div
              key={key}
              className={cn(
                "relative flex min-h-[78px] flex-col justify-between border p-2.5 transition",
                deep ? "border-transparent" : "border-[#FBE3CC]",
                weak ? "ring-2 ring-rose-300" : "",
                hovered && hovered !== key ? "opacity-50" : "opacity-100",
              )}
              onMouseEnter={() => setHovered(key)}
              onMouseLeave={() => setHovered(null)}
              style={{ backgroundColor: `rgba(249,115,22,${alpha.toFixed(3)})` }}
              title={`${area.name} — ${area.regionName} · ${formatCurrency(area.value)} · ${(area.share * 100).toFixed(1)}%`}
            >
              <p className={cn("truncate text-[11px] font-black", deep ? "text-white" : "text-[#0F172A]")}>{area.name}</p>
              <div>
                <p className={cn("truncate text-[9px] font-bold uppercase tracking-wide", deep ? "text-white/70" : "text-[#94A3B8]")}>{area.regionName}</p>
                <p className={cn("text-[11px] font-black", deep ? "text-white" : "text-[#B45309]")}>
                  {formatCurrency(area.value)}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3 text-[10px] font-bold text-[#94A3B8]">
        <span>Low</span>
        <div className="h-2 flex-1 rounded-full" style={{ background: "linear-gradient(90deg, rgba(249,115,22,0.14), rgba(249,115,22,0.96))" }} />
        <span>High</span>
        <span className="ml-2 inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full ring-2 ring-rose-300" /> Underperforming</span>
      </div>
    </div>
  );
}
