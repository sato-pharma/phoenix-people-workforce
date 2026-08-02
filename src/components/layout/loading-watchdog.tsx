"use client";

import { useEffect, useState } from "react";

/**
 * Escalates a route-level loading fallback that never resolves into something the user can act on.
 *
 * The root fallback is shown while client JS is still booting, so a chunk that is merely slow —
 * or one that never arrives at all on a weak mobile connection — presented as an endless
 * "Loading Phoenix Workforce..." spinner with no error, no timeout and no way out. Field staff
 * reported it as "the app is stuck"; there was nothing on screen to suggest a reload would help.
 *
 * This is deliberately a plain <a>, not a router link: the whole point is that the router may be
 * exactly what failed to load, so recovery must not depend on it.
 */
const STALLED_AFTER_MS = 12_000;

export function LoadingWatchdog({ stalledAfterMs = STALLED_AFTER_MS }: { stalledAfterMs?: number }) {
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setStalled(true), stalledAfterMs);
    return () => window.clearTimeout(timer);
  }, [stalledAfterMs]);

  if (!stalled) return null;

  return (
    <div className="flex flex-col items-center gap-3 px-6 text-center">
      <p className="text-sm font-medium text-slate-600">
        This is taking longer than usual. Your connection may have dropped.
      </p>
      {/* eslint-disable @next/next/no-html-link-for-pages -- These MUST be hard navigations.
          This component only renders when a route has already failed to resolve, so the router
          and its RSC pipeline are the prime suspects; <Link> would route the user's escape hatch
          straight back through the thing that is stuck. A full document load is the recovery —
          it throws away all broken client state and re-requests from the server. */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <a
          className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-600"
          href="/"
        >
          Try again
        </a>
        <a
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          href="/login"
        >
          Go to sign in
        </a>
      </div>
      {/* eslint-enable @next/next/no-html-link-for-pages */}
    </div>
  );
}
