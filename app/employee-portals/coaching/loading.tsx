import { DashboardSkeleton } from "@/components/employee-portal/skeleton-templates";

export default function CoachingLoading() {
  return <DashboardSkeleton kpiCount={4} chartCount={2} />;
}
