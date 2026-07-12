"use client";

// Thin dynamic-import wrapper: keeps recharts (and the rest of this heavy dashboard)
// out of the initial bundle for the admin monthly-dashboard page. The real
// implementation lives in monthly-sales-dashboard-impl.tsx and is only fetched once
// this component actually mounts.
import dynamic from "next/dynamic";

export const MonthlySalesDashboard = dynamic(
  () => import("./monthly-sales-dashboard-impl").then((mod) => mod.MonthlySalesDashboard),
  { ssr: false },
);
