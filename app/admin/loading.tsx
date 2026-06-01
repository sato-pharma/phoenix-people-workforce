import { AppShellLoading } from "@/components/layout/app-shell-loading";
import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function AdminLoading() {
  return (
    <AppShellLoading navigationMode="admin">
      <AppRouteLoadingState
        description="Keeping the admin shell available while the requested module prepares."
        title="Loading admin workspace"
      />
    </AppShellLoading>
  );
}
