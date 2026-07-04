"use client";

// Thin dynamic-import wrapper: keeps recharts out of the initial bundle for every
// page that imports KPIBulletCard. The real implementation lives in
// kpi-bullet-card-impl.tsx and is only fetched once this component actually mounts.
import dynamic from "next/dynamic";

export const KPIBulletCard = dynamic(
  () => import("./kpi-bullet-card-impl").then((mod) => mod.KPIBulletCard),
  { ssr: false },
);
