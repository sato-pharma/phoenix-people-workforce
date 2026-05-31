import { DashboardSkeleton } from "@/components/employee-portal/skeleton-templates";

export default function IncentiveLoading() {
  return <DashboardSkeleton kpiCount={4} chartCount={2} />;
}
