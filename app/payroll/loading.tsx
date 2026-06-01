import { AppShellLoading } from "@/components/layout/app-shell-loading";
import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function Loading() {
  return (
    <AppShellLoading navigationMode="admin">
      <AppRouteLoadingState
        description="Preparing payroll data, workflow state, and payslip controls."
        title="Loading payroll intelligence"
      />
    </AppShellLoading>
  );
}
