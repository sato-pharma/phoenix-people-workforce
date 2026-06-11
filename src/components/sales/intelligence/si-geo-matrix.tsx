"use client";

import { Map as MapIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { ChartCard } from "@/components/cards/chart-card";
import { SectionHeader } from "@/components/ui/section-header";
import { PremiumTooltip } from "@/components/ui/premium-tooltip";
import { compactEGP, shareText } from "@/components/sales/intelligence/si-format";
import { formatCurrency } from "@/lib/sales/format";
import type { SiAreaRow, SiRanked } from "@/lib/sales/intelligence/types";
import { cn } from "@/lib/utils";

const DESKTOP_CAP = 12;

// Region-banded heat matrix: each region gets a black header strip (name, total, share, inline
// share bar) and its area tiles beneath, shaded on an orange alpha ramp against the COMPANY-wide
// max so cross-region comparison stays honest. Bottom-quartile performers get a rose ring.
export function SiGeoMatrix({
  regions,
  areas,
  zeroSalesAreasCount,
}: {
  regions: SiRanked[];
  areas: SiAreaRow[];
  zeroSalesAreasCount: number;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const { bands, maxValue, weakThreshold } = useMemo(() => {
    const max = Math.max(...areas.map((area) => area.value), 1);
    const nonZero = areas.filter((area) => area.value > 0).map((area) => area.value).sort((a, b) => a - b);
    const weak = nonZero.length > 0 ? nonZero[Math.floor(nonZero.length * 0.25)] : 0;
    const byRegion = new Map<string, SiAreaRow[]>();
    for (const area of areas) {
      const list = byRegion.get(area.regionName) ?? [];
      list.push(area);
      byRegion.set(area.regionName, list);
    }
    const ordered = regions
      .filter((region) => byRegion.has(region.name))
      .map((region) => ({ region, areas: (byRegion.get(region.name) ?? []).sort((a, b) => b.value - a.value) }));
    return { bands: ordered, maxValue: max, weakThreshold: weak };
  }, [regions, areas]);

  const maxRegionValue = Math.max(...regions.map((region) => region.value), 1);

  if (areas.length === 0) {
    return (
      <ChartCard className="p-5">
        <SectionHeader icon={MapIcon} subtitle="No geography in scope for this month." title="Geographic Performance" />
      </ChartCard>
    );
  }

  return (
    <ChartCard className="p-5">
      <SectionHeader
        action={zeroSalesAreasCount > 0 ? (
          <span className="border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-amber-700">
            {zeroSalesAreasCount} zero-sales areas
          </span>
        ) : undefined}
        icon={MapIcon}
        subtitle="Areas shaded by net sales against the company-wide maximum, grouped under their region. Geography is shown by name — no personnel attribution."
        title="Geographic Performance"
      />
      <div className="mt-4 space-y-4">
        {bands.map(({ region, areas: regionAreas }) => {
          const isExpanded = expanded[region.name] ?? false;
          const cap = isExpanded ? regionAreas.length : DESKTOP_CAP;
          const visible = regionAreas.slice(0, cap);
          return (
            <div key={region.name}>
              {/* Region header strip — light, softly shaded, orange accent. */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-l-4 border-orange-500 bg-gradient-to-r from-[#FFF7ED] to-white px-4 py-2.5">
                <span className="text-xs font-black uppercase tracking-wide text-[#0F172A]">{region.name}</span>
                <span className="text-xs font-bold tabular-nums text-[#475569]">{formatCurrency(region.value)}</span>
                <span className="text-[11px] font-black text-[#F97316]">{shareText(region.share)}</span>
                <span className="text-[10px] font-bold text-[#94A3B8]">{regionAreas.length} areas</span>
                <div className="ml-auto hidden h-1.5 w-24 bg-orange-500/15 sm:block">
                  <div className="h-full bg-[#F97316]" style={{ width: `${Math.max((region.value / maxRegionValue) * 100, 2)}%` }} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1.5 border border-t-0 border-[#F1F5F9] p-1.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                {visible.map((area) => {
                  const intensity = area.value / maxValue;
                  const alpha = area.value > 0 ? 0.14 + intensity * 0.82 : 0.05;
                  const deep = alpha > 0.58;
                  const weak = area.value > 0 && area.value <= weakThreshold;
                  return (
                    <PremiumTooltip
                      content={(
                        <div className="space-y-1">
                          <p className="text-xs font-black text-[#0F172A]">{area.name}</p>
                          <p className="text-[11px] font-bold text-[#64748B]">{area.regionName}</p>
                          <p className="text-[11px] font-black text-[#0F172A]">{formatCurrency(area.value)}</p>
                          <p className="text-[10px] font-bold text-[#F97316]">{shareText(area.share)} of scoped value</p>
                          {weak && <p className="text-[10px] font-black text-rose-600">Bottom quartile</p>}
                        </div>
                      )}
                      key={`${area.regionName}:${area.name}`}
                      triggerClassName="block"
                    >
                      <div
                        className={cn(
                          "flex min-h-[62px] flex-col justify-between p-2 transition",
                          weak && "ring-2 ring-inset ring-rose-300",
                        )}
                        style={{ backgroundColor: `rgba(249,115,22,${alpha.toFixed(3)})` }}
                      >
                        <p className={cn("truncate text-[11px] font-black", deep ? "text-white" : "text-[#0F172A]")}>{area.name}</p>
                        <p className={cn("text-[10px] font-black tabular-nums", deep ? "text-white/90" : "text-[#B45309]")}>
                          {compactEGP(area.value)}
                        </p>
                      </div>
                    </PremiumTooltip>
                  );
                })}
                {regionAreas.length > cap && (
                  <button
                    className="flex min-h-[62px] items-center justify-center border border-dashed border-[#CBD5E1] text-[11px] font-black text-[#64748B] transition hover:border-[#F97316] hover:text-[#F97316]"
                    onClick={() => setExpanded((current) => ({ ...current, [region.name]: true }))}
                    type="button"
                  >
                    +{regionAreas.length - cap} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-3 text-[10px] font-bold text-[#94A3B8]">
        <span>Low</span>
        <div className="h-2 flex-1" style={{ background: "linear-gradient(90deg, rgba(249,115,22,0.14), rgba(249,115,22,0.96))" }} />
        <span>High</span>
        <span className="ml-2 inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 ring-2 ring-rose-300" /> Bottom quartile
        </span>
      </div>
    </ChartCard>
  );
}
