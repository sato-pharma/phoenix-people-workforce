import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function Loading() {
  return (
    <AppRouteLoadingState
      description="Aggregating company-wide Source of Sales and comparison periods."
      title="Loading Sales Command"
    />
  );
}
