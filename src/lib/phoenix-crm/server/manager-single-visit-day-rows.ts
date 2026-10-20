/**
 * Phoenix CRM — a district manager's ask for a second or third day of single visits, as it is stored
 * (`phoenix_crm_manager_single_visit_days`, owner 2026-10-20): the row shape and the plain reads.
 *
 * His first day of single visits a week needs no approval. For another he asks for ONE named date; his
 * regional manager and then the national sales manager above him approve it (or the national sales
 * manager alone where there is no regional manager), and an approved date holds single visits — planned
 * and logged — on both its halves (`dmSingleVisitCapError`). Two such dates a week at most.
 *
 * 🔴 NO NOTICE SENDER IS IMPORTED HERE, AND NONE MAY BE — the Approvals Hub's queue reads these rows
 * (`manager-plan-queue.ts`), and the notification layer imports the Hub's reader. The writes and their
 * notices live in `manager-single-visit-days.ts`.
 */

import { isSingleVisitDayAskStatus, type SingleVisitDayAskStatus } from "@/lib/phoenix-crm/manager-plan-rules";
import { personKey } from "@/lib/phoenix-crm/scope";
import { textOrNull } from "@/lib/phoenix-crm/server/db";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

export const SINGLE_VISIT_DAY_COLUMNS =
  "id, manager_hr_id, manager_seat_id, week_start, visit_date, reason, status, approver_hr_id, second_approver_hr_id, first_decided_at, first_decided_by_hr_id, first_decided_role, first_decision_note, decided_at, decided_by_hr_id, decided_role, decision_note, version, is_test, created_at";

export type SingleVisitDayAskRow = {
  requestId: string;
  managerHrId: string;
  managerSeatId: string | null;
  weekStart: string;
  visitDate: string;
  /** Optional (owner, 2026-10-20: "make writing why optional"). */
  reason: string | null;
  status: SingleVisitDayAskStatus;
  approverHrId: string | null;
  secondApproverHrId: string | null;
  firstDecidedAt: string | null;
  firstDecidedByHrId: string | null;
  firstDecidedRole: string | null;
  firstDecisionNote: string | null;
  decidedAt: string | null;
  decidedByHrId: string | null;
  decidedRole: string | null;
  decisionNote: string | null;
  version: number;
  isTest: boolean;
  createdAt: string | null;
};

function dayOf(value: unknown): string | null {
  const text = textOrNull(value);
  return text ? text.slice(0, 10) : null;
}

export function singleVisitDayAskRowOf(raw: unknown): SingleVisitDayAskRow | null {
  const row = (raw && typeof raw === "object" ? raw : {}) as Row;
  const requestId = textOrNull(row.id);
  const managerHrId = personKey(textOrNull(row.manager_hr_id));
  const weekStart = dayOf(row.week_start);
  const visitDate = dayOf(row.visit_date);
  const status: SingleVisitDayAskStatus | null = isSingleVisitDayAskStatus(row.status) ? row.status : null;
  if (!requestId || !managerHrId || !weekStart || !visitDate || !status) return null;
  return {
    requestId,
    managerHrId,
    managerSeatId: textOrNull(row.manager_seat_id),
    weekStart,
    visitDate,
    reason: textOrNull(row.reason),
    status,
    approverHrId: personKey(textOrNull(row.approver_hr_id)),
    secondApproverHrId: personKey(textOrNull(row.second_approver_hr_id)),
    firstDecidedAt: textOrNull(row.first_decided_at),
    firstDecidedByHrId: personKey(textOrNull(row.first_decided_by_hr_id)),
    firstDecidedRole: textOrNull(row.first_decided_role),
    firstDecisionNote: textOrNull(row.first_decision_note),
    decidedAt: textOrNull(row.decided_at),
    decidedByHrId: personKey(textOrNull(row.decided_by_hr_id)),
    decidedRole: textOrNull(row.decided_role),
    decisionNote: textOrNull(row.decision_note),
    version: Number(row.version ?? 1),
    isTest: row.is_test === true,
    createdAt: textOrNull(row.created_at),
  };
}

const byId = { cursorColumn: "id", cursorOf: (row: Row) => String(row.id) };

function rowsOf(rows: Row[]): SingleVisitDayAskRow[] {
  return rows.map(singleVisitDayAskRowOf).filter((row): row is SingleVisitDayAskRow => row !== null);
}

/** One ask by its id, in either world — the caller checks the world. */
export async function loadSingleVisitDayAskRow(requestId: string): Promise<SingleVisitDayAskRow | null> {
  const rows = await fetchAllRowsKeyset<Row>(
    () => getSupabaseAdmin().from("phoenix_crm_manager_single_visit_days").select(SINGLE_VISIT_DAY_COLUMNS).eq("id", requestId),
    byId,
  );
  return rowsOf(rows)[0] ?? null;
}

/** Every ask he made for the days of these weeks, newest first. */
export async function loadSingleVisitDayAsks(input: { managerHrId: string; weekStarts: ReadonlyArray<string>; isTest: boolean }): Promise<SingleVisitDayAskRow[]> {
  if (input.weekStarts.length === 0) return [];
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_manager_single_visit_days")
        .select(SINGLE_VISIT_DAY_COLUMNS)
        .eq("manager_hr_id", input.managerHrId)
        .in("week_start", [...input.weekStarts])
        .eq("is_test", input.isTest),
    byId,
  );
  return rowsOf(rows).sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")));
}

/** The dates of one week his managers APPROVED for single visits — what the limit reads. */
export async function loadApprovedSingleVisitDates(input: { managerHrId: string; weekStart: string; isTest: boolean }): Promise<Set<string>> {
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_manager_single_visit_days")
        .select("id, visit_date")
        .eq("manager_hr_id", input.managerHrId)
        .eq("week_start", input.weekStart)
        .eq("status", "approved")
        .eq("is_test", input.isTest),
    byId,
  );
  return new Set(rows.map((row) => dayOf(row.visit_date)).filter((date): date is string => date !== null));
}

/** Every ask still waiting on somebody, in one world. The caller drops one whose date has passed. */
export async function loadOpenSingleVisitDayAsks(isTest: boolean): Promise<SingleVisitDayAskRow[]> {
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_manager_single_visit_days")
        .select(SINGLE_VISIT_DAY_COLUMNS)
        .in("status", ["pending", "first_approved"])
        .eq("is_test", isTest),
    byId,
  );
  return rowsOf(rows);
}

/** Every ask he made, in one world. */
export async function loadSingleVisitDayAsksOf(managerHrId: string, isTest: boolean): Promise<SingleVisitDayAskRow[]> {
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_manager_single_visit_days")
        .select(SINGLE_VISIT_DAY_COLUMNS)
        .eq("manager_hr_id", managerHrId)
        .eq("is_test", isTest),
    byId,
  );
  return rowsOf(rows);
}

/** Every ask this person decided a step of — the last step, or the first a regional manager agreed to. */
export async function loadSingleVisitDayAsksDecidedBy(hrId: string, isTest: boolean): Promise<SingleVisitDayAskRow[]> {
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_manager_single_visit_days")
        .select(SINGLE_VISIT_DAY_COLUMNS)
        .or(`decided_by_hr_id.eq."${hrId}",first_decided_by_hr_id.eq."${hrId}"`)
        .eq("is_test", isTest),
    byId,
  );
  return rowsOf(rows);
}
