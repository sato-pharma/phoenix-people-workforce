/**
 * Display scale — the app's own zoom-out, so the system opens dense instead of magnified.
 *
 * The complaint this answers: at the browser's normal 100% the shell renders large enough that a
 * table shows six rows where it should show fifteen, on both the admin and the portal shells. The
 * owner asked for the system to open already scaled to ~75-80% so nobody has to press Ctrl+minus
 * on every machine they sign in from.
 *
 * A page cannot drive the browser's own zoom control — that is browser chrome. CSS `zoom` on the
 * root element is what produces the same result, and it is applied in app/globals.css. This module
 * holds the vocabulary both halves read: the storage key, the custom property name, the allowed
 * steps and the default.
 *
 * WHY THE VALUE LIVES IN localStorage AND NOT THE DATABASE. The right scope for a display scale is
 * the SCREEN, not the person — the same manager wants a different value on a 1366 laptop and on the
 * 27-inch monitor at his desk. A per-device store gives him that for free, needs no migration, and
 * keeps this a pure code deploy. It also means a bad default can be corrected by the reader instead
 * of by another deploy.
 *
 * WHY THESE FIVE STEPS. They are the browser's own zoom stops over the range the owner named, so a
 * reader who already knows what Ctrl+minus does to a page recognises the numbers. Nothing below
 * 0.75 is offered: measured against this app's type scale, body text lands near 9px optical and the
 * field force on older laptops cannot read it.
 */

export const DISPLAY_SCALE_STORAGE_KEY = "phoenix-display-scale";

/**
 * The custom property app/globals.css reads. Everything that has to compensate for the zoom — the
 * shell width caps, the full-viewport-height utilities — divides by this same variable, so there is
 * exactly one number in the system and no second copy to drift.
 */
export const DISPLAY_SCALE_CSS_VAR = "--phx-display-scale";

/**
 * What is ACTUALLY in force after the desktop gate, which is NOT the same number.
 *
 * app/globals.css sets this to the scale above 1024px and leaves it at 1 below, because the zoom
 * is desktop-only. Everything that COMPENSATES for the zoom must divide by this one, never by the
 * stored preference: a width cap dividing by the raw 0.8 on a phone would inflate itself to 2,200px
 * while no zoom was applied to shrink it back, quietly removing a cap that exists to hold a line of
 * text to a readable length.
 */
export const DISPLAY_SCALE_APPLIED_CSS_VAR = "--phx-scale-applied";

/**
 * 80%, the owner's own midpoint of the "75% 80% etc" he asked for. Measured on the portal overview
 * at 1440x900: the content column carries 1,781 CSS px instead of 1,425, so a table shows about a
 * quarter more rows and columns in the same physical space.
 */
export const DEFAULT_DISPLAY_SCALE = 0.8;

/** Largest first, so the control reads left-to-right from "normal" to "densest". */
export const DISPLAY_SCALE_OPTIONS = [1, 0.9, 0.85, 0.8, 0.75] as const;

export type DisplayScale = (typeof DISPLAY_SCALE_OPTIONS)[number];

export function isDisplayScale(value: unknown): value is DisplayScale {
  return typeof value === "number" && (DISPLAY_SCALE_OPTIONS as readonly number[]).includes(value);
}

/**
 * Read a stored value back into a scale we are willing to apply.
 *
 * Deliberately total: every bad input — absent, empty, "0.8x", "NaN", a value someone hand-edited
 * into localStorage, a step retired in a later release — resolves to the default rather than
 * throwing or reaching the stylesheet. A display scale is not worth a broken page, and the inline
 * boot script in app/layout.tsx runs before React exists, so there is no error boundary above it.
 */
export function parseDisplayScale(raw: string | null | undefined): DisplayScale {
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_DISPLAY_SCALE;
  const parsed = Number.parseFloat(raw);
  return isDisplayScale(parsed) ? parsed : DEFAULT_DISPLAY_SCALE;
}

/** "80%" — what the control prints. Whole numbers only; every step is an exact percentage. */
export function formatDisplayScale(scale: DisplayScale): string {
  return `${Math.round(scale * 100)}%`;
}

/**
 * The width a shell may occupy, given the zoom.
 *
 * This is the half that is easy to forget and that makes the whole change pointless without it.
 * The caps are physical intentions — "never let a line of text run wider than 1,760 device pixels"
 * — but they are declared inside the zoomed coordinate space, so at 0.8 a raw 1760px cap paints at
 * 1,408 device px and the page gets NARROWER, not denser. Measured on the portal at 1440x900: the
 * 1580px cap took the content from 1,425 device px down to 1,264, with 81px of dead margin either
 * side, for only 15% more content.
 *
 * Dividing by the scale restores the physical intention exactly: the cap paints at the same device
 * width it always did, and simply holds more inside it.
 */
export function scaledWidthCapCss(deviceCapPx: number): string {
  return `calc(${deviceCapPx}px / var(${DISPLAY_SCALE_APPLIED_CSS_VAR}, 1))`;
}
