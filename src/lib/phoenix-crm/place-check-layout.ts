/**
 * Phoenix CRM — Place checks: the server's guess at which layout a request will draw.
 *
 * Pure and screen-free. The board's lists draw a table from `md` up and cards below it; the page hands
 * the board this guess so each row is rendered once (`place-checks/layout.tsx` says why and how the
 * browser corrects a wrong one).
 */

export type PlaceCheckLayout = "cards" | "table";

/** The width a list's table starts at: the module's `md` breakpoint (`CrmTable`, `CrmCardsOnPhone`). */
export const PLACE_CHECK_TABLE_FROM_PX = 768;

/**
 * A phone asks for cards, everything else for the table. The browser's own hint decides when it sent
 * one (`Sec-CH-UA-Mobile`); otherwise the word every phone browser puts in its name. A tablet is wide
 * enough for the table and says neither, so it reads as a desktop.
 */
export function placeCheckLayoutGuess(request: { userAgent: string | null; mobileHint: string | null }): PlaceCheckLayout {
  const hint = request.mobileHint?.trim();
  if (hint === "?1") return "cards";
  if (hint === "?0") return "table";
  return /Mobi|iPhone|iPod/i.test(request.userAgent ?? "") ? "cards" : "table";
}
