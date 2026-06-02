import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function AdminLoading() {
  return (
    <AppRouteLoadingState
      description="Keeping the admin shell available while the requested module prepares."
      title="Loading admin workspace"
    />
  );
}
