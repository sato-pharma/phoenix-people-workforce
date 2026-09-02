"use client";

import { useEffect } from "react";

import { subscribeToViewportChange } from "@/lib/navigation/panel-position";

/**
 * Re-places an OPEN panel when the viewport changes size underneath it.
 *
 * The three topbar panels — the notifications bell, the messages menu and the nav row's "+" — each
 * measure their anchor in the click handler, which is correct at the moment of opening and stale
 * from then on. Rotating a phone while one is open leaves it wearing the placement it was given for
 * the old viewport, off the edge of the new one. `subscribeToViewportChange` carries the account.
 *
 * Nothing is registered while the panel is shut, so the cost is zero for the case that is almost
 * always true. `reposition` is invoked from the event callback rather than the effect body, so the
 * repo's no-`setState`-inside-`useEffect` rule is respected — the same shape as
 * `useDismissOnOutsideInteraction`, which this sits beside in every caller.
 *
 * Pass a `reposition` wrapped in `useCallback`, or the listener re-subscribes on every render.
 */
export function useRepositionOnViewportChange(open: boolean, reposition: () => void) {
  useEffect(() => {
    if (!open) return;

    return subscribeToViewportChange(window, reposition);
  }, [open, reposition]);
}
