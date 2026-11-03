"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { endPageView, flushActivityQueue, resumePageView, startPageView } from "@/lib/activity/page-view-queue";

/**
 * Records lightweight page-view + dwell-time events for the Activity Control
 * Center. Mounted once inside RouteTransitionProvider, so it runs only inside the
 * authenticated admin shell and employee portal — never on the login screen.
 *
 * It sends only the path + how long the page was foregrounded. The server derives
 * who/which session from the session cookie. No keystrokes, form values, or page
 * contents are ever captured. Timing pauses while the tab is hidden so background
 * tabs don't count as "active" work. The queue itself lives in page-view-queue.ts.
 */
export function ActivityTracker() {
  const pathname = usePathname();

  // One effect per page: start timing on entry, flush the dwell on exit (route
  // change or unmount). The cleanup runs before the next pathname effect.
  useEffect(() => {
    startPageView(pathname);
    return endPageView;
  }, [pathname]);

  // Catch tab-close / backgrounding, which don't trigger a route change. Timing
  // pauses while hidden and resumes when the user returns to the same page. Both
  // send whatever is queued at once: a hidden tab may never get its 30-second tick.
  useEffect(() => {
    function flush() {
      endPageView();
      flushActivityQueue();
    }
    function onVisibility() {
      if (document.visibilityState === "hidden") {
        flush();
      } else {
        resumePageView();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  return null;
}
