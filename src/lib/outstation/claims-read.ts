/**
 * PHASE 2 read path over `expense_claims` — OFF by default.
 *
 * The target architecture replaces `outstation_expense_requests` + `outstation_expenses` with one
 * table (see OUTSTATION_EXPENSES_TARGET_ARCHITECTURE.md). Phase 2 runs both models side by side:
 * writes still go to the legacy tables, `phx_refresh_expense_claims()` keeps this one current, and
 * `v_expense_claims_parity` proves they agree. This module is the read half of that comparison.
 *
 * Two deliberate constraints:
 *
 *   1. **It returns the EXISTING `PayrollExpenseApproval` shape**, not a new one. Phase 2 is about
 *      proving the data matches, not about changing what callers see. A new shape here would mean
 *      every consumer had to change at the same moment as the data source, which is precisely the
 *      big-bang cutover the phased plan exists to avoid.
 *
 *   2. **It reuses `resolveExpenseAccessFilter` / `applyEmployeeHrIdInFilter` from expenses.ts** rather than
 *      re-deriving who may see what. Outstation visibility is application-scoped, not RLS-scoped
 *      (every path runs as service-role), so a second, subtly different copy of the scope rule is
 *      how a manager ends up seeing another line's claims. There is exactly one scope rule.
 *
 * The flag defaults to OFF, so merging this changes nothing until `PHOENIX_EXPENSE_CLAIMS_READ` is
 * set. Flipping it back is the rollback.
 */

import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { rowSecurityClientFor } from "@/lib/supabase/rls-server";
import type { AccessContext } from "@/lib/auth/permissions";
import type { PayrollExpenseApproval } from "@/lib/payroll/types";

// applyEmployeeHrIdInFilter, NOT applyHrIdInFilter: the latter hardcodes `hr_id`, which is the
// legacy ledger's column. `expense_claims` keys on `employee_hr_id`.
import {
  applyEmployeeHrIdInFilter,
  keepExpenseRowsInScope,
  resolveExpenseAccessFilter,
} from "@/lib/outstation/expenses";

/** Column list kept explicit: a `select *` here would silently pick up phase-3 columns. */
const CLAIM_COLUMNS = [
  "claim_ref",
  "employee_hr_id",
  "employee_name",
  "source",
  "status",
  "transportation_type",
  "expense_type",
  "trip_start_date",
  "trip_end_date",
  "destination_label",
  "distance_km",
  "fuel_amount",
  "allowance_amount",
  "ticket_go_amount",
  "ticket_return_amount",
  "meeting_amount",
  "other_amount",
  "claimed_total",
  "approved_total",
  "decided_by_hr_id",
  "decided_at",
  "decision_reason",
  "payout_year",
  "payout_month",
  "data_quality_hold",
  "data_quality_reason",
].join(",");

/**
 * Whether the new model is the read source.
 *
 * Environment-driven and default-false on purpose: phase 2 is an observation window, and the
 * decision to trust the new model is the owner's, not a deploy's.
 *
 * The implementation moved to `claims-read-flag.ts`, which imports nothing, so `expenses.ts` can
 * check the flag WITHOUT loading this module — see that file for why that matters. Re-exported here
 * because this is where a reader looks for it.
 */
