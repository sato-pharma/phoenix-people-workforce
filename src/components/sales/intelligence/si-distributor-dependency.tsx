"use client";

import { AlertTriangle, Truck } from "lucide-react";
import { useState } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { ChartCard } from "@/components/cards/chart-card";
import { SectionHeader } from "@/components/ui/section-header";
import { PremiumTooltip } from "@/components/ui/premium-tooltip";
import { compactEGP, shareText } from "@/components/sales/intelligence/si-format";
import { formatCurrency } from "@/lib/sales/format";
import type { SiDistributorRow } from "@/lib/sales/intelligence/types";
import { cn } from "@/lib/utils";

// Orange family for the top 3 segments, slate ramp for the tail — "how orange is our dependence".
const SPINE_COLORS = ["#F97316", "#FB923C", "#FDBA74", "#0F172A", "#334155", "#64748B", "#94A3B8", "#CBD5E1"];

export function SiDistributorDependency({
  distributors,
}: {
  distributors: SiDistributorRow[];
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const top = distributors[0] ?? null;
  const visible = showAll ? distributors : distributors.slice(0, 6);

  return (
    <ChartCard className="h-full p-5" >
      <SectionHeader
        icon={Truck}
        subtitle="One bar = the whole month. The more orange at the left, the heavier the dependence on few distributors."
        title="Distributor Dependency"
      />

      {/* The dependency spine */}
      <div className="mt-4 flex h-7 w-full overflow-hidden">
        {distributors.map((distributor, index) => (
          <PremiumTooltip
            content={(
              <div className="space-y-1">
                <p className="text-xs font-black text-[#0F172A]">{distributor.name}</p>
                <p className="text-[11px] font-black text-[#0F172A]">{formatCurrency(distributor.value)}</p>
                <p className="text-[10px] font-bold text-[#F97316]">{shareText(distributor.share)} of value</p>
              </div>
            )}
            key={distributor.name}
            triggerClassName="h-full"
          >
            <div
              className={cn("h-full transition-opacity", hovered && hovered !== distributor.name ? "opacity-40" : "opacity-100")}
              onMouseEnter={() => setHovered(distributor.name)}
              onMouseLeave={() => setHovered(null)}
              style={{
                width: `${Math.max(distributor.share * 100, 0.8)}%`,
                backgroundColor: SPINE_COLORS[Math.min(index, SPINE_COLORS.length - 1)],
              }}
            />
          </PremiumTooltip>
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
        {distributors.slice(0, 4).map((distributor, index) => (
          <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-[#64748B]" key={distributor.name}>
            <span className="inline-block h-2 w-2" style={{ backgroundColor: SPINE_COLORS[index] }} />
            {distributor.name} {shareText(distributor.share, 0)}
          </span>
        ))}
      </div>

      {/* Distributor cards */}
      <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {visible.map((distributor) => {
          return (
            <div className="border border-[#E2E8F0] bg-white p-3" key={distributor.name}>
              <div className="flex items-start justify-between gap-2">
                <p className="truncate text-sm font-black text-[#0F172A]">{distributor.name}</p>
                <span className="shrink-0 text-[11px] font-black text-[#F97316]">{shareText(distributor.share)}</span>
              </div>
              <p className="mt-0.5 text-xs font-bold tabular-nums text-[#64748B]">{formatCurrency(distributor.value)} · {compactEGP(distributor.units)} units</p>
              {distributor.productMix.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {distributor.productMix.slice(0, 3).map((product) => (
                    <span className="border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-bold text-[#475569]" key={product.name}>
                      {product.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {distributors.length > 6 && !showAll && (
        <button
          className="mt-2 text-[11px] font-black text-[#F97316] hover:underline"
          onClick={() => setShowAll(true)}
          type="button"
        >
          Show all {distributors.length} distributors
        </button>
      )}

      {/* The narrative payoff */}
      {top && top.share > 0.4 && (
        <div className="mt-4">
          <AdminCallout tone="warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-sm">
              <span className="font-semibold">Distributor concentration:</span> {top.name} carries{" "}
              {shareText(top.share)} of scoped value. A disruption there moves the whole month.
            </p>
          </AdminCallout>
        </div>
      )}
    </ChartCard>
  );
}
