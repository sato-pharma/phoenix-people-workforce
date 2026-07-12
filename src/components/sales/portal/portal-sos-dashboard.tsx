"use client";

// Thin dynamic-import wrapper: keeps recharts (and the rest of this heavy dashboard)
// out of the initial bundle for the admin + portal Source-of-Sales pages. The real
// implementation lives in portal-sos-dashboard-impl.tsx and is only fetched once this
// component actually mounts.
import dynamic from "next/dynamic";

export const PortalSosDashboard = dynamic(
  () => import("./portal-sos-dashboard-impl").then((mod) => mod.PortalSosDashboard),
  { ssr: false },
);
