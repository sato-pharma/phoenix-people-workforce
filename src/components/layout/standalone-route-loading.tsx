import { LoadingWatchdog } from "@/components/layout/loading-watchdog";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { systemUiText } from "@/config/system-settings";

/**
 * Full-screen brand fallback for the handful of routes that sit outside the admin shell
 * and the employee portal — they have no shell chrome to render a skeleton into.
 *
 * This used to be `app/loading.tsx`, which put a Suspense boundary above EVERY route,
 * including `/login`. A boundary means the page is streamed and then revealed by React's
 * client runtime, so the sign-in form could not be visible until JS had run. `/login` is
 * now deliberately the one content route with no loading boundary at all, so its form is
 * part of the server-rendered shell and usable with zero JS. Anything that needs this
 * fallback opts in with its own `loading.tsx` rather than inheriting it from the root.
 *
 * /login therefore has no watchdog either, and does not need one — a watchdog exists to
 * rescue a fallback that never resolves, and /login no longer renders a fallback at all.
 */
export function StandaloneRouteLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f6f7fb]">
      <div className="flex flex-col items-center gap-4">
        <LoadingSpinner className="h-10 w-10 text-orange-500" />
        <p className="text-sm font-medium text-slate-500 animate-pulse">
          {systemUiText.loadingMessage}
        </p>
        {/* This fallback is what a stalled client bundle leaves on screen — never let it be an
            endless spinner with no way out. */}
        <LoadingWatchdog />
      </div>
    </div>
  );
}
