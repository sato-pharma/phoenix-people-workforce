import { AppShellLoading } from "@/components/layout/app-shell-loading";
import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function AttendanceLoading() {
  return (
    <AppShellLoading navigationMode="admin">
      <AppRouteLoadingState
        description="Preparing attendance reports, device mappings, and policy controls."
        title="Loading attendance workspace"
      />
    </AppShellLoading>
  );
}
