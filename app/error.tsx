"use client";

import { useEffect } from "react";
import { RouteErrorState } from "@/components/ui/route-error-state";
import { systemUiText } from "@/config/system-settings";
import { isStaleDeployChunkError, recoverFromStaleDeployOnce } from "@/lib/utils/stale-deploy-recovery";

export default function Error({
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
    <main className="min-h-screen bg-bg-soft p-4 sm:p-6 lg:p-8">
      <RouteErrorState
        description={systemUiText.routeErrorDescription}
        error={error}
        eyebrow="Application Error"
        reset={reset}
        title="This workspace view stopped unexpectedly"
      />
    </main>
  );
}
