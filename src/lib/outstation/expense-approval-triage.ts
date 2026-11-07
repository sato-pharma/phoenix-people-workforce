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
 * workload nobody matched, a flagged photo, a departure photo with no GPS position — needs a look.
 * Unknown is never clean.
 *
 * The no-GPS reason was added 2026-11-07 after the owner's review of the live page: the trip's own
 * photo tile warned "Departure photo: No GPS location" while the rail filed the same trip as Clean.
 * A photo with no position cannot be checked against the arrival photo, so the distance flag is
 * never raised for it — it was invisible to the rail rather than cleared by it.
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
  /** A departure photo was taken but carries no GPS position (payroll-expense-mapping.ts). */
  departurePhotoNoGps?: boolean | null;
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
  else if (record.departurePhotoNoGps) reasons.push("Departure photo has no GPS");

  return { reasons, triage: reasons.length === 0 ? "clean" : "look" };
}

/**
 * The workload status the trip's OWN day-by-day read gives once it has been opened, over the stamp
 * stored at submission (owner's review, 2026-11-07: a conference day read "No field activity" in
 * the rail while the trip page counted it worked — a meeting day is worked, trip-day-meetings.ts).
 * Null when there is no live read, so the stored stamp stands.
 */
export function liveWorkloadMatchStatus(idle: { idleDays: number; tripDays: number } | null | undefined): string | null {
  if (!idle || !(idle.tripDays > 0)) return null;
  if (idle.idleDays <= 0) return "matched";
  if (idle.idleDays >= idle.tripDays) return "no_activity";
  return "partial";
}

/** The records with each opened trip's live workload status laid over its stored one. */
export function withLiveWorkloadStatus<T extends { tripId: string; workloadMatchStatus?: string | null }>(
  records: T[],
  idleByTrip: Record<string, { idleDays: number; tripDays: number } | undefined>,
): T[] {
  let changed = false;
  const next = records.map((record) => {
    const live = liveWorkloadMatchStatus(idleByTrip[record.tripId]);
    if (!live || live === record.workloadMatchStatus) return record;
    changed = true;
    return { ...record, workloadMatchStatus: live };
  });
  return changed ? next : records;
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
