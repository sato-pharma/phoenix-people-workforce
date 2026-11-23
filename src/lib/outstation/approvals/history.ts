/**
 * History — what was already decided. Read only on a press, never with the page.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH"). The page it replaces loaded every trip ever
 * filed to draw the ones that waited. Two reads live here, each behind its own press:
 *
 *   - `loadDeskHistory` — the decided claims employees filed in Phoenix, newest decision first,
 *     50 at a time, with where each one stands (held, next payroll, in payroll, rejected).
 *   - `loadSheetHistory` — the trips that came from the expense sheets before employees filed in
 *     Phoenix. Values only: they are decided on the sheet workspace, whose own save path this does
 *     not touch.
 *
 * Scope is applied the same two ways as the queue. Nothing here is decided, and no figure is
 * derived: a decided claim reads its stored payroll row.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { buildDeskClaim, DESK_CLAIM_COLUMNS, requestIdOfRow, type ClaimRow } from "@/lib/outstation/approvals/claim-row";
import { readLedger, withLiveNames } from "@/lib/outstation/approvals/queue";
import type { DeskClaim } from "@/lib/outstation/approvals/types";
import { outstationRequestIdFromTripId } from "@/lib/outstation/expense-approval-decisions";
import { applyEmployeeHrIdInFilter, keepExpenseRowsInScope, listPayrollExpenses, resolveExpenseAccessFilter } from "@/lib/outstation/expenses";
import { payableExpenseAmount } from "@/lib/outstation/payable";
import { outstationPayrollTripId } from "@/lib/outstation/payroll-expense-mapping";
import { OUTSTATION_UNDECIDED_STATUSES } from "@/lib/outstation/undecided-claim";
import { rowSecurityClientFor } from "@/lib/supabase/rls-server";
import { ilikeAnyFilter } from "@/lib/supabase/search-filter";

export const HISTORY_PAGE_SIZE = 50;

export type DeskHistoryFilter = "all" | "approved" | "rejected";

export type DeskHistoryPage = {
  claims: DeskClaim[];
  /** Where the next press starts; null when this was the last page. */
  nextOffset: number | null;
  /** Every decided claim the filter matches, not only this page. */
  total: number;
};

const UNDECIDED_LIST = `(${OUTSTATION_UNDECIDED_STATUSES.join(",")})`;
const APPROVED_STATUS_FILTER = "status.ilike.%accept%,status.ilike.%approve%,status.ilike.%confirm%";
const REJECTED_STATUS_FILTER = "status.ilike.%reject%,status.ilike.%declin%";

/**
 * A search box's words, made safe for a filter string: letters of any script, digits, spaces and
 * hyphens survive, everything a filter could read as syntax is dropped. Pure.
 */
export function historySearchTerm(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

export function historyFilterOf(value: string | null | undefined): DeskHistoryFilter {
  return value === "approved" || value === "rejected" ? value : "all";
}

export async function loadDeskHistory(
  access: AccessContext,
  options: { filter?: DeskHistoryFilter; now?: Date; offset?: number; search?: string | null } = {},
): Promise<DeskHistoryPage> {
  const now = options.now ?? new Date();
  const offset = Math.max(0, Math.trunc(Number(options.offset) || 0));
  const filter = options.filter ?? "all";
  const search = historySearchTerm(options.search);

  const accessFilter = await resolveExpenseAccessFilter(access);
  const allowed = Array.from(accessFilter.allowedHrIds);
  if (!accessFilter.all && allowed.length === 0) return { claims: [], nextOffset: null, total: 0 };
  const supabase = await rowSecurityClientFor("outstation.approvalsDeskHistory");

  let query = supabase
    .from("outstation_expense_requests")
    .select(DESK_CLAIM_COLUMNS, { count: "exact" })
    .not("status", "in", UNDECIDED_LIST)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false });
  // Each `or` is its own condition; PostgREST joins them with AND.
  if (filter === "approved") query = query.or(APPROVED_STATUS_FILTER);
  if (filter === "rejected") query = query.or(REJECTED_STATUS_FILTER);
  // The one builder quotes the term (src/lib/supabase/search-filter.ts); an empty answer means no filter.
  const searchFilter = search ? ilikeAnyFilter(["employee_name", "employee_hr_id"], search) : "";
  if (searchFilter) query = query.or(searchFilter);
  if (!accessFilter.all) query = applyEmployeeHrIdInFilter(query, allowed);

  const { count, data, error } = await query.range(offset, offset + HISTORY_PAGE_SIZE - 1);
  if (error) throw error;
  const read = (data ?? []) as unknown as ClaimRow[];
  const rows = keepExpenseRowsInScope(read, accessFilter, "employee_hr_id");

  const ledger = await readLedger(supabase, rows.map((row) => outstationPayrollTripId(requestIdOfRow(row))));
  const today = currentCairoDateOnlyIso(now);
  const claims = await withLiveNames(
    rows.map((row) =>
      buildDeskClaim({ context: { today }, ledger: ledger.get(outstationPayrollTripId(requestIdOfRow(row))) ?? null, now, row }),
    ),
  );

  const total = count ?? offset + read.length;
  const next = offset + read.length;
  return { claims, nextOffset: read.length === HISTORY_PAGE_SIZE && next < total ? next : null, total };
}

/** One trip from the expense sheets. Values only. */
export type SheetTrip = {
  approved: boolean;
  employeeName: string;
  from: string;
  /** What it paid: the amount typed on the sheet workspace when one was, else the claim. */
  payable: number;
  payoutMonth: number;
  payoutYear: number;
  rejected: boolean;
  to: string;
  total: number;
  tripDate: string;
  tripId: string;
};

export async function loadSheetHistory(access: AccessContext): Promise<SheetTrip[]> {
  const rows = await listPayrollExpenses(undefined, undefined, undefined, access);
  return rows
    .filter((row) => outstationRequestIdFromTripId(row.tripId) === null)
    .map((row) => ({
      approved: Boolean(row.hrApproved),
      employeeName: row.specialist,
      from: row.from,
      payable: payableExpenseAmount(row.approvedAmount, row.total),
      payoutMonth: row.payoutMonth,
      payoutYear: row.payoutYear,
      rejected: /reject|declin/i.test(String(row.status ?? "")),
      to: row.to,
      total: row.total,
      tripDate: row.date,
      tripId: row.tripId,
    }));
}
