"use client";

import { useEffect, useRef, useState } from "react";

import {
  isNewerDeploy,
  readRevision,
  REVISION_POLL_MS,
  shouldCheckOnFocus,
} from "@/lib/utils/deploy-revision-watch";

/**
 * Tells a tab that is running an older deploy to refresh — it never reloads by itself, because a
 * reload would throw away a half-filled form. See src/lib/utils/deploy-revision-watch.ts for why.
 *
 * `loadedRevision` is stamped into the HTML by the root layout, so it is the build that served THIS
 * page load and survives soft navigations (a layout is not re-rendered by them). Polls the public
 * /api/healthz, which does no dependency work and is built to be polled.
 *
 * Once a newer deploy is seen the prompt latches: a rolling deploy can answer from an old instance
 * a moment later, and a banner that blinked away would be worse than none. "Later" hides it until
 * the NEXT deploy, not for the rest of the tab's life.
 */
export function StaleDeployPrompt({ loadedRevision }: { loadedRevision: string | null }) {
  const [seenRevision, setSeenRevision] = useState<string | null>(null);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const lastCheckAt = useRef<number | null>(null);

  useEffect(() => {
    // No known build for this tab (local dev) means there is nothing to compare against.
    if (!loadedRevision) return;
    let cancelled = false;

    async function check() {
      lastCheckAt.current = Date.now();
      try {
        const response = await fetch("/api/healthz", { cache: "no-store" });
        if (!response.ok) return;
        const live = readRevision(await response.json());
        if (!cancelled && isNewerDeploy(loadedRevision, live)) setSeenRevision(live);
      } catch {
        // Offline or mid-deploy: say nothing and try again at the next tick.
      }
    }

    function onVisible() {
      if (document.visibilityState !== "visible") return;
      if (shouldCheckOnFocus(lastCheckAt.current, Date.now())) void check();
    }

    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, REVISION_POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [loadedRevision]);

  if (!seenRevision || dismissedFor === seenRevision) return null;

  return (
    <div
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-[100] flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      role="status"
    >
      <div className="flex w-full max-w-xl flex-wrap items-center gap-x-4 gap-y-2 border border-slate-300 bg-white px-4 py-3 shadow-lg">
        <p className="min-w-0 flex-1 basis-56 text-sm font-medium text-slate-800">
          A new version of Phoenix is available. Refresh to get the latest menu and screens.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            className="bg-orange-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-600"
            onClick={() => window.location.reload()}
            type="button"
          >
            Refresh
          </button>
          <button
            className="border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            onClick={() => setDismissedFor(seenRevision)}
            type="button"
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
}
