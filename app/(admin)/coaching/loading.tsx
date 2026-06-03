import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function CoachingLoading() {
  return (
    <AppRouteLoadingState
      description="Preparing coaching reports, scorecards, and analytics."
      title="Loading coaching workspace"
    />
  );
}
