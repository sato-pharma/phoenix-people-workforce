/**
 * History — what was already decided. Read only on a press, never with the page.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH"). The page it replaces loaded every trip ever
 * filed to draw the ones that waited. Two reads live here, each behind its own press:
 *
 *   - `loadDeskHistory` — the decided claims employees filed in Phoenix, newest decision first,
 *     50 at a time, with where each one stands (held, next payroll, payroll already ran, in
 *     payroll, rejected).
 *   - `loadSheetHistory` — the trips that came from the expense sheets before employees filed in
 *     Phoenix. Values only: they are decided on the sheet workspace, whose own save path this does
 *     not touch.
 *
 * Scope is applied the same two ways as the queue. Nothing here is decided, and no figure is
 * derived: a decided claim reads its stored payroll row.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { claimKindFilter } from "@/lib/outstation/approvals/claim-kind";
import { buildDeskClaim, DESK_CLAIM_COLUMNS, requestIdOfRow, type ClaimRow } from "@/lib/outstation/approvals/claim-row";
import { historySearchTerm } from "@/lib/outstation/approvals/desk-view";
import { readLastPaidPayout, readLedger, withLiveNames } from "@/lib/outstation/approvals/queue";
import { dayAfter, tripPeriodOf } from "@/lib/outstation/approvals/trip-period";
import type { ClaimKind, DeskClaim } from "@/lib/outstation/approvals/types";
import { outstationRequestIdFromTripId } from "@/lib/outstation/expense-approval-decisions";
import { applyEmployeeHrIdInFilter, keepExpenseRowsInScope, listPayrollExpenses, resolveExpenseAccessFilter } from "@/lib/outstation/expenses";
import { payableExpenseAmount } from "@/lib/outstation/payable";
import { outstationPayrollTripId } from "@/lib/outstation/payroll-expense-mapping";
import { OUTSTATION_UNDECIDED_STATUSES } from "@/lib/outstation/undecided-claim";
import { rowSecurityClientFor } from "@/lib/supabase/rls-server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
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

// The search term lives with the desk view, so the tiles filter the decided trips exactly as this read does.
export { historySearchTerm };

export function historyFilterOf(value: string | null | undefined): DeskHistoryFilter {
  return value === "approved" || value === "rejected" ? value : "all";
}

export async function loadDeskHistory(
  access: AccessContext,
  options: {
    /**
     * Only how many decided claims the filters match, no rows: what an empty waiting lane says is
     * in History (owner, 23 Nov 2026, October picked: "I can see nothing … Of course, there's
     * something wrong" — every October claim was decided, and the lane never said where they were).
     * The same query with the same filters, asked for its count alone, so the two can never disagree.
     */
    countOnly?: boolean;
    filter?: DeskHistoryFilter;
    from?: string | null;
    kind?: ClaimKind | null;
    now?: Date;
    offset?: number;
    search?: string | null;
    to?: string | null;
  } = {},
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
    .select(DESK_CLAIM_COLUMNS, { count: "exact", head: options.countOnly === true })
    .not("status", "in", UNDECIDED_LIST)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false });
  // Each `or` is its own condition; PostgREST joins them with AND.
  if (filter === "approved") query = query.or(APPROVED_STATUS_FILTER);
  if (filter === "rejected") query = query.or(REJECTED_STATUS_FILTER);
  // The kind the desk is narrowed to (owner, 2026-11-23): one stored type, or every type that is not one of the other two.
  const kindFilter = options.kind ? claimKindFilter(options.kind) : null;
  if (kindFilter && "or" in kindFilter) query = query.or(kindFilter.or);
  else if (kindFilter) query = query.ilike(kindFilter.column, kindFilter.pattern);
  // The trip dates the desk is narrowed to (owner, 2026-11-23): a trip is listed when any of its days is
  // inside the period — it ended on or after From and began on or before To. The days are stored as
  // midnight UTC (all 363 rows on 23 Nov 2026), so "before the day after To" keeps the whole last day.
  const period = tripPeriodOf(options.from, options.to);
  // A trip with no end date is a one-day trip on its start day, as `claimInPeriod` reads it on the lanes.
  if (period.from) query = query.or(`trip_end_date.gte.${period.from},and(trip_end_date.is.null,trip_start_date.gte.${period.from})`);
  if (period.to) query = query.lt("trip_start_date", dayAfter(period.to));
  // The one builder quotes the term (src/lib/supabase/search-filter.ts); an empty answer means no filter.
  const searchFilter = search ? ilikeAnyFilter(["employee_name", "employee_hr_id"], search) : "";
  if (searchFilter) query = query.or(searchFilter);
  if (!accessFilter.all) query = applyEmployeeHrIdInFilter(query, allowed);

  const { count, data, error } = await query.range(offset, offset + HISTORY_PAGE_SIZE - 1);
  if (error) throw error;
  if (options.countOnly === true) return { claims: [], nextOffset: null, total: count ?? 0 };
  const read = (data ?? []) as unknown as ClaimRow[];
  const rows = keepExpenseRowsInScope(read, accessFilter, "employee_hr_id");

  const [ledger, lastPaidPayout] = await Promise.all([
    readLedger(supabase, rows.map((row) => outstationPayrollTripId(requestIdOfRow(row)))),
    readLastPaidPayout(supabase),
  ]);
  const today = currentCairoDateOnlyIso(now);
  const claims = await withLiveNames(
    rows.map((row) =>
      buildDeskClaim({ context: { lastPaidPayout, today }, ledger: ledger.get(outstationPayrollTripId(requestIdOfRow(row))) ?? null, now, row }),
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
  /**
   * Filed in Phoenix, but its request was deleted after payroll took it: the payroll row is all
   * that is left, so it is listed here, said so, rather than nowhere.
   */
  requestDeleted: boolean;
  to: string;
  total: number;
  tripDate: string;
  tripId: string;
};

/**
 * Which payroll rows the sheet list shows: every row that did not come from a request, and every
 * row whose request no longer exists. A row whose request still exists is shown by the desk
 * itself, so it is left out here and never listed twice. Pure.
 *
 * Owner, 23 Nov 2026: "Expense page is not showing all the expenses … Where are the rest of the
 * requests of the people?" — read that night: 9 approved trips (April to June 2026, three people)
 * stood in payroll as `OUTSTATION-<id>` with their request deleted. The desk could not show them
 * (no request) and this list dropped them (a request's trip id), so they were on no screen at all.
 */
export function sheetHistoryRows<T extends { tripId: string }>(
  rows: ReadonlyArray<T>,
  existingRequestIds: ReadonlySet<number>,
): Array<{ requestDeleted: boolean; row: T }> {
  const kept: Array<{ requestDeleted: boolean; row: T }> = [];
  for (const row of rows) {
    const requestId = outstationRequestIdFromTripId(row.tripId);
    if (requestId === null) kept.push({ requestDeleted: false, row });
    else if (!existingRequestIds.has(requestId)) kept.push({ requestDeleted: true, row });
  }
  return kept;
}

/**
 * The request ids that still exist, out of the ones the payroll rows name. Ids only: the rows
 * asking were already narrowed to the reader's scope by `listPayrollExpenses`, so the plain
 * client reads nothing they could not see — and a request hidden from a narrower client must
 * never read as deleted and be listed twice. A failed read throws rather than guessing.
 */
async function readExistingRequestIds(ids: number[]): Promise<Set<number>> {
  const existing = new Set<number>();
  if (ids.length === 0) return existing;
  const supabase = getSupabaseAdmin();
  for (let start = 0; start < ids.length; start += 500) {
    const { data, error } = await supabase.from("outstation_expense_requests").select("id").in("id", ids.slice(start, start + 500));
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: number | string }>) existing.add(Number(row.id));
  }
  return existing;
}

export async function loadSheetHistory(access: AccessContext): Promise<SheetTrip[]> {
  const rows = await listPayrollExpenses(undefined, undefined, undefined, access);
  const requestIds = Array.from(
    new Set(rows.map((row) => outstationRequestIdFromTripId(row.tripId)).filter((id): id is number => id !== null)),
  );
  const existing = await readExistingRequestIds(requestIds);
  return sheetHistoryRows(rows, existing)
    .map(({ requestDeleted, row }) => ({
      requestDeleted,
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
