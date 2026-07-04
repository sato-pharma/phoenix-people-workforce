"use client";

// Thin dynamic-import wrapper: keeps recharts out of the initial bundle for every
// page that imports SafeResponsiveContainer. The real implementation lives in
// safe-responsive-container-impl.tsx and is only fetched once this component
// actually mounts.
import dynamic from "next/dynamic";

export const SafeResponsiveContainer = dynamic(
  () => import("./safe-responsive-container-impl").then((mod) => mod.SafeResponsiveContainer),
  { ssr: false },
);
