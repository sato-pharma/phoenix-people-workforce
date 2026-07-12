"use client";

// Thin dynamic-import wrapper: keeps recharts (and the rest of this heavy list view)
// out of the initial bundle for the portal coaching landing page. The real
// implementation lives in employee-coaching-list-impl.tsx and is only fetched once
// this component actually mounts.
import dynamic from "next/dynamic";

export const EmployeeCoachingList = dynamic(
  () => import("./employee-coaching-list-impl").then((mod) => mod.EmployeeCoachingList),
  { ssr: false },
);
