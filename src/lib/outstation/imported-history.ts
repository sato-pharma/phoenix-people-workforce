import {
  expenseDecisionChanged,
  type StoredExpenseDecision,
} from "@/lib/outstation/approval-state";

/**
 * Outstation trips from before Phoenix approvals began are IMPORTED HISTORY: shown for their
 * values, never offered for a decision.
 *
 * Owner ruling, 2026-09-12, answering the outstation-expense meaning sheet: "from to to june show
 * all values only and donot give a notification to approve because they were imported from
 * outsoiyrce source not phx approvals are from expense requests submitted through phx".
 *
 * Measured on production the same day. Every trip dated up to 30 June 2026 sits in payout periods
 * February to July, came in through bulk spreadsheet uploads (plus nine rows whose Phoenix request
 * no longer exists), and every one of them is already decided — so there is nothing left in that
 * history for anyone to approve. Phoenix-submitted requests start with July's trips. The date is the
 * mechanism, not the upload's file name: a file name is free text written by more than one path.
 *
 * What "values only" means, in every place that used to ask for a decision:
 *   - the Expense Approvals queue shows the trip with no tick box, no Approve / Reject / Unapprove,
 *     and no editable amount or reason, and never counts it as awaiting a decision;
 *   - the portal's "Expense actions pending" never counts it;
 *   - the server refuses a CHANGED decision on it (planImportedHistoryWrites), so the rule does not
 *     rest on the buttons being hidden.
 */
export const PHOENIX_OUTSTATION_APPROVALS_START = "2026-07-01";

/**
 * Whether a trip is imported history. Compared as `YYYY-MM-DD` strings, so the shape check is
 * load-bearing: any other text would sort unpredictably against a date. A trip whose date cannot be
 * read answers false — it keeps the decision controls it has today rather than silently losing them.
 */
export function isImportedHistoryTrip(tripDate: string | null | undefined): boolean {
  const day = String(tripDate ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return day < PHOENIX_OUTSTATION_APPROVALS_START;
}

export type ImportedHistoryWriteCandidate = {
  approvedAmount?: number | null;
  date: string | null | undefined;
  hrApproved?: boolean;
  hrComment?: string;
  specialist?: string | null;
  status?: string | null;
  total: number;
  tripId: string;
};

/**
 * What a save may do to imported-history trips that are already stored.
 *
 * The approvals screen posts a report's WHOLE record set on every Save, including trips nobody
 * touched, so refusing every historical row would make any save that shares a report with one
 * impossible. Instead:
 *
 *   - an UNCHANGED historical trip is written back with its stored decision preserved — not
 *     re-stamped with today's approver and time, which is what an ordinary save does to an approved
 *     row and which would make "who decided this" name whoever last pressed Save;
 *   - a CHANGED decision on a historical trip is refused, naming the trip;
 *   - a historical trip with no stored row is left alone, because an upload of the outside source
 *     is exactly how history arrives;
 *   - every trip from July onward is untouched by this function.
 */
export function planImportedHistoryWrites(input: {
  records: ReadonlyArray<ImportedHistoryWriteCandidate>;
  storedByTripId: ReadonlyMap<string, StoredExpenseDecision>;
}): { preserveTripIds: Set<string>; refused: Array<{ name: string; tripId: string }> } {
  const preserveTripIds = new Set<string>();
  const refused: Array<{ name: string; tripId: string }> = [];

  for (const record of input.records) {
    if (!isImportedHistoryTrip(record.date)) continue;
    const stored = input.storedByTripId.get(record.tripId);
    if (!stored) continue;

    const changed = expenseDecisionChanged(
      {
        approvedAmount: typeof record.approvedAmount === "number" ? record.approvedAmount : record.total,
        hrApproved: Boolean(record.hrApproved),
        hrComment: record.hrComment ?? "",
        status: record.status ?? "",
      },
      {
        approvedAmount: typeof stored.approvedAmount === "number" ? stored.approvedAmount : record.total,
        hrApproved: stored.hrApproved,
        hrComment: stored.hrComment,
        status: stored.status,
      },
    );

    if (changed) refused.push({ name: String(record.specialist ?? "").trim() || record.tripId, tripId: record.tripId });
    else preserveTripIds.add(record.tripId);
  }

  return { preserveTripIds, refused };
}

/** The refusal a save raises when it tried to change an imported-history decision. */
export function describeImportedHistoryRefusal(refused: ReadonlyArray<{ name: string; tripId: string }>): string {
  const names = [...new Set(refused.map((entry) => entry.name))];
  return (
    `Conflict: ${refused.length} trip${refused.length === 1 ? "" : "s"} dated before 1 July 2026 ` +
    `${refused.length === 1 ? "was" : "were"} imported from the outside source and ${refused.length === 1 ? "is" : "are"} ` +
    `shown for ${refused.length === 1 ? "its" : "their"} values only, so the decision cannot be changed here ` +
    `(${names.join(", ")}). Nothing was saved.`
  );
}
