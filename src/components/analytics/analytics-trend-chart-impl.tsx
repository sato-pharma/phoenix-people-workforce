"use client";

// Thin client wrapper around the shared MultiLayerChart so analytics pages
// (Server Components) never need to pass a yAxisFormatter function prop
// across the server/client boundary — the formatter is defined here, inside
// the client tree, and only plain serializable data crosses the boundary.

import { MultiLayerChart } from "@/components/charts/multi-layer-chart";

type Layer = { key: string; name: string; type: "line" | "bar"; color: string };

type Props = {
  data: Record<string, number | string | null | undefined>[];
  layers: Layer[];
  xAxisKey: string;
  height?: number;
};

function fmt(n: number): string {
  return n.toLocaleString("en-EG", { maximumFractionDigits: 0 });
}

export function AnalyticsTrendChart({ data, layers, xAxisKey, height }: Props) {
  return (
    <MultiLayerChart
      data={data}
      layers={layers}
      xAxisKey={xAxisKey}
      height={height}
      yAxisFormatter={(v) => fmt(Number(v))}
    />
  );
}
