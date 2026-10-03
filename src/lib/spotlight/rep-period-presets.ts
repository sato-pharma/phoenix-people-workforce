// Spotlight (self) — the quick-pick periods on the rep's own period step.
//
// Pure and database-free on purpose: this is the one piece of the picker whose arithmetic can be
// wrong in a way nothing complains about, so it lives where a test can assert on it rather than
// inside the client component where only a source-string check could reach it.
//
// 🔴 THE PICKS END AT THE LATEST PUBLISHED MONTH, NOT AT TODAY.
//
// A spotlight is a published number, and the closing golden rule is that a closing is never released
// during the month it covers — so the newest month a rep can be measured over is always behind the
// calendar. Anchoring the picks on the last SELECTABLE month (today) therefore made the first and
// most prominent one a guaranteed dead end: "This month" asked for a month whose closing cannot
// exist yet, and "Last 2 months" asked for two of them, both answered "none of these months has a
// published closing yet, so there is nothing to measure".
//
// Measured on production 2026-10-03: the picker offered January to October 2026 while only July and
// August were published, so two of the four quick picks could never produce a sheet.
//
// The From / To dropdowns still offer every month — the owner's free-form range (2026-09-30), which
// is deliberately NOT one of the four calendar window shapes. An unpublished month picked by hand is
// dropped from the measurement and named in the amber banner, which is the honest answer. It is only
// the SHORTCUTS that must land somewhere with figures.

export type RepSpotlightPreset = {
  label: string;
  /** `[from, to]`, both inclusive `YYYY-MM`. */
  range: [string, string];
};

/**
 * The quick picks for a rep's own spotlight.
 *
 * @param months          every month the picker offers, ascending `YYYY-MM`.
 * @param latestPublished the newest month whose closing is published, or null/unknown. When it is
 *                        not one of `months` the picks fall back to the newest month offered, which
 *                        is the old behaviour and the only honest answer when nothing is published.
 */
export function repSpotlightPresets(
  months: readonly string[],
  latestPublished?: string | null,
): RepSpotlightPreset[] {
  if (months.length === 0) return [];

  const anchorIndex =
    latestPublished && months.includes(latestPublished)
      ? months.indexOf(latestPublished)
      : months.length - 1;
  // Everything up to and including the anchor. A pick never reaches past it.
  const usable = months.slice(0, anchorIndex + 1);
  const last = usable[usable.length - 1]!;
  const take = (n: number): [string, string] => {
    const slice = usable.slice(Math.max(0, usable.length - n));
    return [slice[0]!, slice[slice.length - 1]!];
  };

  const out: RepSpotlightPreset[] = [{ label: "This month", range: [last, last] }];
  if (usable.length >= 2) out.push({ label: "Last 2 months", range: take(2) });
  if (usable.length >= 3) out.push({ label: "Last quarter", range: take(3) });
  if (usable.length >= 6) out.push({ label: "Last semester", range: take(6) });
  return out;
}
