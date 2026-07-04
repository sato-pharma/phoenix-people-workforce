"use client";

// Thin dynamic-import wrapper: keeps recharts (and the rest of this heavy dashboard)
// out of the initial bundle for /sales/weekly/dashboard. The real implementation
// lives in weekly-dashboard-view-impl.tsx and is only fetched once this component
// actually mounts.
import dynamic from "next/dynamic";

export const WeeklyDashboardView = dynamic(
  () => import("./weekly-dashboard-view-impl").then((mod) => mod.WeeklyDashboardView),
  { ssr: false },
);
