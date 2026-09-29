/**
 * Guards for any bulk import of leave from an outside system — today the CRM vacation backfill
 * (scripts/import-crm-vacation-backfill.ts).
 *
 * WHY A HIRE-DATE GUARD EXISTS, AND WHAT IT ALREADY COST.
 *
 * iReports360 identifies a rep by a numeric CRM account, and that account is a SEAT: when a rep
 * leaves, the next person on that territory inherits the same account, which the vendor renames to
 * the new occupant. A re-sync then re-fetches old months and stamps those historical visits with
 * the seat's CURRENT name — so a row's name and `crm_username` describe whoever holds the seat
 * today, not whoever did the work.
 *
 * On 2026-09-30 slot 1111 (the Qena Pedia seat) read `Taha.Sheeba ( Qena 1 / P )` on 168 March
 * visits. Taha Sheeba starts 2026-10-01. The seat's March occupant was Hayam Mohamed Eladl, who
 * resigned 2026-08-31 — every other month of the same seat carries 160-235 rows of hers and March
 * carried 8, with the missing 168 sitting under the new label.
 *
 * `CRM_BACKFILL_2026-08-24` made exactly that mistake once: PD-0009, hired 2026-08-01, carries an
 * approved leave row dated 2026-02-15 — 167 days before he joined — taken from the previous holder
 * of the Helwan-Maadi Pedia seat. It reached production and nobody saw it, because a pre-hire date
 * breaks no constraint: the balance engine refuses to PAY such a day (it falls inside the
 * first-six-months block and lands unpaid) but nothing refuses to CREATE it.
 *
 * So this is not a date-sanity nicety. It is the one check that separates "this employee took this
 * leave" from "this seat recorded this leave", and it belongs in front of every import, because the
 * evidence that the row is wrong is never in the row itself.
 */

export type LeaveBeforeHireVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Refuse a leave row that cannot belong to the person it names.
 *
 * Refuses three shapes, all of which mean the same thing — the row's identity is unproven:
 *   · the leave predates the hire date (the seat-reuse case above);
 *   · the employee has no hire date, so nothing can be checked;
 *   · the hire date is in the future, i.e. the person has not started at all.
 *
 * `today` is passed in rather than read from the clock so a caller can price a batch as of a
 * chosen day and a test needs no clock control. Dates are ISO date-only strings, compared as
 * strings: they are zero-padded and fixed-width, so lexical order is chronological order, and no
 * timezone can shift a day the way parsing to a Date would.
 */
export function refuseLeaveBeforeHire(input: {
  hireDate: string | null | undefined;
  leaveDate: string;
  today: string;
}): LeaveBeforeHireVerdict {
  const hireDate = (input.hireDate ?? "").trim();
  if (!hireDate) {
    return { ok: false, reason: "employee has no hire date, so this leave cannot be attributed to them" };
  }
  if (hireDate > input.today) {
    return {
      ok: false,
      reason: `employee has not started yet (hired ${hireDate}) — a CRM seat carries its NEXT occupant's name once it is renamed`,
    };
  }
  if (input.leaveDate < hireDate) {
    return {
      ok: false,
      reason: `leave dated ${input.leaveDate} is before the hire date ${hireDate} — the CRM seat's earlier occupant did this, not this employee`,
    };
  }
  return { ok: true };
}
