"use client";

// Thin dynamic-import wrapper: keeps recharts (used by the pharmacy trend sparkline, on both
// the desktop and mobile renderers) out of the initial bundle, matching the same pattern
// portal-sos-dashboard.tsx already uses for the Source of Sales dashboard.
import dynamic from "next/dynamic";

export const TerritoryTreeExplorer = dynamic(
  () => import("./territory-tree-explorer-impl").then((mod) => mod.TerritoryTreeExplorer),
  { ssr: false },
);
