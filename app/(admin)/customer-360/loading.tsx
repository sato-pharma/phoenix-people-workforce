import { AppRouteLoadingState } from "@/components/ui/loading-state";

export default function Customer360Loading() {
  return (
    <AppRouteLoadingState
      description="Linking every validated doctor and account to its visits, pharmacies, marketing money and sales."
      title="Loading Customer 360"
    />
  );
}
