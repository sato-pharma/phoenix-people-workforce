/**
 * Whether the outstation expenses read is served from `expense_claims` instead of the two-table
 * union. Phase 2's read switch; OFF unless PHOENIX_EXPENSE_CLAIMS_READ is exactly "true".
 *
 * THIS IS ITS OWN MODULE, AND IT IMPORTS NOTHING. That is the entire point.
 *
 * `expenses.ts` has to answer this question BEFORE deciding whether to load `claims-read.ts`, and
 * `claims-read.ts` imports `resolveExpenseAccessFilter` and `applyEmployeeHrIdInFilter` back from
 * `expenses.ts`. Putting the flag in a module with no imports of its own lets both sides read the
 * same definition without either having to load the other — so the default-off path never touches
 * `claims-read.ts` at all.
 *
 * Keeping it as ONE definition matters more than where it lives: a second copy of an env-var name
 * is how a flag ends up half-on, read as true by one caller and false by another.
 */
export function expenseClaimsReadEnabled(): boolean {
  return String(process.env.PHOENIX_EXPENSE_CLAIMS_READ ?? "").trim().toLowerCase() === "true";
}
