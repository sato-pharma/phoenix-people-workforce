"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Two dropdowns that hang off a nav row: the RIGHT-CLICK menu on a tab, and the
// OVERFLOW menu holding the tabs that do not fit.
//
// They live in one file because they are one shape — an anchored panel, a list
// of rows, escape and outside-click to close — and because the alternative is
// two panels on the same bar that drift apart in padding and hover colour. The
// "+" panel in nav-row-add-button.tsx is a third instance of that shape; it is
// deliberately NOT refactored into this file, because its content is a
// searchable, grouped, two-mode list and folding that in would make one
// component with two unrelated jobs.
//
// ── Closing on an outside click ─────────────────────────────────────────────
// A full-screen backdrop button rather than a document listener registered in
// an effect, matching nav-row-add-button.tsx: `setState` inside `useEffect` is
// a lint error in this repo, so the listener form would have to be written
// around the linter for no gain.
// ─────────────────────────────────────────────────────────────────────────────

import { type LucideIcon } from "lucide-react";
import { type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** One row in either menu. `disabled` keeps a move visible but inert rather than hiding it, so the
 *  menu does not change height as a tab moves along the row and the item stays discoverable. */
export type NavMenuItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  /** Rendered right-aligned and muted — the keyboard hint, or a row name. */
  hint?: string;
  onSelect: () => void;
};

/** `w-60`, in px. Exported so a caller placing the panel by hand cannot drift from the class. */
export const NAV_MENU_PANEL_WIDTH = 240;

export function NavMenuPanel({
  align = "left",
  children,
  dark,
  items,
  offsetLeft,
  onClose,
  title,
}: {
  align?: "left" | "right";
  /** Rendered above the items, inside the panel. */
  children?: ReactNode;
  dark: boolean;
  items: readonly NavMenuItem[];
  /**
   * Distance in px from the anchor's left edge, overriding `align`.
   *
   * The right-click menu needs it because it cannot hang off the tab it belongs to: the tabs live
   * inside an `overflow-hidden` container (that is what the overflow menu is FOR), so a panel
   * anchored to a tab would be clipped to a sliver. It is anchored to the row instead and shifted
   * to sit under its tab — measured by the caller, which is the only thing that knows where the
   * tab is.
   */
  offsetLeft?: number;
  onClose: () => void;
  title?: string;
}) {
  const surface = dark
    ? "border-[#241f19] bg-[#0a0908] text-[#D4DDE8] shadow-[0_18px_40px_-12px_rgba(0,0,0,0.9)]"
    : "border-phx-line bg-white text-phx-ink shadow-xl";

  return (
    <>
      <button
        aria-label="Close the menu"
        className="fixed inset-0 z-40 cursor-default"
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <div
        aria-label={title ?? "Tab actions"}
        className={cn(
          // Scrolls vertically only. A long page name must never be truncated with an ellipsis
          // (the owner's standing rule), so the panel is wide enough to hold one and the label
          // itself is left to wrap rather than being cut.
          "absolute top-full z-50 mt-1 max-h-[70vh] w-60 overflow-y-auto rounded-xl border p-1.5",
          offsetLeft === undefined ? (align === "right" ? "right-0" : "left-0") : "left-0",
          surface,
        )}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        role="dialog"
        style={offsetLeft === undefined ? undefined : { marginLeft: offsetLeft }}
      >
        {children}
        {title ? (
          <p
            className={cn(
              "px-2 pb-0.5 pt-1.5 text-[10px] font-bold uppercase tracking-[0.08em]",
              dark ? "text-[#5A6B80]" : "text-phx-ink-soft",
            )}
          >
            {title}
          </p>
        ) : null}
        {items.map((entry) => {
          const Icon = entry.icon;
          return (
            <button
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                dark
                  ? "hover:bg-[#151311] hover:text-[#F8B56B]"
                  : "hover:bg-phx-paper hover:text-phx-accent",
              )}
              disabled={entry.disabled}
              key={entry.id}
              onClick={() => {
                entry.onSelect();
                onClose();
              }}
              type="button"
            >
              <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{entry.label}</span>
              {entry.hint ? (
                <span
                  className={cn(
                    "shrink-0 text-[11px] font-medium tabular-nums",
                    dark ? "text-[#5A6B80]" : "text-phx-ink-soft",
                  )}
                >
                  {entry.hint}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </>
  );
}
