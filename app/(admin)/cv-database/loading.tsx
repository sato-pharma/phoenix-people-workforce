import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function CvDatabaseLoading() {
  return (
    <AppRouteLoadingState
      description="Preparing CV records, candidate filters, and import controls."
      title="Loading CV database"
    />
  );
}
