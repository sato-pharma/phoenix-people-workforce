"use client";

// Thin dynamic-import wrapper: keeps recharts out of the initial bundle for every
// page that imports StackedChart. The real implementation lives in
// stacked-chart-impl.tsx and is only fetched once this component actually mounts.
import dynamic from "next/dynamic";

export const StackedChart = dynamic(
  () => import("./stacked-chart-impl").then((mod) => mod.StackedChart),
  { ssr: false },
);
