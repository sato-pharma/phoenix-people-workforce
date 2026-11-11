/**
 * Phoenix CRM — has a person left by a given day. One rule, no I/O, for the places the sweep of 11 Nov 2026
 * found asking nobody:
 *
 *   - a manager's double or chain visit credited a seat's REP who had already left (14 visits: Omaima Wael 8,
 *     on Mahmoud Badawy's double visits of 3-4 Nov; Youssef Hesham 6 on 3 Oct). 🔴 The owner's ruling, 11 Nov
 *     2026: the visit is SHOWN and credited as it was entered, and the Visit Report marks the leaver
 *     "Resigned on <date>" (`leftLabel`) — never refused, never moved to the manager alone;
 *   - Phoenix CRM's notices went to people who had left (Emad Awad, Hana Abdelaziz, Omaima Wael, Youssef Hesham);
 *   - "Validate this customer again" went to whoever validated it, not to whoever holds the seat now.
 *
 * The last working date decides when there is one: the person worked THROUGH it, so has left only on a later
 * day, and someone serving notice is still told and still credited. With no date, a terminal employment status
 * says the person has gone (`isTerminalEmploymentStatus`, read by the caller so this file stays pure — the rule
 * `withoutDepartedHrIds` already applies to role notices). Nothing known is never "left": an unread or missing
 * record fails open, exactly as that rule does.
 */

export type DepartureRecord = {
  /** `isTerminalEmploymentStatus(employment_status)` — resigned, terminated, not renewed, anything not active. */
  statusEnded: boolean;
  lastWorkingDate: string | null | undefined;
  /** The raw employment status, only to word the label (`leftLabel`): "resigned" reads "Resigned on". */
  employmentStatus?: string | null;
};

function dayOf(value: string | null | undefined): string | null {
  const day = String(value ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

export function hasLeftBy(record: DepartureRecord | null | undefined, day: string): boolean {
  if (!record) return false;
  const last = dayOf(record.lastWorkingDate);
  if (last) return last < day;
  return record.statusEnded;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The mark beside a person on a visit dated after they left — "Resigned on 31 Oct 2026", "Left on …" for any
 * other ending, "Resigned" with no date on the record. Null when they had not left by `visitDay`, so a rep
 * serving notice, and every visit before the last working day, carries nothing.
 */
export function leftLabel(record: DepartureRecord | null | undefined, visitDay: string): string | null {
  if (!record || !hasLeftBy(record, visitDay)) return null;
  const verb = String(record.employmentStatus ?? "").trim().toLowerCase() === "resigned" ? "Resigned" : "Left";
  const last = dayOf(record.lastWorkingDate);
  if (!last) return verb;
  const [year, month, date] = last.split("-");
  return `${verb} on ${Number(date)} ${MONTHS[Number(month) - 1]} ${year}`;
}
