"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { ChartErrorBoundary } from "@/components/coaching/chart-error-boundary";
import type { CoachingScoreTrendPoint } from "@/lib/coaching/landing-insights";

/**
 * "Monthly score trend" card — the same average-score line the coaching
 * analytics workspace shows, framed in the portal's premium design language
 * (square edges, slate-900 header, orange accent) so it sits naturally above
 * the Double-Visit Trend block on the Training Manager landing page.
 *
 * Renders nothing when there are fewer than two trend points.
 */
export function CoachingScoreTrendCard({
  data,
  title = "Monthly Score Trend",
}: {
  data: CoachingScoreTrendPoint[];
  title?: string;
}) {
  if (data.length < 2) return null;

  return (
    <ChartErrorBoundary>
      <div className="overflow-hidden border border-slate-200 bg-white" role="region" aria-label="Monthly coaching score trend">
        <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">{title}</h2>
          <div className="h-1.5 w-12 bg-orange-500" />
        </div>
        <div className="p-4">
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 4, right: 12, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={{ stroke: "#e2e8f0" }} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} domain={[0, 100]} axisLine={{ stroke: "#e2e8f0" }} tickLine={false} />
                <Tooltip
                  contentStyle={{ borderRadius: 0, border: "1px solid #e2e8f0", fontSize: 12 }}
                  formatter={(value) => [`${Number(value ?? 0).toFixed(1)}%`, "Score"]}
                />
                <Line
                  type="monotone"
                  dataKey="avg"
                  stroke="#ea580c"
                  strokeWidth={2}
                  dot={{ r: 3, fill: "#ea580c", stroke: "#fff", strokeWidth: 2 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </ChartErrorBoundary>
  );
}
