/**
 * Phoenix CRM — has a person left by a given day. One rule, no I/O, for the three places the sweep of
 * 11 Nov 2026 found asking nobody:
 *
 *   - a manager's double or chain visit credited a seat's REP who had already left (14 visits: Omaima Wael 8,
 *     on Mahmoud Badawy's double visits of 3-4 Nov; Youssef Hesham 6 on 3 Oct) — the organogram keeps a
 *     leaver in his seat until HR moves him out, and the save took the seat's occupant as it stood;
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
};

export function hasLeftBy(record: DepartureRecord | null | undefined, day: string): boolean {
  if (!record) return false;
  const last = String(record.lastWorkingDate ?? "").trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(last)) return last < day;
  return record.statusEnded;
}

/** What a manager is told when the seat's rep left before the visit day (`resolveVisitParticipants`). */
export const SEAT_REP_LEFT =
  "This territory's rep has left, so it has no rep on this day: the visit can only be entered as your own single visit.";
