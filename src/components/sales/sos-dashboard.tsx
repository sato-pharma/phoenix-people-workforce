"use client";

// Thin dynamic-import wrapper: keeps recharts (and the rest of this heavy dashboard)
// out of the initial bundle for /sales. The real implementation lives in
// sos-dashboard-impl.tsx and is only fetched once this component actually mounts.
import dynamic from "next/dynamic";

export const SosDashboard = dynamic(
  () => import("./sos-dashboard-impl").then((mod) => mod.SosDashboard),
  { ssr: false },
);
