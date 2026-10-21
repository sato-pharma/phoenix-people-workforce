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
 * appears in the picker at all — `getMarketingRequestDraftWorkspace` reads only the statuses in
 * `LINK_STATUS_PRECEDENCE` below. Stamping a new link `system_validated` because that is the common value
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
 *
 * This is also THE list of statuses that count as validated for a link. The request picker and the
 * draft guard in `service.ts` filter on it directly, so a status added here is selectable
 * everywhere at once, and a status missing here is selectable nowhere.
 *
 * - `admin_approved` — a person pressed Approve on Customer Pharmacy Mapping: a ruling on this very
 *   pairing. Owner decision 2026-09-17: its own status, so a human ruling is never filed under the
 *   machine's label (AGENTS.md 4.1) and never mixed in with desk entries.
 * - `sfe_validated` — a desk entry: an admin validated on someone's behalf, with no field capture.
 * - `system_validated` — the evidence gate. NO HUMAN LOOKED.
 */
export const LINK_STATUS_PRECEDENCE = ["admin_approved", "sfe_validated", "system_validated"] as const;

export type LinkValidationStatus = (typeof LINK_STATUS_PRECEDENCE)[number];

/** What a customer's link has to say for the request form and the server to judge it as a target. */
export type CustomerTargetLink = {
  distributorCodeId: string | null;
  /** The link's `validation_notes` — read by the reviewers' screens, never by the target test. */
  notes: string | null;
  pharmacyId: string;
  status: string | null;
};

/**
 * - `coded` — a link to a distributor code: sales attribute through it. The ONLY kind there is.
 *
 * Marketing Requests hold only venues that carry a distributor code (owner, 2026-10-21 — "any thing
 * with no distributor code never reach the marketing requests"). The two codeless kinds this type
 * used to carry — `no_distributor_account` (a nursery: "spend allowed, sales can never be matched")
 * and `licence_released` (a pharmacy a person released on its licence) — are gone with the rules
 * they served. A codeless venue is validated in Direct Orders, never targeted here.
 */
export type RequestTargetKind = "coded";

/**
 * Whether a customer's link can be a request target — `"coded"`, or null when it cannot.
 *
 * THE ONE TEST. The request form's picker (`getMarketingRequestDraftWorkspace`) and the server's
 * draft guard (`prepareMarketingRequestDraft`) both call this, because they used to carry two
 * hand-written copies of "which links count" and the copies disagreed in the case that mattered.
 *
 * A link qualifies only when its status is selectable AND it names a distributor code. A link with
 * no code is never a target, whatever the venue is and whatever a person ruled on it — a nursery, a
 * pharmacy released on its licence and a broken row all answer null.
 */
export function requestTargetKind(link: Pick<CustomerTargetLink, "distributorCodeId" | "status">): RequestTargetKind | null {
  if (!linkStatusIsSelectable(link.status)) return null;
  if (!link.distributorCodeId) return null;
  return "coded";
}

/** The customer's own link for a chosen target, or undefined when the target is not theirs. */
export function findCustomerTargetLink(
  links: readonly CustomerTargetLink[],
  target: { distributorCodeId: string | null; pharmacyId: string },
): CustomerTargetLink | undefined {
  return links.find(
    (link) =>
      link.pharmacyId === target.pharmacyId
      && (link.distributorCodeId ?? null) === (target.distributorCodeId ?? null),
  );
}

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

/**
 * The SQL `in` list of selectable statuses, for a query that must match the picker — emitted from
 * `LINK_STATUS_PRECEDENCE` for the same reason as `linkStatusRankSql`: a hand-typed copy is the one
 * that silently misses a status added later.
 */
export function selectableLinkStatusSqlList(): string {
  return `(${LINK_STATUS_PRECEDENCE.map((status) => `'${status}'`).join(", ")})`;
}

/** Written onto every link this path creates, so the row explains itself years later. */
export const BACKFILLED_LINK_NOTE =
  "Created with the confirmed distributor code it points at (marketing-pharmacy-code-decisions sheet). "
  + "Without this link no marketing request could target that code, so none of its sales would be "
  + "credited to the campaign that paid for them. Validation status inherited from this customer's "
  + "existing link to the same venue - nothing was elevated.";
