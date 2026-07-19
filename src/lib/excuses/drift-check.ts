// Daily drift detector for excuse requests stuck on a resigned/missing manager. Structurally
// mirrors src/lib/weekly-planning/drift-check.ts: it reads v2_excuse_requests in `pending_manager`
// whose assigned manager is null / missing from the directory / resigned or inactive
// (cross-referenced against getEmployeeDirectoryRows), then alerts Super Admins with
// the real request list so HR can reassign the approver (Approvals Hub → Stuck approvals).
// Empty result → no notification (no zero-row spam). Idempotent via a per-recipient per-day key.

import { normalizeHrId } from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const ALERT_RECIPIENT_ROLES = ["Super Admin"] as const;

export type ExcuseManagerGapRecord = {
  requestId: string;
  employeeHrId: string;
  employeeName: string;
  managerHrId: string | null;
  managerName: string | null;
  excuseDate: string | null;
  createdAt: string | null;
};

// Active per the D4 SQL semantics used across the plan drift check: employment_status IN
// (active, on_leave); empty treated as active.
function isActiveEmploymentStatus(status: string | null | undefined) {
  const normalized = (status ?? "").trim().toLowerCase();
  return normalized === "" || normalized === "active" || normalized === "on_leave";
}

// Excuse requests awaiting a manager decision whose manager_hr_id is null / missing from the
// directory / resigned or inactive. Backs both the daily drift alert and the Approvals Hub
// "stuck approvals" surface. Read-only.
export async function listExcuseManagerGapRecords(): Promise<ExcuseManagerGapRecord[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("v2_excuse_requests")
    .select("id,employee_hr_id,employee_name,manager_hr_id,manager_name,excuse_date,created_at")
    .eq("status", "pending_manager");
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    employee_hr_id: string;
    employee_name: string | null;
    manager_hr_id: string | null;
    manager_name: string | null;
    excuse_date: string | null;
    created_at: string | null;
  }>;
  if (rows.length === 0) return [];

  // includeInactive:true so a resigned/inactive manager (present but not active) and a missing
  // manager (absent) are both correctly flagged as gaps.
  const directoryRows = await getEmployeeDirectoryRows({ includeInactive: true });
  const statusByHrId = new Map<string, string | null>();
  for (const emp of directoryRows) {
    const key = normalizeHrId(emp.hrId);
    if (key) statusByHrId.set(key, emp.employmentStatus);
  }

  const gaps: ExcuseManagerGapRecord[] = [];
  for (const row of rows) {
    const managerKey = normalizeHrId(row.manager_hr_id);
    const managerActive =
      !!managerKey &&
      statusByHrId.has(managerKey) &&
      isActiveEmploymentStatus(statusByHrId.get(managerKey) ?? null);
    if (!managerActive) {
      gaps.push({
        requestId: row.id,
        employeeHrId: row.employee_hr_id,
        employeeName: row.employee_name ?? row.employee_hr_id,
        managerHrId: row.manager_hr_id,
        managerName: row.manager_name,
        excuseDate: row.excuse_date,
        createdAt: row.created_at,
      });
    }
  }
  return gaps;
}

async function resolveDriftAlertRecipients(): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("hr_id")
    .in("role", ALERT_RECIPIENT_ROLES as unknown as string[])
    .eq("is_active", true);
  if (error) return [];
  const hrIds = new Set<string>();
  (data ?? []).forEach((row) => {
    const hrId = String((row as { hr_id?: unknown }).hr_id ?? "").trim();
    if (hrId) hrIds.add(hrId);
  });
  return Array.from(hrIds);
}

export type ExcuseDriftResult =
  | { ok: true; anomalies: number; sentCount: number }
  | { ok: false; anomalies: 0; sentCount: 0; error: string };

/** Top-level entry — wired into the daily-cron Promise.all alongside runWeeklyPlansDriftCheck. */
export async function runExcuseDriftCheck(): Promise<ExcuseDriftResult> {
  try {
    const gapRecords = await listExcuseManagerGapRecords();
    if (gapRecords.length === 0) {
      return { ok: true, anomalies: 0, sentCount: 0 };
    }

    const total = gapRecords.length;
    const lines: string[] = [
      `${total} pending excuse ${total === 1 ? "request is" : "requests are"} stuck on a resigned or missing manager.`,
      "",
      "Reassign the approver in Approvals Hub → Stuck approvals:",
    ];
    for (const record of gapRecords.slice(0, 25)) {
      const manager = record.managerName ?? record.managerHrId ?? "no manager";
      lines.push(
        `- ${record.employeeName} (${record.employeeHrId}) — ${record.excuseDate ?? "date n/a"} — approver: ${manager}`,
      );
    }
    if (total > 25) lines.push(`…and ${total - 25} more.`);
    lines.push("");
    lines.push("Dashboard: /admin/approvals/stuck");

    const title = `Excuse Approver Gap: ${total} stuck request${total === 1 ? "" : "s"}`;
    const message = lines.join("\n");
    const today = new Date().toISOString().slice(0, 10);

    const recipients = await resolveDriftAlertRecipients();
    let sentCount = 0;
    for (const recipientHrId of recipients) {
      const result = await createSystemNotification({
        actionUrl: "/admin/approvals/stuck",
        category: "excuse",
        eventType: "drift_alert",
        message,
        metadata: {
          anomalies: total,
          idempotencyKey: `excuse_manager_gap:${recipientHrId}:${today}`,
        },
        module: "excuse",
        priority: "high",
        recipientHrId,
        title,
      });
      if (result.deliveries.some((delivery) => delivery.status === "sent")) sentCount += 1;
    }

    return { ok: true, anomalies: total, sentCount };
  } catch (error) {
    return {
      ok: false,
      anomalies: 0,
      sentCount: 0,
      error: error instanceof Error ? error.message : "Excuse drift check failed.",
    };
  }
}
