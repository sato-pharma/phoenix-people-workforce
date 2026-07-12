"use client";

// Thin dynamic-import wrapper: keeps recharts out of the initial bundle for the
// portal training-manager landing page. The real implementation lives in
// coaching-quality-radar-card-impl.tsx and is only fetched once this component
// actually mounts.
import dynamic from "next/dynamic";

export const CoachingQualityRadarCard = dynamic(
  () => import("./coaching-quality-radar-card-impl").then((mod) => mod.CoachingQualityRadarCard),
  { ssr: false },
);
