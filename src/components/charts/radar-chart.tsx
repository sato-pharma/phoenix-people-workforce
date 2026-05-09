"use client";

import {
  Radar,
  RadarChart as RechartsRadarChart,
  PolarGrid,
  PolarAngleAxis,
  ResponsiveContainer,
  Tooltip
} from "recharts";

type RadarChartRow = Record<string, number | string | null | undefined> & {
  desc?: string;
};

type RadarTooltipEntry = {
  payload?: RadarChartRow;
  value?: number | string;
};

type RadarChartProps = {
  data: RadarChartRow[];
  dataKey: string;
  subjectKey: string;
  height?: number;
  color?: string;
};

export function RadarChart({
  data,
  dataKey,
  subjectKey,
  height = 220,
  color = "#F97316"
}: RadarChartProps) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <RechartsRadarChart cx="50%" cy="50%" outerRadius="70%" data={data}>
          <PolarGrid stroke="#E2E8F0" />
          <PolarAngleAxis
            dataKey={subjectKey}
            tick={{ fontSize: 9, fontWeight: 800, fill: "#64748B" }}
          />
          <Radar
            dataKey={dataKey}
            stroke={color}
            fill={color}
            fillOpacity={0.1}
            strokeWidth={2}
          />
          <Tooltip
            content={({ active, payload }) => {
              const firstEntry = payload?.[0] as RadarTooltipEntry | undefined;
              const item = firstEntry?.payload;
              if (active && item && firstEntry) {
                return (
                  <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-xl max-w-[200px]">
                    <p className="text-[10px] font-black uppercase text-slate-400">{String(item?.[subjectKey] ?? "-")}</p>
                    <p className="text-lg font-black text-slate-900">{Number(firstEntry.value ?? 0)}%</p>
                    {item.desc && <p className="mt-1 text-[9px] font-medium text-slate-500 leading-tight">{item.desc}</p>}
                  </div>
                );
              }
              return null;
            }}
          />
        </RechartsRadarChart>
      </ResponsiveContainer>
    </div>
  );
}
