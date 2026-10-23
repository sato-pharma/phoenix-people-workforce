/**
 * Phoenix CRM — the Super Admin deletes a plan, a visit or a day record as if it never happened.
 *
 * Owner, 2026-10-23. The rules are in `@/lib/phoenix-crm/admin-delete-rules`; this file is their I/O.
 *
 * 🔴 THE SUPER ADMIN ALONE, AND NEVER A TEST PERSONA — `canEnterMissedRecords`, the same gate as entering,
 * correcting and removing a record, so the route's `update` grant is not enough on its own.
 *
 * 🔴 NOTHING IS LOST: `phoenix_crm_admin_delete` keeps the record and everything that hung off it in
 * `phoenix_crm_admin_deletions` before it deletes a row, all in one transaction.
 *
 * 🔴 NOTICES ARE WITHDRAWN AFTER, NEVER BEFORE: the database decides whether the record may go at all, so
 * withdrawing first would take a notice back from a manager whose record is still there. Both helpers
 * swallow their own failures, so a notice that cannot be withdrawn still leaves the record deleted.
 * It tells the rep and the managers nothing (Golden Rule #1): the record is simply not there.
 */

import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { parseAdminDelete, type AdminDeleteKind } from "@/lib/phoenix-crm/admin-delete-rules";
import { canEnterMissedRecords, readTestFlag, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm } from "@/lib/phoenix-crm/server/db";
import { withdrawPhoenixCrmPlanNotices, withdrawPhoenixCrmVisitNotices } from "@/lib/phoenix-crm/server/notifications";

type Row = Record<string, unknown>;

export type AdminDeleted = { deleted: true; kind: AdminDeleteKind; id: string };

export async function adminDeleteRecord(viewer: PhoenixCrmViewer, raw: unknown): Promise<AdminDeleted> {
  if (!canEnterMissedRecords(viewer)) throw forbiddenError("Only the Super Admin deletes a record.");
  const parsed = parseAdminDelete(raw);
  if (!parsed.ok) throw validationError(parsed.error);
  const { kind, id } = parsed.value;
  const isTest = readTestFlag((raw as Row).test);

  const result = await callPhoenixCrm<Row>("phoenix_crm_admin_delete", {
    p: { kind, id, actor_hr_id: viewer.hrId, is_test: isTest },
  });

  if (kind === "monthly_plan") {
    // The month's own notices, then each week it took with it (with the requests to edit that week).
    await withdrawPhoenixCrmPlanNotices({ kind, planId: id, editRequestIds: [] });
    const weeks = Array.isArray(result.weeks) ? (result.weeks as Row[]) : [];
    for (const week of weeks) {
      const requestIds = Array.isArray(week.edit_request_ids) ? week.edit_request_ids.map(String) : [];
      await withdrawPhoenixCrmPlanNotices({ kind: "rep_plan", planId: String(week.id), editRequestIds: requestIds });
    }
  } else if (kind === "rep_plan" || kind === "manager_plan") {
    const requestIds = Array.isArray(result.edit_request_ids) ? result.edit_request_ids.map(String) : [];
    await withdrawPhoenixCrmPlanNotices({ kind, planId: id, editRequestIds: requestIds });
  } else if (kind === "visit") {
    // The visit and any visit linked from it: each had its own notices.
    const visitIds = Array.isArray(result.visit_ids) ? result.visit_ids.map(String) : [id];
    for (const visitId of visitIds) await withdrawPhoenixCrmVisitNotices(visitId);
  }

  return { deleted: true, kind, id };
}
