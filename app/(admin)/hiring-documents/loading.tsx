import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function HiringDocumentsLoading() {
  return (
    <AppRouteLoadingState
      description="Preparing document definitions, employee coverage, and compliance status."
      title="Loading hiring documents"
    />
  );
}
