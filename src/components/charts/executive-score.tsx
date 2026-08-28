"use client";

import { Gauge } from "lucide-react";
import { useMemo } from "react";
import { ChartCard } from "@/components/cards/chart-card";
import { SectionHeader } from "@/components/ui/section-header";
import { PremiumTooltip } from "@/components/ui/premium-tooltip";
import { ChartProps } from "./chart-types";
import { cn } from "@/lib/utils";

type ExecutiveScoreProps = ChartProps & {
  data: {
    sales: { achievementRate: number; dataQualityRate: number };
    payroll: { readinessRate: number };
    hr: { employeeHealthRate: number };
  };
  moduleErrors: unknown[];
};

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
}

function formatPercent(value: number) {
  return `${((Number.isFinite(value) ? value : 0) * 100).toFixed(1)}%`;
}

function ScoreRing({ score }: { score: number }) {
  const pct = clamp(score) * 100;

  return (
    <PremiumTooltip
      content={
        <div className="space-y-1">
          <p className="text-xs font-bold text-phx-ink">Executive Health Score</p>
          <p className="text-[11px] text-phx-ink-soft">{pct.toFixed(0)} out of 100</p>
          <p className="text-[11px] font-bold text-phx-accent">{pct >= 80 ? "Excellent" : pct >= 60 ? "Good" : "Needs attention"}</p>
        </div>
      }
    >
      <div className="relative mx-auto h-24 w-24 shrink-0 rounded-full sm:h-32 sm:w-32 md:h-36 md:w-36" style={{ background: `conic-gradient(#F97316 0 ${pct}%, #E2E8F0 ${pct}% 100%)` }}>
        <div className="absolute inset-3 flex flex-col items-center justify-center rounded-full bg-white shadow-inner sm:inset-4">
          <p className="text-2xl font-black text-phx-ink sm:text-3xl">{pct.toFixed(0)}</p>
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-phx-ink-soft">Score</p>
        </div>
      </div>
    </PremiumTooltip>
  );
}

export function ExecutiveScore({ data, moduleErrors, hoveredElement, onHover, loading = false }: ExecutiveScoreProps) {
  const score = useMemo(() => {
    const sales = clamp(data.sales.achievementRate / 0.9);
    const payroll = clamp(data.payroll.readinessRate);
    const employees = clamp(data.hr.employeeHealthRate);
    const quality = clamp(data.sales.dataQualityRate);
    const modulePenalty = Math.max(0, 1 - moduleErrors.length * 0.08);
    return (sales * 0.3 + payroll * 0.25 + employees * 0.2 + quality * 0.15 + modulePenalty * 0.1) * 100;
  }, [data, moduleErrors]);

  const metrics = useMemo(() => [
    { label: "Sales Achievement", value: data.sales.achievementRate, description: "Sales vs target performance" },
    { label: "Payroll Readiness", value: data.payroll.readinessRate, description: "Payroll processing completeness" },
    { label: "Workforce Health", value: data.hr.employeeHealthRate, description: "Active employee ratio" },
    { label: "Data Quality", value: data.sales.dataQualityRate, description: "Sales data validation rate" },
    { label: "Module Status", value: Math.max(0, 1 - moduleErrors.length * 0.08), description: "System module availability" },
  ], [data, moduleErrors]);

  if (loading) {
    return (
      <ChartCard>
        <div className="h-64 animate-pulse bg-phx-paper rounded-lg" />
      </ChartCard>
    );
  }

  return (
    <ChartCard>
      <SectionHeader icon={Gauge} subtitle="Composite health score across all modules." title="Executive Health Score" />
      <div className="mt-6 flex flex-col items-center gap-6 sm:flex-row sm:items-start sm:justify-center">
        <ScoreRing score={score} />
        <div className="w-full space-y-3 sm:min-w-0">
          {metrics.map((metric) => {
            const isHovered = hoveredElement === `metric-${metric.label}`;
            return (
              <PremiumTooltip
                content={
                  <div className="space-y-1">
                    <p className="text-xs font-bold text-phx-ink">{metric.label}</p>
                    <p className="text-[11px] text-phx-ink-soft">{formatPercent(metric.value)}</p>
                    <p className="text-[10px] text-phx-ink-soft">{metric.description}</p>
                  </div>
                }
                key={metric.label}
              >
                <div 
                  className={cn("flex items-center justify-between gap-4 transition", isHovered && "bg-phx-paper px-2 py-1 rounded-lg")}
                  onMouseEnter={() => onHover(`metric-${metric.label}`)}
                  onMouseLeave={() => onHover(null)}
                >
                  <p className={cn("text-sm font-black", isHovered ? "text-phx-accent" : "text-phx-ink")}>{metric.label}</p>
                  <p className="text-xs font-black text-phx-ink-soft">{formatPercent(metric.value)}</p>
                </div>
              </PremiumTooltip>
            );
          })}
        </div>
      </div>
    </ChartCard>
  );
}
