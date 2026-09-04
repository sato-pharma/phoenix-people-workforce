"use client";

import { useCallback, useEffect, useState } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";

import {
  DEFAULT_DISPLAY_SCALE,
  DISPLAY_SCALE_CSS_VAR,
  DISPLAY_SCALE_OPTIONS,
  DISPLAY_SCALE_STORAGE_KEY,
  formatDisplayScale,
  parseDisplayScale,
  type DisplayScale,
} from "@/lib/ui/display-scale";

/**
 * Zoom out / zoom in, on the navigation bar of every shell.
 *
 * The owner asked for two things: the system should OPEN already scaled down (that is the boot
 * script in app/layout.tsx, defaulting to 80%), and every account type — admin and portal — should
 * carry a visible zoom control. This is the second half. It sits on the nav bar rather than inside
 * the profile dropdown because he asked for it there, and because a control nobody can find is the
 * same as no control: the first version of this change buried it in the account menu and he could
 * not see any difference.
 *
 * WHY IT STEPS THROUGH A LIST rather than adding or subtracting a percentage. Free-form zoom lands
 * on values like 0.83 that make every border land on a half pixel and read as blurred text. The
 * five steps are the browser's own zoom stops across the range he named, so a reader who knows what
 * Ctrl+minus does recognises the numbers, and every step renders crisply.
 *
 * HIDDEN BELOW lg, and that is correctness rather than tidiness. The zoom itself is gated to
 * `screen and (min-width: 1024px)` in globals.css — on a phone, scaling down collides with the 16px
 * form-control floor that exists to stop iOS Safari zooming in and staying there, and it would
 * fight the owner's own "mobile gets cards, not tables" rule. A button that visibly does nothing is
 * worse than an absent one.
 */
export function DisplayScaleControl({ isAdminMode }: { isAdminMode: boolean }) {
  // Starts at the default on BOTH server and first client render, so there is no hydration
  // mismatch. The real stored value is read in the effect below. The visible zoom is already
  // correct before this component exists — the boot script set it — so the only thing the effect
  // corrects is the number printed on the button.
  const [scale, setScale] = useState<DisplayScale>(DEFAULT_DISPLAY_SCALE);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setScale(parseDisplayScale(window.localStorage.getItem(DISPLAY_SCALE_STORAGE_KEY)));
    } catch {
      // Private-mode localStorage throws on read. The default is already in state and already
      // painted; there is nothing to correct and nothing worth reporting.
    }
  }, []);

  const applyScale = useCallback((next: DisplayScale) => {
    setScale(next);
    document.documentElement.style.setProperty(DISPLAY_SCALE_CSS_VAR, String(next));
    try {
      window.localStorage.setItem(DISPLAY_SCALE_STORAGE_KEY, String(next));
    } catch {
      // Storage refused, so the choice lasts for this tab only. Applying it is the part that
      // matters; failing to persist is not worth interrupting the reader over.
    }
  }, []);

  const index = DISPLAY_SCALE_OPTIONS.indexOf(scale);
  // The list runs largest to smallest, so zooming IN walks toward index 0.
  const canZoomIn = index > 0;
  const canZoomOut = index >= 0 && index < DISPLAY_SCALE_OPTIONS.length - 1;

  const buttonClass = `inline-flex h-7 w-7 items-center justify-center rounded transition disabled:cursor-default disabled:opacity-35 ${
    isAdminMode
      ? "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]"
      : "text-slate-500 hover:bg-orange-50 hover:text-orange-700"
  }`;

  return (
    <div
      className={`hidden shrink-0 items-center gap-0.5 rounded border px-1 py-0.5 lg:flex ${
        isAdminMode ? "border-[#333333] bg-[#0B0B0B]" : "border-slate-200 bg-white"
      }`}
      // A screen-reader user is not helped by a zoom stepper announcing itself three times; the
      // group carries the name and the buttons carry the actions.
      role="group"
      aria-label="Display zoom"
    >
      <button
        aria-label="Zoom out"
        className={buttonClass}
        disabled={!canZoomOut}
        onClick={() => {
          if (canZoomOut) applyScale(DISPLAY_SCALE_OPTIONS[index + 1]);
        }}
        title="Zoom out — fit more on screen"
        type="button"
      >
        <ZoomOut className="h-3.5 w-3.5" />
      </button>
      {/* Tabular figures and a fixed width: without them the row reflows by a pixel or two as the
          label steps 100% -> 90% -> 85%, and the two buttons visibly twitch under the pointer. */}
      <span
        aria-live="polite"
        className={`w-[34px] text-center font-mono text-phx-2xs font-bold tabular-nums ${
          isAdminMode ? "text-[#F8B56B]" : "text-slate-600"
        }`}
      >
        {formatDisplayScale(scale)}
      </span>
      <button
        aria-label="Zoom in"
        className={buttonClass}
        disabled={!canZoomIn}
        onClick={() => {
          if (canZoomIn) applyScale(DISPLAY_SCALE_OPTIONS[index - 1]);
        }}
        title="Zoom in — make everything larger"
        type="button"
      >
        <ZoomIn className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
