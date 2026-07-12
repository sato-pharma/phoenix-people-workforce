"use client";

// Thin dynamic-import wrapper: keeps recharts (and the rest of this heavy dashboard)
// out of the initial bundle for the portal team-expenses page. The real
// implementation lives in nsm-team-expenses-dashboard-impl.tsx and is only fetched
// once this component actually mounts.
import dynamic from "next/dynamic";

export const NsmTeamExpensesDashboard = dynamic(
  () => import("./nsm-team-expenses-dashboard-impl").then((mod) => mod.NsmTeamExpensesDashboard),
  { ssr: false },
);
