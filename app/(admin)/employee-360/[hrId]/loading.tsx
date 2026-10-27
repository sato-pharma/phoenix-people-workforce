import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function Employee360ReportLoading() {
  return (
    <AppRouteLoadingState
      description="Reading this person's sales, field visits, coaching, expenses and HR record for the chosen period."
      title="Loading the Employee 360 report"
    />
  );
}