export { expenseClaimsReadEnabled } from "@/lib/outstation/claims-read-flag";

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isoOrEmpty(value: unknown): string {
  const raw = toText(value);
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

/**
 * One claim row in the shape the existing approvals surfaces already consume.
 *
 * `hrApproved` is derived from the single `status` column rather than from a separate boolean —
 * that collapse is the whole point of the new model. `approvedAmount` stays null when HR never
 * moved the figure, matching `payableExpenseAmount`'s contract exactly, so a claim reads the same
 * amount through either model.
 */
function mapClaimToPayrollApproval(row: Record<string, unknown>): PayrollExpenseApproval {
  const status = toText(row.status);
  const claimedTotal = toNumber(row.claimed_total);
  const approvedTotal = row.approved_total == null ? null : toNumber(row.approved_total);
  const destination = toText(row.destination_label);

  return {
    allowance: toNumber(row.allowance_amount),
    amWorkload: 0,
    approvedAmount:
      approvedTotal === null || Math.abs(approvedTotal - claimedTotal) < 0.005 ? null : approvedTotal,
    approvedAt: row.decided_at ? isoOrEmpty(row.decided_at) : null,
    approvedBy: row.decided_by_hr_id ? toText(row.decided_by_hr_id) : null,
    date: isoOrEmpty(row.trip_start_date),
    description: toText(row.decision_reason) || "Outstation expense claim",
    from: "Residence",
    hr: status === "approved" ? "Approved" : status === "rejected" ? "Rejected" : "Pending",
    hrApproved: status === "approved",
    hrComment: toText(row.decision_reason),
    hrId: toText(row.employee_hr_id) || null,
    hrNotes: toText(row.data_quality_reason),
    km: toNumber(row.distance_km),
    location: destination,
    meetingAmount: toNumber(row.meeting_amount),
    other: toNumber(row.other_amount),
    payoutMonth: toNumber(row.payout_month),
    payoutYear: toNumber(row.payout_year),
    pmWorkload: 0,
    // The new model has no synthetic report per approval — that fiction is exactly what phase 3
    // deletes — so a claim carries no reportId. Imports keep theirs on `import_id`.
    reportId: null,
    requestType: "Outstation",
    row: 0,
    sourceFileName: toText(row.source),
    specialist: toText(row.employee_name),
    status: status === "approved" ? "Approved" : status === "rejected" ? "Rejected" : "",
    to: destination,
    toDate: isoOrEmpty(row.trip_end_date),
    total: claimedTotal,
    transportationType: toText(row.transportation_type),
    travelCost:
      toNumber(row.fuel_amount) + toNumber(row.ticket_go_amount) + toNumber(row.ticket_return_amount),
    tripId: toText(row.claim_ref),
    tripType: toText(row.expense_type),
  };
}

/**
 * The phase-2 equivalent of `listUnifiedOutstationExpenses` — one table, no union, no dedup.
 *
 * The legacy function had to read two tables, drop the duplicates one shadows in the other, and
 * carry HR's stored figure back across the gap. None of that exists here, which is the clearest
 * single measure of what the new model buys.
 */
export async function listExpenseClaims(
  month: number | undefined,
  year: number | undefined,
  accessContext: AccessContext,
): Promise<PayrollExpenseApproval[]> {
  const accessFilter = await resolveExpenseAccessFilter(accessContext);
  const supabase = await rowSecurityClientFor("outstation.listExpenseClaims");

  const allowedHrIds = Array.from(accessFilter.allowedHrIds);
  if (!accessFilter.all && allowedHrIds.length === 0) return [];

  // Paged: one read is cut at 1,000 rows by the API, which would silently drop the oldest claims.
  // A FRESH query per page, filtered and ordered the same way each time; `claim_ref` (unique) is the
  // tiebreak so a day shared by several trips cannot lose or repeat a row between pages.
  const buildQuery = () => {
    let query = supabase
      .from("expense_claims")
      .select(CLAIM_COLUMNS)
      .order("trip_start_date", { ascending: false });

    if (!accessFilter.all) query = applyEmployeeHrIdInFilter(query, allowedHrIds);

    // Period filtering happens in the QUERY, not in memory. The legacy path loaded every request and
    // filtered afterwards (see listOutstationRequestExpenses), which is why a period view still paid
    // for the whole table.
    if (month && year) {
      query = query.eq("payout_month", month).eq("payout_year", year);
    }
    return query;
  };
  const data = await fetchAllRows<Record<string, unknown>>(buildQuery, "claim_ref");

  return keepExpenseRowsInScope(data, accessFilter, "employee_hr_id").map(mapClaimToPayrollApproval);
}

/** Parity row as `v_expense_claims_parity` exposes it. */
export type ExpenseClaimParityRow = {
  claimRef: string;
  verdict: string;
  newStatus: string | null;
  legacyStatus: string | null;
  newClaimed: number | null;
  legacyClaimed: number | null;
  newApproved: number | null;
  legacyApproved: number | null;
};

/**
 * Every claim where the two models disagree. Empty is the gate for phase 3.
 *
 * Read straight from the view so the comparison is one query rather than two full reads diffed in
 * Node — the diff has to be cheap enough to run on every check, or it will not be run.
 */
export async function listExpenseClaimParityBreaks(): Promise<ExpenseClaimParityRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("v_expense_claims_parity")
    .select("claim_ref,verdict,new_status,legacy_status,new_claimed,legacy_claimed,new_approved,legacy_approved")
    .neq("verdict", "OK");

  if (error) throw error;

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    claimRef: toText(row.claim_ref),
    legacyApproved: row.legacy_approved == null ? null : toNumber(row.legacy_approved),
    legacyClaimed: row.legacy_claimed == null ? null : toNumber(row.legacy_claimed),
    legacyStatus: row.legacy_status == null ? null : toText(row.legacy_status),
    newApproved: row.new_approved == null ? null : toNumber(row.new_approved),
    newClaimed: row.new_claimed == null ? null : toNumber(row.new_claimed),
    newStatus: row.new_status == null ? null : toText(row.new_status),
    verdict: toText(row.verdict),
  }));
}
