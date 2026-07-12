"use client";

// Thin dynamic-import wrapper: keeps recharts (and the rest of this heavy dashboard)
// out of the initial bundle for the admin SMI page + portal ROI page. The real
// implementation lives in sales-marketing-intelligence-dashboard-impl.tsx and is only
// fetched once this component actually mounts.
import dynamic from "next/dynamic";

export const SalesMarketingIntelligenceDashboard = dynamic(
  () => import("./sales-marketing-intelligence-dashboard-impl").then((mod) => mod.SalesMarketingIntelligenceDashboard),
  { ssr: false },
);
