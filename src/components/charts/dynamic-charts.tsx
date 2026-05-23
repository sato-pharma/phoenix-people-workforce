"use client";

import dynamic from "next/dynamic";

import { LoadingSpinner } from "@/components/ui/loading-state";

function ChartSkeleton() {
  return (
    <div className="flex h-full min-h-[200px] w-full items-center justify-center">
      <LoadingSpinner />
    </div>
  );
}

// Recharts is ~500 KB minified. Lazy-loading it keeps the initial JS bundle
// smaller for pages that don't need charts (login, employee list, etc.).
export const DynamicCoachingAnalyticsDashboard = dynamic(
  () =>
    import("@/components/coaching/coaching-analytics-dashboard").then(
      (m) => m.CoachingAnalyticsDashboard,
    ),
  { loading: ChartSkeleton, ssr: false },
);

export const DynamicSalesPerformancePage = dynamic(
  () =>
    import("@/components/sales/sales-performance-page").then(
      (m) => m.SalesPerformancePage,
    ),
  { loading: ChartSkeleton, ssr: false },
);

export const DynamicNsmTeamExpensesDashboard = dynamic(
  () =>
    import("@/components/employee-portal/nsm-team-expenses-dashboard").then(
      (m) => m.NsmTeamExpensesDashboard,
    ),
  { loading: ChartSkeleton, ssr: false },
);

export const DynamicPersonalExpenseWorkloadDashboard = dynamic(
  () =>
    import(
      "@/components/employee-portal/personal-expense-workload-dashboard"
    ).then((m) => m.PersonalExpenseWorkloadDashboard),
  { loading: ChartSkeleton, ssr: false },
);

export const DynamicTeamPerformanceChart = dynamic(
  () =>
    import(
      "@/app/employee-portals/team-performance/team-performance-chart.client"
    ),
  { loading: ChartSkeleton, ssr: false },
);

export const DynamicTeamMembersBreakdown = dynamic(
  () =>
    import(
      "@/app/employee-portals/team-performance/team-members-breakdown.client"
    ).then((m) => m.TeamMembersBreakdown),
  { loading: ChartSkeleton, ssr: false },
);
