"use client";

// Thin dynamic-import wrapper: keeps recharts out of the first bundle. The real dashboard is
// customer-count-dashboard-impl.tsx, fetched once this mounts.
import dynamic from "next/dynamic";

export const CustomerCountDashboard = dynamic(
  () => import("./customer-count-dashboard-impl").then((mod) => mod.CustomerCountDashboard),
  { ssr: false },
);
