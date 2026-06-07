"use client";

import { RouteErrorState } from "@/components/ui/route-error-state";

export default function SalesCommandError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteErrorState
      description="The Sales Command dashboard stopped unexpectedly. Retry to reload just this page, or use the sidebar to move elsewhere."
      error={error}
      eyebrow="Sales Command"
      reset={reset}
      title="This dashboard stopped unexpectedly"
    />
  );
}
