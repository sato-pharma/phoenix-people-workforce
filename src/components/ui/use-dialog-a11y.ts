"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Focus trap + ESC close + return-focus-on-close for modals/sheets.
 *
 * Usage:
 *   const dialogRef = useDialogA11y({ open, onClose });
 *   <div ref={dialogRef} role="dialog" aria-modal aria-labelledby="...">
 */
export function useDialogA11y<T extends HTMLElement = HTMLDivElement>({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const ref = useRef<T>(null);
  const returnFocusRef = useRef<Element | null>(null);
  // Hold the latest onClose in a ref so it is NOT an effect dependency. Callers
  // routinely pass an inline `() => setOpen(false)` that is a new function on
  // every render; if the focus-move effect below depended on onClose it would
  // re-run on every parent re-render and yank focus back into the dialog after
  // each keystroke — a controlled field then accepts only its first character.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    // Capture the element that had focus before the dialog opened so we can
    // return focus when it closes.
    returnFocusRef.current = document.activeElement;

    // Lock body scroll while the dialog is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Move focus into the dialog. Prefer the first focusable child; fall back
    // to the container itself so ESC can always be caught.
    const el = ref.current;
    if (el) {
      const first = el.querySelector<HTMLElement>(FOCUSABLE);
      if (first) {
        first.focus();
      } else {
        el.setAttribute("tabindex", "-1");
        el.focus();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (!ref.current) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key === "Tab") {
        const focusable = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (focusable.length === 0) { event.preventDefault(); return; }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey) {
          if (document.activeElement === first) { event.preventDefault(); last.focus(); }
        } else {
          if (document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  // Return focus when dialog closes
  useEffect(() => {
    if (open) return;
    const target = returnFocusRef.current;
    if (target && typeof (target as HTMLElement).focus === "function") {
      (target as HTMLElement).focus();
    }
    returnFocusRef.current = null;
  }, [open]);

  return ref;
}
