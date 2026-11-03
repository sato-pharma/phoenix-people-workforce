/**
 * Who has what waiting, read for a background job. The hub's own readers answer for one signed-in viewer, so they
 * cannot serve this. Every rule is in `./urgent-whatsapp-rules.ts`; this file only reads.
 *
 * 🔴 A FAILED READ THROWS, so the job's heartbeat records a failed run and never a calm zero.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { isExcuseExcludedRole } from "@/lib/excuses/service";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  DIRECT_ORDER_OPEN_STATUSES,
  EXCUSE_OPEN_STATUSES,
  LEAVE_OPEN_STATUSES,
  MARKETING_OPEN_STATUSES,
  tallyApprovers,
  waitingDirectOrderItems,
  waitingExcuseItems,
  waitingLeaveItems,
  waitingMarketingItems,
  type ApproverTally,
  type DirectStepRow,
  type ExcuseRow,
  type LeaveStepRow,
  type MarketingStepRow,
  type ParentRow,
} from "./urgent-whatsapp-rules";

/** PostgREST folds every `.in()` value into the request URL. */
const REQUEST_ID_BATCH = 100;

async function stepsFor<T>(supabase: SupabaseClient, table: string, columns: string, requestIds: readonly string[]): Promise<T[]> {
  const rows: T[] = [];
  for (let index = 0; index < requestIds.length; index += REQUEST_ID_BATCH) {
    const batch = requestIds.slice(index, index + REQUEST_ID_BATCH);
    rows.push(...(await fetchAllRows<T>(() => supabase.from(table).select(columns).in("request_id", batch), "id")));
  }
  return rows;
}

async function openParents(supabase: SupabaseClient, table: string, statuses: readonly string[]): Promise<ParentRow[]> {
  return fetchAllRows<ParentRow>(() => supabase.from(table).select("id, status").in("status", [...statuses]), "id");
}

export async function readApproverTally(now: Date, supabase: SupabaseClient = getSupabaseAdmin()): Promise<ApproverTally> {
  const [leaveParents, excuses, marketingParents, directParents, employees, logins] = await Promise.all([
    openParents(supabase, "v2_vacation_requests", LEAVE_OPEN_STATUSES),
    fetchAllRows<ExcuseRow>(
      () => supabase.from("v2_excuse_requests").select("id, status, manager_hr_id, created_at, updated_at").in("status", [...EXCUSE_OPEN_STATUSES]),
      "id",
    ),
    openParents(supabase, "marketing_requests", MARKETING_OPEN_STATUSES),
    openParents(supabase, "direct_order_requests", DIRECT_ORDER_OPEN_STATUSES),
    // 🔴 The whole master, keyed in code. `.in("hr_id", ids)` is case-sensitive and these ids are stored in mixed case.
    fetchAllRows<{ hr_id: string | null; employment_status: string | null; mobile_number: string | null }>(
      () => supabase.from("employees").select("hr_id, employment_status, mobile_number"),
      "hr_id",
    ),
    fetchAllRows<{ hr_id: string | null; role: string | null; is_active: boolean | null; is_test_persona: boolean | null }>(
      () => supabase.from("app_auth_users").select("hr_id, role, is_active, is_test_persona"),
      "login_id",
    ),
  ]);

  const [leaveSteps, marketingSteps, directSteps] = await Promise.all([
    stepsFor<LeaveStepRow>(
      supabase,
      "v2_vacation_approval_steps",
      "id, request_id, step_key, step_order, approver_hr_id, status, decided_at, updated_at",
      leaveParents.map((row) => row.id),
    ),
    stepsFor<MarketingStepRow>(
      supabase,
      "marketing_request_approval_steps",
      "id, request_id, assigned_hr_id, status, is_cc, updated_at",
      marketingParents.map((row) => row.id),
    ),
    stepsFor<DirectStepRow>(
      supabase,
      "direct_order_approval_steps",
      "id, request_id, step_order, approver_kind, approver_role, approver_hr_id, status, decided_at, updated_at",
      directParents.map((row) => row.id),
    ),
  ]);

  return tallyApprovers({
    items: [
      ...waitingLeaveItems(leaveParents, leaveSteps),
      ...waitingExcuseItems(excuses),
      ...waitingMarketingItems(marketingParents, marketingSteps),
      ...waitingDirectOrderItems(directParents, directSteps),
    ],
    logins: logins
      .filter((row) => row.hr_id && row.role && row.is_test_persona !== true)
      .map((row) => ({ hrId: String(row.hr_id), isActive: row.is_active === true, role: String(row.role) })),
    now,
    people: employees
      .filter((row) => row.hr_id)
      .map((row) => ({ active: isActiveLifecycleStatus(row.employment_status), hrId: String(row.hr_id), mobileNumber: row.mobile_number })),
    roleCanDecideExcuse: (role) => !isExcuseExcludedRole(role),
  });
}
