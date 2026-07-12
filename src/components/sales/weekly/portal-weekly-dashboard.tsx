"use client";

// Thin dynamic-import wrapper: keeps recharts (and the rest of this heavy dashboard)
// out of the initial bundle for the admin + portal weekly-sales pages. The real
// implementation lives in portal-weekly-dashboard-impl.tsx and is only fetched once
// this component actually mounts.
import dynamic from "next/dynamic";

export const PortalWeeklyDashboard = dynamic(
  () => import("./portal-weekly-dashboard-impl").then((mod) => mod.PortalWeeklyDashboard),
  { ssr: false },
);
