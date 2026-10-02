/**
 * Is this ROI duration plausible, or does it look like a slip of the keyboard?
 *
 * 🔴 IT WARNS AND NEVER REFUSES (owner, 2026-10-02: "don't cap the ROI duration, make it at the
 * entry"). There is no maximum anywhere — not here, not in `normalizeMarketingRequestDraftInput`,
 * not in the attribution window. A campaign he wants to measure for three years is measured for
 * three years. This exists only so a TYPO is caught by the person typing it, at the one moment
 * fixing it is free.
 *
 * Why it is worth catching at all: `MKT-REQ-20260822-7A234FB1` carries **312** months — a window
 * running to 2052 — and nothing about the resulting row looks wrong. Its ROI never completes, so
 * it reads "waiting for the data" for twenty-six years rather than ever being judged, and it
 * quietly dilutes every pipeline figure it sits in. A wrong number that produces an error gets
 * fixed; a wrong number that produces a plausible-looking "pending" does not.
 *
 * 36 is the threshold because it is three years: longer than any campaign the business has run,
 * short enough that the common fat-finger shapes (312 for 3 or 12, 30 for 3, 120 for 12) all land
 * above it. It is a hint, not a rule — nothing reads this value except the form.
 */
export const ROI_MONTHS_PLAUSIBLE_MAX = 36;

export function roiMonthsWarning(raw: string | number | null | undefined): string | null {
  const months = Number(String(raw ?? "").trim());
  if (!Number.isFinite(months) || !Number.isInteger(months) || months <= 0) return null;
  if (months <= ROI_MONTHS_PLAUSIBLE_MAX) return null;

  const years = months / 12;
  const span = years >= 2 ? `${years % 1 === 0 ? years : years.toFixed(1)} years` : `${months} months`;
  return `${months} months is ${span} — check this is what you meant. Nothing stops you saving it, but a campaign this long is never judged: its ROI reads "waiting for the data" until the window closes.`;
}
