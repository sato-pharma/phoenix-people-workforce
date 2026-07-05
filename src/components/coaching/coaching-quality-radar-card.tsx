"use client";

import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
} from "recharts";

import { ChartErrorBoundary } from "@/components/coaching/chart-error-boundary";
import { getCoachingScoreColor, type CoachingQualityRadarPoint } from "@/lib/coaching/landing-insights";

/**
 * "Coaching quality overview" radar — the same proxy-metric radar the coaching
 * analytics workspace shows (avg score, consistency, completion, acknowledgment,
 * recent trend), framed in the portal's premium design language and paired with
 * a per-dimension breakdown so it fills a full-width landing row.
 *
 * Renders nothing when there is no completed-report data.
 */
export function CoachingQualityRadarCard({
  data,
  title = "Coaching Quality Overview",
}: {
  data: CoachingQualityRadarPoint[];
  title?: string;
}) {
  if (data.length === 0) return null;

  return (
    <ChartErrorBoundary>
      <div className="overflow-hidden border border-slate-200 bg-white" role="region" aria-label="Coaching quality overview">
        <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">{title}</h2>
          <div className="h-1.5 w-12 bg-orange-500" />
        </div>
        <div className="grid gap-4 p-4 md:grid-cols-2 md:items-center">
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart cx="50%" cy="50%" outerRadius="80%" data={data}>
                <PolarGrid stroke="#e2e8f0" />
                <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 10, fill: "#64748b" }} />
                <PolarRadiusAxis angle={90} domain={[0, 100]} tick={{ fontSize: 9, fill: "#94a3b8" }} axisLine={false} />
                <Radar name="Score" dataKey="value" stroke="#ea580c" fill="#ea580c" fillOpacity={0.15} strokeWidth={2} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
          <div className="space-y-3">
            {data.map((point) => (
              <div key={point.dimension}>
                <div className="flex items-center justify-between gap-3">
                  <span className="whitespace-nowrap text-[11px] font-semibold text-slate-600">{point.dimension}</span>
                  <span
                    className="whitespace-nowrap text-sm font-bold tabular-nums"
                    style={{ color: getCoachingScoreColor(point.value) }}
                  >
                    {point.value.toFixed(1)}%
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden bg-slate-100">
                  <div
                    className="h-full transition-all duration-300"
                    style={{ width: `${Math.min(100, Math.max(0, point.value))}%`, backgroundColor: getCoachingScoreColor(point.value) }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </ChartErrorBoundary>
  );
}
