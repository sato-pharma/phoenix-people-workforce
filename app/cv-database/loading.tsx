import { AppShellLoading } from "@/components/layout/app-shell-loading";
import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function CvDatabaseLoading() {
  return (
    <AppShellLoading navigationMode="admin">
      <AppRouteLoadingState
        description="Preparing CV records, candidate filters, and import controls."
        title="Loading CV database"
      />
    </AppShellLoading>
  );
}
