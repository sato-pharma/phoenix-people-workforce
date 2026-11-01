"use client";

import { useEffect } from "react";

/**
 * The Phoenix CRM touch trail was retired on 1 November 2026 (owner: "retire and delete all its
 * traces"). Its collector queued unsent batches on the phone under this key; this clears them once,
 * so no browser keeps a copy of taps nothing will ever read. Renders nothing, changes nothing else.
 *
 * ONE RELEASE ONLY: delete this file and the two `field-crm/layout.tsx` files that mount it in the
 * release after this one is live.
 */
const RETIRED_TRAIL_QUEUE_KEY = "phx-crm-touch-trail";

export function RetiredTouchTrailCleanup(): null {
  useEffect(() => {
    try {
      window.localStorage.removeItem(RETIRED_TRAIL_QUEUE_KEY);
    } catch {
      // Storage may be unavailable (a private window, a blocked origin); there is then nothing to clear.
    }
  }, []);
  return null;
}
