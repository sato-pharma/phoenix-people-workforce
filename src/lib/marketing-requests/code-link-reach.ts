/**
 * A confirmed distributor code earns nothing until a customer link points at it.
 *
 * THE OTHER HALF OF `code-unlink-fallout.ts`. That module stops an unlink silently taking a target
 * away. This one stops an ADD silently failing to give one.
 *
 * WHY A CODE ON A VENUE IS NOT ENOUGH. `phx_refresh_marketing_roi_facts` builds its targets from
 * `marketing_request_pharmacies` joined to `marketing_pharmacy_distributor_codes` on the target's
 * OWN `distributor_code_id`, and takes that row's `normalized_pharmacy_code` as the customer code
 * it credits sales against. A request can only target what the picker offers, and the picker is
 * built from `marketing_customer_pharmacies`. So a code sitting on a venue with no customer link
 * is unreachable by construction: no request can name it, and not one of its sales is ever
 * credited to the campaign that paid for it.
 *
 * MEASURED, and it is the whole point of the sheet that adds them. On 2026-09-08 all **79** codes
 * the owner had confirmed and added on 2026-09-06 were checked: **0** were reachable as a request
 * target. 77 sat on venues that had customers and simply had no link. Across the database it was
 * 80 unreachable codes over 60 venues. The sheet exists precisely so a pharmacy's OTHER
 * distributors count toward the campaigns he pays for, and none of them were counting.
 *
 * WHY THE STATUS IS INHERITED, NEVER SET. A link's `validation_status` decides whether the venue
 * appears in the picker at all — `getMarketingRequestDraftWorkspace` reads only `system_validated`
 * and `sfe_validated`. Stamping a new link `system_validated` because that is the common value
 * would make a venue nobody has validated suddenly selectable, turning a bookkeeping fix into a
 * silent validation bypass. So a new link copies the status the customer ALREADY has on that same
 * venue: strongest wins, and a customer whose existing link is unvalidated gets an unvalidated
 * sibling that stays out of the picker exactly as the original does. In the 2026-09-08 backfill
 * that kept 24 of 81 new links deliberately invisible.
 */

/**
 * Link validation statuses that make a venue selectable, strongest first.
 *
 * Order is the rule, not a detail: it decides which status a new sibling link inherits when a
 * customer somehow holds more than one link to the same venue. Anything not listed ranks below
 * every entry here and keeps the venue out of the picker.
 */
export const LINK_STATUS_PRECEDENCE = ["sfe_validated", "system_validated"] as const;

export type LinkValidationStatus = (typeof LINK_STATUS_PRECEDENCE)[number];

/**
 * The status a new link should carry, given every status this customer already holds on the venue.
 *
 * Returns `null` when there are none — the caller must not invent a relationship, and a venue the
 * customer has never been linked to is not one a backfill may link them to.
 */
export function inheritedLinkStatus(statuses: readonly string[]): string | null {
  if (statuses.length === 0) return null;
  for (const preferred of LINK_STATUS_PRECEDENCE) {
    if (statuses.includes(preferred)) return preferred;
  }
  return statuses[0] ?? null;
}

/** True when a link with this status is offered by the request form's target picker. */
export function linkStatusIsSelectable(status: string | null | undefined): boolean {
  return (LINK_STATUS_PRECEDENCE as readonly string[]).includes(String(status ?? ""));
}

/**
 * The SQL `case` expression ranking a status column by the same precedence.
 *
 * Emitted from `LINK_STATUS_PRECEDENCE` rather than written out beside it, because the ordering
 * lives in two places otherwise and the SQL copy is the one no test would catch drifting.
 *
 * `column` is interpolated into SQL, so it is restricted to a plain identifier — this builder is
 * called with literals in this repository, and that restriction is what keeps it that way.
 */
export function linkStatusRankSql(column: string): string {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(column)) {
    throw new Error(`linkStatusRankSql expects a plain column reference, got ${JSON.stringify(column)}`);
  }
  const total = LINK_STATUS_PRECEDENCE.length;
  const whens = LINK_STATUS_PRECEDENCE
    .map((status, index) => `when '${status}' then ${total - index + 1}`)
    .join(" ");
  return `case ${column} ${whens} else 1 end`;
}

/** Written onto every link this path creates, so the row explains itself years later. */
export const BACKFILLED_LINK_NOTE =
  "Created with the confirmed distributor code it points at (marketing-pharmacy-code-decisions sheet). "
  + "Without this link no marketing request could target that code, so none of its sales would be "
  + "credited to the campaign that paid for them. Validation status inherited from this customer's "
  + "existing link to the same venue - nothing was elevated.";
