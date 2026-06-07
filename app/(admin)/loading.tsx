import { AppRouteLoadingState } from "@/components/ui/loading-state";

// Baseline loading skeleton for the admin surface. Renders inside AppShell while
// any admin page's server render / data fetch is in flight, so heavy
// force-dynamic pages no longer show a blank frozen screen on slow connections.
// Pages with their own loading.tsx (or inline <Suspense>) override this baseline.
export default function AdminGroupLoading() {
  return (
    <AppRouteLoadingState
      description="Preparing the next Phoenix Workforce view."
      title="Loading workspace"
    />
  );
}
