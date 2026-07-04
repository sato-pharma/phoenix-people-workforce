"use client";

// Thin dynamic-import wrapper: keeps recharts out of the initial bundle for every
// page that imports ExpenseTrendChart. The real implementation lives in
// expense-trend-chart-impl.tsx and is only fetched once this component actually
// mounts.
import dynamic from "next/dynamic";

export const ExpenseTrendChart = dynamic(
  () => import("./expense-trend-chart-impl").then((mod) => mod.ExpenseTrendChart),
  { ssr: false },
);
