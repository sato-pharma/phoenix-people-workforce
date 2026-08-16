import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function Loading() {
  return (
    <AppRouteLoadingState
      title="Loading Recruitment"
      description="Getting the open positions, the people, and where each one stands."
    />
  );
}
