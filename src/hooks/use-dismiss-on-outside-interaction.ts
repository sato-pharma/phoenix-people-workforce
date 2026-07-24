"use client";

import { useEffect, type RefObject } from "react";

/**
 * Closes an open dropdown/popover on an outside pointerdown or Escape.
 *
 * Small inline menus (topbar dropdowns, popovers) that lack their own
 * full-screen backdrop otherwise stay mounted after the click that opened
 * them — there is nothing telling them the user moved on — and silently
 * intercept clicks meant for whatever renders underneath, since they keep
 * occupying their absolutely-positioned box at a high z-index.
 */
export function useDismissOnOutsideInteraction(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
) {
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, ref, setOpen]);
}
