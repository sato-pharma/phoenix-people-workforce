import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function Loading() {
  return (
    <AppRouteLoadingState
      description="Preparing payroll data, workflow state, and payslip controls."
      title="Loading payroll intelligence"
    />
  );
}
