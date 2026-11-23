/**
 * Place checks — the one-by-one review's three questions to the browser: is another dialog open over
 * it, is he typing, and what the address says is open.
 *
 * The first two keep ← and → from moving a slide under the zoomed photo or inside a field; the third
 * keeps `?review=<tab>` in step, so a reload opens the same tab. Nothing here draws or decides.
 */

import type { DeckTab } from "@/lib/place-review-deck/slides";

/** Another modal over the review — the zoomed photo — owns the keyboard while it is open. */
function otherDialogOpen(): boolean {
  return document.querySelectorAll('[role="dialog"][aria-modal="true"]').length > 1;
}

function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.getAttribute("role") === "combobox") return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/** `?review=<tab>` kept in step with what is open, so a reload or a shared address opens the same tab. */
export function writeReviewParam(tab: DeckTab | null): void {
  const url = new URL(window.location.href);
  if (tab) url.searchParams.set("review", tab);
  else url.searchParams.delete("review");
  window.history.replaceState(window.history.state, "", url);
}

export { otherDialogOpen, typingIn };
