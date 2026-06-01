import { AppShellLoading } from "@/components/layout/app-shell-loading";
import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function CoachingLoading() {
  return (
    <AppShellLoading navigationMode="admin">
      <AppRouteLoadingState
        description="Preparing coaching reports, scorecards, and analytics."
        title="Loading coaching workspace"
      />
    </AppShellLoading>
  );
}
