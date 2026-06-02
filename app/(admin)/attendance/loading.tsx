import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function AttendanceLoading() {
  return (
    <AppRouteLoadingState
      description="Preparing attendance reports, device mappings, and policy controls."
      title="Loading attendance workspace"
    />
  );
}
