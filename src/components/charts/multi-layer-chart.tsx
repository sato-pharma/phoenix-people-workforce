"use client";

import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

type ChartLayer = {
  key: string;
  name: string;
  type: "line" | "bar";
  color: string;
};

type MultiLayerChartRow = Record<string, number | string | null | undefined>;

type MultiLayerTooltipEntry = {
  color?: string;
  name?: string;
  value?: number | string;
};

type MultiLayerChartProps = {
  data: MultiLayerChartRow[];
  layers: ChartLayer[];
  xAxisKey: string;
  height?: number;
  yAxisFormatter?: (v: number | string) => string;
  tooltipSuffix?: string;
  hoveredKey?: string | null;
};

export function MultiLayerChart({
  data,
  layers,
  xAxisKey,
  height = 240,
  yAxisFormatter,
  tooltipSuffix = "",
  hoveredKey,
}: MultiLayerChartProps) {
  const isLineChart = layers.some((layer) => layer.type === "line");
  const ChartComponent = isLineChart ? LineChart : BarChart;

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ChartComponent data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
          <XAxis
            dataKey={xAxisKey}
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 9, fontWeight: 700, fill: "#94A3B8" }}
            minTickGap={10}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 9, fontWeight: 700, fill: "#94A3B8" }}
            tickFormatter={yAxisFormatter}
            width={35}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (active && payload && payload.length) {
                return (
                  <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
                    <p className="mb-1 text-phx-2xs font-black uppercase tracking-wider text-slate-400">{label}</p>
                    <div className="space-y-1.5">
                      {payload.map((entry, index) => {
                        const item = entry as MultiLayerTooltipEntry;
                        return (
                        <div key={index} className="flex items-center justify-between gap-4">
                          <div className="flex items-center gap-2">
                            <div className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
                            <span className="text-phx-xs font-bold text-slate-600">{item.name}:</span>
                          </div>
                          <span className="text-phx-xs font-black text-slate-900">
                            {Number(item.value ?? 0).toLocaleString()}{tooltipSuffix}
                          </span>
                        </div>
                        );
                      })}
                    </div>
                  </div>
                );
              }
              return null;
            }}
          />
          {layers.map((layer) => {
            if (layer.type === "line") {
              return (
                <Line
                  key={layer.key}
                  type="monotone"
                  dataKey={layer.key}
                  name={layer.name}
                  stroke={layer.color}
                  strokeWidth={3}
                  dot={{ r: 4, fill: layer.color }}
                  strokeOpacity={hoveredKey && hoveredKey !== layer.key ? 0.1 : 1}
                  className="transition-opacity duration-300"
                />
              );
            }
            return (
              <Bar
                key={layer.key}
                dataKey={layer.key}
                name={layer.name}
                fill={layer.color}
                radius={[2, 2, 0, 0]}
                opacity={hoveredKey && hoveredKey !== layer.key ? 0.3 : 1}
                className="transition-opacity duration-300"
              />
            );
          })}
        </ChartComponent>
      </ResponsiveContainer>
    </div>
  );
}
