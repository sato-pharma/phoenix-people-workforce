import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function OrganogramLoading() {
  return (
    <AppRouteLoadingState
      description="Preparing hierarchy, reporting lines, and workforce structure."
      title="Loading organogram"
    />
  );
}
