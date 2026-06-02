import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function CeoCommandCenterLoading() {
  return (
    <AppRouteLoadingState
      description="Preparing the executive command center — aggregating health, risk, and operating signals."
      title="Loading command center"
    />
  );
}
