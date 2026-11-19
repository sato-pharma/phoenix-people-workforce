/**
 * Phoenix CRM — a customer's visit tally on every screen that shows a rep's weekly plan (owner, 19 Nov 2026:
 * "in every screen that shows the reps weekly plan must show this dr when was the last visit and the count of
 * his visits in this month and total count of visits to this dr").
 *
 * Three facts per customer of a territory: the day of the last visit, the visits this month and the visits in
 * total. They come from ONE database function, `phoenix_crm_customer_visit_tally` (20261119152938), over
 * `phoenix_crm_countable_visits_with_history` — the same view and the same month window as the planner's own
 * `visitsThisMonth` (`loadMonthVisitCounts`), so the month figure on a plan row and on every other screen is one
 * number. That view holds Phoenix's own visits and the iReports360 history copied into Phoenix, never an off-plan
 * visit nobody approved, a held far visit or an archived row.
 *
 * Pure: the server reader is `server/visit-tally.ts`, the wording is `visitTallyText` in
 * `components/phoenix-crm/labels.ts`.
 */

export type VisitTally = {
  /** The day of the last visit that counts, "2026-11-17"; null when none was ever recorded. */
  lastVisitOn: string | null;
  /** Visits since the first of this month, through today. */
  thisMonth: number;
  /** Every visit that counts, through today. */
  total: number;
};

/**
 * Every customer's tally, keyed two ways:
 *   - `byCustomer`: the Phoenix customer id — the planners, the daily plan report and the manager's board;
 *   - `byContact`: the CRM contact id (`coalesce(reference_contact_crm_id, own_contact_crm_id)`) — the Reps List's
 *     plan tab, whose rows are keyed by contact.
 * `read` is false when the database did not answer: a screen then draws nothing about visits rather than a
 * "No visit recorded yet" that would be untrue.
 */
export type VisitTallies = {
  read: boolean;
  byCustomer: Map<string, VisitTally>;
  byContact: Map<number, VisitTally>;
};

export function emptyVisitTallies(read = false): VisitTallies {
  return { read, byCustomer: new Map(), byContact: new Map() };
}

/** The tally of a customer nobody has visited — said only when the read answered. */
export const NO_VISITS: VisitTally = Object.freeze({ lastVisitOn: null, thisMonth: 0, total: 0 });

function count(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function isoDayOrNull(value: unknown): string | null {
  const text = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function contactIdOf(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Two rows for one doctor (a customer moved between seats, or two customers sharing a contact) are one tally. */
export function mergeVisitTallies(left: VisitTally, right: VisitTally): VisitTally {
  const lastVisitOn =
    left.lastVisitOn && right.lastVisitOn ? (left.lastVisitOn > right.lastVisitOn ? left.lastVisitOn : right.lastVisitOn) : (left.lastVisitOn ?? right.lastVisitOn);
  return { lastVisitOn, thisMonth: left.thisMonth + right.thisMonth, total: left.total + right.total };
}

/** The function's rows, folded. A row with no customer id is skipped; one with no contact id is keyed by customer only. */
export function foldVisitTallies(rows: ReadonlyArray<Record<string, unknown>>): VisitTallies {
  const tallies = emptyVisitTallies(true);
  for (const row of rows) {
    const customerId = typeof row.customer_id === "string" && row.customer_id ? row.customer_id : null;
    if (!customerId) continue;
    const tally: VisitTally = { lastVisitOn: isoDayOrNull(row.last_visit_on), thisMonth: count(row.month_visits), total: count(row.total_visits) };
    const known = tallies.byCustomer.get(customerId);
    tallies.byCustomer.set(customerId, known ? mergeVisitTallies(known, tally) : tally);
    const contactId = contactIdOf(row.contact_crm_id);
    if (contactId !== null) {
      const byContact = tallies.byContact.get(contactId);
      tallies.byContact.set(contactId, byContact ? mergeVisitTallies(byContact, tally) : tally);
    }
  }
  return tallies;
}

/**
 * One customer's tally: `NO_VISITS` when the read answered and he has none; null when the read failed or the row
 * names no customer — "No visit recorded yet" is never said about a row nobody could look up.
 */
export function tallyForCustomer(tallies: VisitTallies, customerId: string | null | undefined): VisitTally | null {
  if (!tallies.read || !customerId) return null;
  return tallies.byCustomer.get(customerId) ?? NO_VISITS;
}

/** The same, by CRM contact id. */
export function tallyForContact(tallies: VisitTallies, contactCrmId: number | null | undefined): VisitTally | null {
  if (!tallies.read || contactCrmId == null) return null;
  return tallies.byContact.get(contactCrmId) ?? NO_VISITS;
}

/**
 * A plan's tallies sent to the browser as plain data, keyed by CRM contact id as text (Plan Verification). Null
 * when the read failed, so the screen draws nothing about visits.
 */
export function contactTalliesRecord(tallies: VisitTallies, contactCrmIds: Iterable<number | null | undefined>): Record<string, VisitTally> | null {
  if (!tallies.read) return null;
  const record: Record<string, VisitTally> = {};
  for (const contactCrmId of contactCrmIds) {
    if (contactCrmId == null) continue;
    record[String(contactCrmId)] = tallies.byContact.get(contactCrmId) ?? NO_VISITS;
  }
  return record;
}

/** A tally sent to the browser as plain data, keyed by customer id (the daily plan report's map). */
export function talliesRecord(tallies: VisitTallies, customerIds: Iterable<string>): Record<string, VisitTally> {
  const record: Record<string, VisitTally> = {};
  if (!tallies.read) return record;
  for (const customerId of customerIds) record[customerId] = tallies.byCustomer.get(customerId) ?? NO_VISITS;
  return record;
}
