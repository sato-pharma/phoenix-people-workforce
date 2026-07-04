"use client";

// Thin dynamic-import wrapper: keeps recharts out of the initial bundle for every
// page that imports WaterfallChart. The real implementation lives in
// waterfall-chart-impl.tsx and is only fetched once this component actually mounts.
import dynamic from "next/dynamic";

export const WaterfallChart = dynamic(
  () => import("./waterfall-chart-impl").then((mod) => mod.WaterfallChart),
  { ssr: false },
);
