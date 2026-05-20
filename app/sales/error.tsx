"use client";

import { RouteErrorState } from "@/components/ui/route-error-state";

export default function SalesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteErrorState
      description="Sales performance data could not render the requested queue or dashboard state. Retry keeps the current sales route scoped."
      error={error}
      eyebrow="Sales Error"
      reset={reset}
      title="Sales workspace unavailable"
    />
  );
}
