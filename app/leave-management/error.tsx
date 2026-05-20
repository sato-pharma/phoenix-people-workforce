"use client";

import { RouteErrorState } from "@/components/ui/route-error-state";

export default function LeaveManagementError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteErrorState
      description="Leave management uses the vacation source of truth for requests, decisions, balances, and reporting. Retry the view without changing the current approval context."
      error={error}
      eyebrow="Leave Error"
      reset={reset}
      title="Leave management unavailable"
    />
  );
}
