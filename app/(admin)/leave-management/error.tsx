"use client";

import { useEffect } from "react";
import { RouteErrorState } from "@/components/ui/route-error-state";
import { isStaleDeployChunkError, recoverFromStaleDeployOnce } from "@/lib/utils/stale-deploy-recovery";

export default function LeaveManagementError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (isStaleDeployChunkError(error)) {
      recoverFromStaleDeployOnce();
    }
  }, [error]);

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
