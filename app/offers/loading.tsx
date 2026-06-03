import { AppShellLoading } from "@/components/layout/app-shell-loading";
import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function OffersLoading() {
  return (
    <AppShellLoading navigationMode="admin">
      <AppRouteLoadingState
        description="Preparing offer lifecycle records, candidate actions, and vacancy linkage."
        title="Loading offer lifecycle"
      />
    </AppShellLoading>
  );
}
