import { AppShellLoading } from "@/components/layout/app-shell-loading";
import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function OrganogramLoading() {
  return (
    <AppShellLoading navigationMode="admin">
      <AppRouteLoadingState
        description="Preparing hierarchy, reporting lines, and workforce structure."
        title="Loading organogram"
      />
    </AppShellLoading>
  );
}
