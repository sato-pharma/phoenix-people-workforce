import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function Loading() {
  return (
    <AppRouteLoadingState
      description="Preparing sales dashboards, imports, and performance views."
      title="Loading sales workspace"
    />
  );
}
