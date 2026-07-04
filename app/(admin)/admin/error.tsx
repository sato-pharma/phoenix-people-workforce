"use client";

import { useEffect } from "react";
import { RouteErrorState } from "@/components/ui/route-error-state";
import { isStaleDeployChunkError, recoverFromStaleDeployOnce } from "@/lib/utils/stale-deploy-recovery";

export default function AdminError({
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
      description="The admin workspace could not render the requested operational data. Retry keeps you in the admin context without discarding navigation state."
      error={error}
      eyebrow="Admin Error"
      reset={reset}
      title="Admin workspace unavailable"
    />
  );
}
