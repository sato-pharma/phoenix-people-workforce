"use client";

// Thin dynamic-import wrapper: keeps recharts (pulled in transitively via
// src/components/charts/radar-chart.tsx) out of the initial bundle for the portal
// coaching detail page. The real implementation lives in
// employee-coaching-review-impl.tsx and is only fetched once this component
// actually mounts.
import dynamic from "next/dynamic";

export const EmployeeCoachingReview = dynamic(
  () => import("./employee-coaching-review-impl").then((mod) => mod.EmployeeCoachingReview),
  { ssr: false },
);
