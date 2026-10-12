// ─────────────────────────────────────────────────────────────────────────────
// "Is there a published closing behind these figures at all?" — the one signal the
// manager keycards must consult before printing a money number.
//
// WHY THIS EXISTS. The DSM / NSM / RM landing keycards read a window that is already
// gated on publication: sos-team-performance only keeps rows whose own (line, period)
// Monthly Closing is published, and `salesWindowLabel` returns null exactly when that
// leaves no period at all. The performance object itself is still built — team size,
// district counts and the CRM board are all real — so the cards used to render
// `egpCompact(0)`, `0%` and a ROSE accent, which reads as a district that sold nothing.
//
// Measured on production 2026-10-12: the owner unpublished all nine (line × month)
// closings between 01:05 and 01:11 Cairo, so every DSM / NSM / RM keycard on the
// platform printed a red 0% while the underlying data was intact — Pedia Giza alone
// held 465,752 EGP against an 828,090 EGP target for September.
//
// 🔒 OWNER RULING, 2026-08-13: "a blank keycard is the correct state until a period is
// published, never a live-but-unclosed number." A withheld figure is a dash; zero is a
// claim. This module is the shared spelling of that so the three dashboards cannot
// drift apart on it.
//
// NOT the rep's achievement tile. That one deliberately FALLS BACK to the newest
// published month and names it (owner, 2026-10-01) — see the lock comment in
// portal-command-center.tsx. It is already honest, and must not be turned into an
// empty state. This module only covers the case where there is nothing to fall back to.
// ─────────────────────────────────────────────────────────────────────────────

/** The keycard sub-label when nothing is published, in place of "<Month> closing". */
export const NO_PUBLISHED_CLOSING_SUB = "no published closing yet";

/** The one-line explanation under a withheld keycard grid. Never a number. */
export const NO_PUBLISHED_CLOSING_NOTE =
  "No Monthly Closing is published for your line yet, so these figures are withheld rather than shown as zero.";

/** What a withheld money / percentage keycard prints. Matches the dash the cards already use. */
export const WITHHELD_VALUE = "—";

/**
 * True when at least one published closing sits inside the viewer's window.
 *
 * `windowLabel` is `salesWindowLabel(periods)`, and `periods` is the ALREADY
 * publication-filtered active period list — so a null label is not a formatting
 * accident, it is "nothing is published in your scope".
 */
export function hasPublishedWindow(windowLabel: string | null | undefined): boolean {
  return Boolean(windowLabel && String(windowLabel).trim());
}

/** The sales keycard's sub-label: the closing month when there is one, the withheld note otherwise. */
export function closingSalesSub(windowLabel: string | null | undefined): string {
  return hasPublishedWindow(windowLabel) ? `${windowLabel} closing` : NO_PUBLISHED_CLOSING_SUB;
}

/**
 * A money / percentage keycard value, withheld to a dash when nothing is published.
 *
 * `render` is only called when there IS a published window, so a caller can format
 * freely without repeating the guard.
 */
export function publishedFigure(windowLabel: string | null | undefined, render: () => string): string {
  return hasPublishedWindow(windowLabel) ? render() : WITHHELD_VALUE;
}

/**
 * The accent + ink an achievement tile wears. Neutral slate when the figure is withheld —
 * the rose "under 70%" ink beside a dash is the same false alarm as the 0% it replaced.
 */
export function achievementTone(
  windowLabel: string | null | undefined,
  percent: number,
): { accent: string; valueClass: string } {
  if (!hasPublishedWindow(windowLabel)) return { accent: "bg-slate-900", valueClass: "text-slate-500" };
  if (percent >= 100) return { accent: "bg-emerald-500", valueClass: "text-emerald-600" };
  if (percent >= 90) return { accent: "bg-amber-400", valueClass: "text-amber-600" };
  if (percent >= 70) return { accent: "bg-orange-500", valueClass: "text-orange-600" };
  return { accent: "bg-rose-500", valueClass: "text-rose-600" };
}
