/**
 * The version of an outstation claim the reviewer was looking at when they decided it.
 *
 * Why it exists (found by a risk review of the chained-journey PR, 2026-10-18). A claim keeps
 * MOVING while it waits in Expense Approvals: the employee can add extra tickets, and on a car trip
 * a stop that re-prices the whole journey. The approver loads the queue showing fuel 853.78, the
 * employee adds a stop, the approver clicks Approve on the old screen — and payroll received the
 * figure he never saw. An approval decides a MONEY figure, so it has to carry which figure.
 *
 * The version is the request row's `updated_at`. Every writer that moves a money column on
 * `outstation_expense_requests` stamps it (extra tickets, a journey stop, the admin edit), and no
 * database trigger does it for them — so a writer that forgot would be the defect, not this token.
 * A change that moves no money (a workload grab, a refused departure location) leaves it alone on
 * purpose, so the reviewer is not sent back to refresh over nothing.
 *
 * Pure and import-free so a test can drive it without a database, and so the screens, the routes
 * and the service all compare the SAME normalisation.
 */

/** The code a decision route answers with (409) and a batch entry carries when a claim moved. */
export const OUTSTATION_CLAIM_CHANGED_CODE = "outstation_claim_changed";

export const OUTSTATION_CLAIM_CHANGED_MESSAGE =
  "This claim changed since you opened it. Refresh the page and review the new figures before deciding.";

export const OUTSTATION_CLAIM_REVISION_MISSING_MESSAGE =
  "This screen did not say which version of the claim you were looking at, so nothing was decided. " +
  "Refresh the page and try again.";

export type OutstationClaimChangedKind = "changed" | "missing";

/**
 * Thrown when a decision is refused because the claim is no longer the one the reviewer saw (or
 * because the screen never said which one it showed). Routes answer it with 409; the batch Save
 * turns it into a per-row skip with the same sentence.
 */
export class OutstationClaimChangedError extends Error {
  readonly code = OUTSTATION_CLAIM_CHANGED_CODE;
  readonly kind: OutstationClaimChangedKind;

  constructor(kind: OutstationClaimChangedKind = "changed") {
    super(kind === "missing" ? OUTSTATION_CLAIM_REVISION_MISSING_MESSAGE : OUTSTATION_CLAIM_CHANGED_MESSAGE);
    this.name = "OutstationClaimChangedError";
    this.kind = kind;
  }
}

/** Name-based as well as `instanceof`, so a class re-created by hot reload is still recognised. */
export function isOutstationClaimChangedError(error: unknown): error is OutstationClaimChangedError {
  return (
    error instanceof OutstationClaimChangedError ||
    (error instanceof Error && error.name === "OutstationClaimChangedError")
  );
}

/**
 * The claim's version token from a stored `updated_at` (any parseable timestamp, or a Date).
 * Millisecond ISO, so "2026-10-18T22:10:11.123+00:00" from the database and the same instant sent
 * back by a screen compare equal. Empty when there is no timestamp at all.
 */
export function outstationClaimRevision(updatedAt: unknown): string {
  const raw = updatedAt instanceof Date ? updatedAt.toISOString() : String(updatedAt ?? "").trim();
  if (!raw) return "";
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

/**
 * Refuses a decision unless the claim is still exactly the version the reviewer saw.
 *
 * Fails CLOSED in both directions: a screen that sent no token is refused ("missing"), and a claim
 * whose own timestamp cannot be read is refused ("changed") — an unknowable version is never
 * treated as an unchanged one.
 */
export function assertOutstationClaimUnchanged(input: { current: unknown; expected: unknown }): void {
  const expected = outstationClaimRevision(input.expected);
  if (!expected) throw new OutstationClaimChangedError("missing");
  const current = outstationClaimRevision(input.current);
  if (!current || current !== expected) throw new OutstationClaimChangedError("changed");
}
