/**
 * The call rate's addresses — the KPIs board's Call Rate tab and the per-rep visits page under it.
 * PURE, and deliberately so: the KPIs view, the visits page and every retired stub that forwards
 * here write these, and a client component must be able to import it without dragging a server
 * module in.
 *
 * ## Why the call rate lives on KPIs and nowhere else
 *
 * The owner merged Reps Plans into Reps List as a Call rate tab on the morning of 2026-09-21, then
 * took the tab off Reps List the same day, in both shells: "since the call rate is already in the
 * KPIs tab, so ... no need for it to be in the reps list tab". Asked what should happen to the
 * per-rep visits page it had carried, he chose "Open it from KPIs": the page stays, a rep's row on the
 * KPIs Call Rate tab opens it, and every old Reps Plans and Reps List call-rate address forwards to
 * KPIs. One board scores the call rate; a second one is how the two drift.
 */

/** The KPIs board's `?tab=` value for the Call Rate tab (KPI_TABS in crm/kpis-tabs.ts). */
export const KPIS_CALL_RATE_TAB = "call-rate";

/** The KPIs board in each shell. */
export const ADMIN_KPIS_PATH = "/admin/kpis";
export const PORTAL_KPIS_PATH = "/employee-portals/kpis";

/**
 * The key a KPIs row opens its visits page with — the SAME identity the call-rate board keys its
 * rows by (`repKeyOf` in crm/reps-plans.ts): the CRM account when there is one, else the hr id. The
 * visits page resolves an `hr:` key to that person's busiest account inside the viewer's own reach,
 * so either form lands on the row that was clicked. Null when the row has neither — there is then
 * nothing a URL could name without guessing.
 */
export function kpiCallRateRepKey(row: { agentCrmId: number | null; agentHrId: string | null }): string | null {
  if (row.agentCrmId != null) return `crm:${row.agentCrmId}`;
  const hrId = (row.agentHrId ?? "").trim();
  return hrId ? `hr:${hrId.toLowerCase()}` : null;
}

/**
 * The path of one rep's visits page, with no query. The key is decoded then re-encoded, so it lands
 * in the path once-encoded whichever form it arrived in (a route segment hands it over still
 * encoded); a key that does not decode is encoded as it came, and the page answers that nobody
 * holds it.
 */
export function kpiCallRateRepPath(basePath: string, repKey: string): string {
  let key = repKey;
  try {
    key = decodeURIComponent(repKey);
  } catch {
    // A malformed escape: forward it untouched and let the visits page answer "nobody by that key".
  }
  return `${basePath}/${KPIS_CALL_RATE_TAB}/${encodeURIComponent(key)}`;
}

/**
 * Where a retired call-rate address forwards: the KPIs Call Rate tab, or one rep's visits page
 * under it, carrying the month and the window the old link had. Line and region are NOT carried —
 * the old boards wrote organogram CODES there, the KPIs filters take names, and a filter that
 * silently matched nothing would open an empty board that reads as "nobody called anyone".
 */
export function kpisCallRateHref(input: {
  basePath: string;
  query: { month?: string; period?: string } | undefined;
  rep?: string;
}): string {
  const query = new URLSearchParams();
  if (input.query?.month) query.set("month", input.query.month);
  if (input.query?.period && input.query.period !== "month") query.set("period", input.query.period);
  if (!input.rep) query.set("tab", KPIS_CALL_RATE_TAB);
  const path = input.rep ? kpiCallRateRepPath(input.basePath, input.rep) : input.basePath;
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}
