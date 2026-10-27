import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function Employee360Loading() {
  return (
    <AppRouteLoadingState
      description="Gathering every field-force employee you can see, by line, area and manager."
      title="Loading Employee 360"
    />
  );
}
