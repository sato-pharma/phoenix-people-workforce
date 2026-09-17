// The board's three URL parameters, built in one place.
//
// Every control on this page is a LINK, never a client-side filter, so that each switch re-runs
// the server-side scope gate (see early-birds-district-switcher.tsx). The catch with links is that
// each one has to carry the OTHER parameters forward: before this helper the district chips wrote
// `?district=…` and nothing else, so switching district while reading August silently threw you
// back to the live fortnight — and switching fortnight would have thrown a Super Admin back to the
// first district in the company.
//
// Pure, exported and tested (tests/early-birds-links.test.ts) because a dropped parameter is
// invisible in review: the page still renders, it just renders a different question's answer.

export type EarlyBirdsQuery = {
  /** District manager's HR id, in STORED casing — `assertDistrictInScope` normalises it. */
  district?: string | null;
  /** `YYYY-MM-H1` | `YYYY-MM-H2`. */
  period?: string | null;
  /** The rep whose history panel is open, if any. */
  rep?: string | null;
};

/**
 * `basePath` plus whichever of the three parameters are set.
 *
 * Order is fixed (district, period, rep) so two links to the same view are the same string — which
 * is what lets a chip decide whether it is the active one by comparing hrefs, and what keeps
 * Next.js from treating them as different routes.
 */
export function earlyBirdsHref(basePath: string, query: EarlyBirdsQuery): string {
  const parts: string[] = [];
  for (const key of ["district", "period", "rep"] as const) {
    const value = query[key];
    // Empty string is a DELIBERATE clear, not a missing value: `{ rep: "" }` is how a close button
    // drops the history panel while keeping the district and fortnight it was opened from.
    if (typeof value !== "string" || value.length === 0) continue;
    parts.push(`${key}=${encodeURIComponent(value)}`);
  }
  return parts.length === 0 ? basePath : `${basePath}?${parts.join("&")}`;
}
