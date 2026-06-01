import { AppShellLoading } from "@/components/layout/app-shell-loading";
import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function Loading() {
  return (
    <AppShellLoading navigationMode="admin">
      <AppRouteLoadingState
        description="Preparing sales dashboards, imports, and performance views."
        title="Loading sales workspace"
      />
    </AppShellLoading>
  );
}
