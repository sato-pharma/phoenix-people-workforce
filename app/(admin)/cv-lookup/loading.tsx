import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function CvLookupLoading() {
  return (
    <AppRouteLoadingState
      description="Opening the CV search. Nothing is listed until you search for somebody."
      title="Loading CV Lookup"
    />
  );
}
