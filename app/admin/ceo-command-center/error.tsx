"use client";

import { RouteErrorState } from "@/components/ui/route-error-state";

export default function CeoCommandCenterError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteErrorState
      description="The executive command center could not render company intelligence. Retry keeps you in the admin context without discarding navigation state."
      error={error}
      eyebrow="Executive Command Center"
      reset={reset}
      title="Command center unavailable"
    />
  );
}
