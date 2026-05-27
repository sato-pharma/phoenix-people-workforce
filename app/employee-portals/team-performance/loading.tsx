import { DashboardSkeleton } from "@/components/employee-portal/skeleton-templates";

export default function TeamPerformanceLoading() {
  return <DashboardSkeleton kpiCount={4} chartCount={2} />;
}
