import { AppShellLoading } from "@/components/layout/app-shell-loading";
import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function HiringDocumentsLoading() {
  return (
    <AppShellLoading navigationMode="admin">
      <AppRouteLoadingState
        description="Preparing document definitions, employee coverage, and compliance status."
        title="Loading hiring documents"
      />
    </AppShellLoading>
  );
}
