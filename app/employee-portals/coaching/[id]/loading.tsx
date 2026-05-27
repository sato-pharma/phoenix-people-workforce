import { DashboardSkeleton } from "@/components/employee-portal/skeleton-templates";

export default function CoachingDetailLoading() {
  return <DashboardSkeleton kpiCount={3} chartCount={1} />;
}
