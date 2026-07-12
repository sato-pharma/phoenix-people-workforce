"use client";

// Thin dynamic-import wrapper: keeps recharts out of the initial bundle for the 4
// admin analytics pages that render this chart. The real implementation lives in
// analytics-trend-chart-impl.tsx and is only fetched once this component actually
// mounts.
import dynamic from "next/dynamic";

export const AnalyticsTrendChart = dynamic(
  () => import("./analytics-trend-chart-impl").then((mod) => mod.AnalyticsTrendChart),
  { ssr: false },
);
