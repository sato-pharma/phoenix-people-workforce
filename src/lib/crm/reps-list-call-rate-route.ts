/**
 * Reps List's Call rate tab — its query value and its addresses. PURE, and deliberately so: the tab
 * strip, the board's client-side controls, the drill-down and the four retired /reps-plans stubs all
 * write these, and a client component must be able to import it without dragging a server module in.
 *
 * The tab is the Reps Plans module, merged into Reps List by the owner on 2026-09-21 ("merge the 2
 * modules into 1 module WHICH REPS LIST").
 */

/** The `?tab=` value of the call-rate tab. The board's own controls and links write it back. */
export const CALL_RATE_TAB = "call-rate";

/**
 * An address on the Call rate tab — or, given a rep, his drill-down under it.
 *
 * The retired /reps-plans pages forward through this, carrying every filter the old link had, so a
 * bookmark or a shared link lands on the same board and the same window rather than on the contact
 * list. The rep key is decoded then re-encoded, so it arrives in the path once-encoded whichever
 * form the route segment handed over; a key that does not decode is passed through as it came.
 */
export function callRateHref(input: {
  basePath: string;
  query: { line?: string; month?: string; period?: string; region?: string; rep?: string } | undefined;
  rep?: string;
}): string {
  const query = new URLSearchParams();
  if (!input.rep) query.set("tab", CALL_RATE_TAB);
  const keys = input.rep
    ? (["month", "period", "line", "region"] as const)
    : (["month", "period", "line", "region", "rep"] as const);
  for (const key of keys) {
    const value = input.query?.[key];
    if (value) query.set(key, value);
  }
  let path = input.basePath;
  if (input.rep) {
    let rep = input.rep;
    try {
      rep = decodeURIComponent(input.rep);
    } catch {
      // A malformed escape: forward it untouched and let the drill-down answer "nobody by that key".
    }
    path = `${input.basePath}/${CALL_RATE_TAB}/${encodeURIComponent(rep)}`;
  }
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}
