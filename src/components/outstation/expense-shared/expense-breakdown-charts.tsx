"use client";

// Thin dynamic-import wrapper: keeps recharts out of the initial bundle for every
// page that imports ExpenseBreakdownCharts. The real implementation lives in
// expense-breakdown-charts-impl.tsx and is only fetched once this component
// actually mounts.
import dynamic from "next/dynamic";

export const ExpenseBreakdownCharts = dynamic(
  () => import("./expense-breakdown-charts-impl").then((mod) => mod.ExpenseBreakdownCharts),
  { ssr: false },
);
