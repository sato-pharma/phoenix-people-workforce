/**
 * Which trips in the Expense Approvals queue need a look, and how long each has waited.
 *
 * Owner, 2026-11-07 ~01:45, choosing from the enhancements offered: "Rail filter: Needs a look /
 * Clean" and "Oldest first + awaiting N days". The rail can only use what the queue already
 * loaded for every trip at once — the stored workload match and the departure photo's own flags.
 * The per-trip claim checks are fetched when a trip is opened, so they never feed this.
 *
 * A trip is CLEAN only when it is positively evidenced: every day of it matched CRM visits and
 * the departure photo carries no flag. Anything else — no visits, some days without visits, a
 * workload nobody matched, a flagged photo — needs a look. Unknown is never clean.
 *
 * An Excel-imported row carries neither field, so it has no triage at all (null): it shows under
 * "All" and under neither narrowed choice, never quietly filed as clean.
 */

export type ExpenseTripTriage = "clean" | "look";

/** "" = no narrowing. */
export type ExpenseTripTriageFilter = "" | ExpenseTripTriage;

export type ExpenseApprovalSort = "value" | "oldest";

export type ExpenseTripTriageRecord = {
  departurePhotoFlagged?: boolean | null;
  workloadMatchStatus?: string | null;
};

export type ExpenseTripTriageReading = { reasons: string[]; triage: ExpenseTripTriage };

export function expenseTripTriage(record: ExpenseTripTriageRecord): ExpenseTripTriageReading | null {
  const status = String(record.workloadMatchStatus ?? "").trim();
  const hasPhotoReading = typeof record.departurePhotoFlagged === "boolean";
  if (!status && !hasPhotoReading) return null;

  const reasons: string[] = [];
  if (status === "no_activity") reasons.push("No field activity");
  else if (status === "partial") reasons.push("Some days without field activity");
  else if (status !== "matched") reasons.push("Visits not verified");
  if (record.departurePhotoFlagged) reasons.push("Departure photo flagged");

  return { reasons, triage: reasons.length === 0 ? "clean" : "look" };
}

/** An unset choice matches everything; a row with no reading matches only "All". */
export function matchesExpenseTripTriage(record: ExpenseTripTriageRecord, filter: ExpenseTripTriageFilter | undefined): boolean {
  if (!filter) return true;
  return expenseTripTriage(record)?.triage === filter;
}

export function expenseTripTriageLabel(filter: ExpenseTripTriageFilter): string {
  return filter === "look" ? "Needs a look" : filter === "clean" ? "Clean" : "All";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days since the claim was submitted; null when there is no usable submission time. */
export function expenseTripDaysAwaiting(submittedAt: string | null | undefined, now: number = Date.now()): number | null {
  const raw = String(submittedAt ?? "").trim();
  if (!raw) return null;
  const time = new Date(raw).getTime();
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((now - time) / DAY_MS));
}

export function expenseTripAwaitingLabel(days: number): string {
  if (days <= 0) return "Submitted today";
  return `Awaiting ${days} day${days === 1 ? "" : "s"}`;
}

function submittedTime(record: { submittedAt?: string | null }): number {
  const time = new Date(String(record.submittedAt ?? "")).getTime();
  // A row with no submission time sorts after every dated one, never ahead of a real wait.
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

/**
 * The order WITHIN one decision state. "value" is the queue's long-standing biggest-claim-first;
 * "oldest" puts the longest wait on top. The rail and the "approve, then the next one" step both
 * use this one comparator, so the trip that opens next is always the row under the one decided.
 */
export function compareExpenseApprovalTrips(sort: ExpenseApprovalSort | undefined) {
  return (left: { submittedAt?: string | null; total: number }, right: { submittedAt?: string | null; total: number }) => {
    if (sort === "oldest") {
      const byWait = submittedTime(left) - submittedTime(right);
      if (byWait !== 0 && Number.isFinite(byWait)) return byWait;
      if (!Number.isFinite(submittedTime(left)) !== !Number.isFinite(submittedTime(right))) {
        return Number.isFinite(submittedTime(left)) ? -1 : 1;
      }
    }
    return right.total - left.total;
  };
}
