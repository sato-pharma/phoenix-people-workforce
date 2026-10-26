"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { RouteErrorState } from "@/components/ui/route-error-state";
import { isSessionVerificationUnavailableDigest } from "@/lib/auth/session-unavailable-digest";
import { isStaleDeployChunkError, recoverFromStaleDeployOnce } from "@/lib/utils/stale-deploy-recovery";

// A server-render failure (it carries a `digest`) is almost always a brief database blip — the
// session check or a page read timing out (PHOENIX-WORKFORCE-9). Re-render ONCE per digest after a
// short pause before showing the error card; a second failure with the same digest shows the card.
const SERVER_RENDER_RETRY_DELAY_MS = 3000;
const retriedDigests = new Set<string>();

export default function EmployeePortalsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    if (isStaleDeployChunkError(error)) {
      recoverFromStaleDeployOnce();
      return;
    }

    // A sign-in check the database could not answer has its own retry schedule in RouteErrorState.
    if (isSessionVerificationUnavailableDigest(error)) return;

    const digest = error.digest;
    if (!digest || retriedDigests.has(digest)) return;
    retriedDigests.add(digest);

    const timer = window.setTimeout(() => {
      router.refresh();
      reset();
    }, SERVER_RENDER_RETRY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [error, reset, router]);

  return (
    <RouteErrorState
      description="The employee portal could not render the latest self-service data. Retry keeps the current portal session active."
      error={error}
      eyebrow="Portal Error"
      reset={reset}
      title="Employee portal unavailable"
    />
  );
}
