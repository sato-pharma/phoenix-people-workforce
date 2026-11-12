/**
 * THE DAYS THE SUPER ADMIN ACCEPTED A WHOLE-DAY REVIEW REQUEST FOR — a deduction source.
 *
 * Owner, 2026-11-13: the Private Calendar pulls every daily record source; a working day with no
 * record is deducted. An employee who sees an empty day files a review request (Request review on
 * his own calendar) — not because the system is wrong, but because he followed up his own empty
 * day — and the owner accepts it. *"What I accept is appeared in the [calendar] and the day is not
 * considered deducted."*
 *
 * Until this file the calendar half was built (`buildAcceptedCorrectionItems`, 2026-10-29) and the
 * deduction half was not: no deduction reader read `private_calendar_data_disputes`, so 7 accepted
 * October days across 5 people still reached the Deductions module as CRM lines and he cleared each
 * of them a second time, by hand, as "Do Not Take Action" on 9 November.
 *
 * Only a WHOLE-DAY request counts (`item_source` null) — the same set the calendar turns into its
 * lime "Admin-verified correction" entry. An item-scoped request annotates something that was
 * already recorded on the day, so it never stood for an empty day. Only `accepted`: a pending or a
 * rejected request spares nothing.
 *
 * Read by `loadProvenWorkedDays`, so it can only ever REMOVE a day from a charge, never bring a
 * person into one. FAILS CLOSED — a failed read throws; a silent "nothing accepted" is a charge.
 */

import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type AcceptedReviewDay = {
  /** What the employee said happened, as he wrote it — the reason line a reviewer reads. */
  claim: string;
  date: string;
  hrId: string;
};

type AcceptedReviewRow = {
  claim_text: string | null;
  dispute_date: string;
  employee_hr_id: string;
  id: string;
};

/** The reason line a spared day carries into a deduction's evidence. */
export function describeAcceptedReviewDay(day: AcceptedReviewDay): string {
  const claim = day.claim.replace(/\s+/g, " ").trim();
  return claim ? `Review request accepted on the Private Calendar: ${claim}` : "Review request accepted on the Private Calendar";
}

/** Pure, so the filter is pinned by a test: accepted, whole-day, a real date inside the window. */
export function selectAcceptedReviewDays(
  rows: ReadonlyArray<AcceptedReviewRow & { item_source?: string | null; status?: string | null }>,
  window: { end: string; start: string },
): AcceptedReviewDay[] {
  const out: AcceptedReviewDay[] = [];
  for (const row of rows) {
    if (row.status !== undefined && row.status !== "accepted") continue;
    if (row.item_source !== undefined && row.item_source !== null) continue;
    const date = String(row.dispute_date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < window.start || date > window.end) continue;
    if (!row.employee_hr_id) continue;
    out.push({ claim: row.claim_text ?? "", date, hrId: row.employee_hr_id });
  }
  return out;
}

/** Every accepted whole-day review request in the window. Throws on a failed read. */
export async function loadAcceptedReviewDays(input: { end: string; start: string }): Promise<AcceptedReviewDay[]> {
  let rows: Array<AcceptedReviewRow & { item_source: string | null; status: string }>;
  try {
    rows = await fetchAllRows<AcceptedReviewRow & { item_source: string | null; status: string }>(
      () =>
        getSupabaseAdmin()
          .from("private_calendar_data_disputes")
          .select("id,employee_hr_id,dispute_date,claim_text,item_source,status")
          .eq("status", "accepted")
          .is("item_source", null)
          .gte("dispute_date", input.start)
          .lte("dispute_date", input.end),
      "id",
    );
  } catch (error) {
    throw new Error(
      `Failed to load accepted Private Calendar review requests: ${(error as { message?: string } | null)?.message ?? String(error)}`,
    );
  }
  return selectAcceptedReviewDays(rows, input);
}
