// Daily drift detector for weekly/monthly plans — the morning job `weekly-plans-drift` (/api/cron/daily/weekly-plans-drift).
// Runs phx_weekly_plans_drift_check() (read-only RPC) and alerts the admin-configured recipient
// roles (see notification_role_policies, key "weekly_plans_drift_alert") when any of the 6
// impossible-state queries returns a non-zero count.
// Empty result → no notification (no zero-row spam). Idempotent via dedupe key.

import { normalizeHrId } from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { createSystemNotification } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { resolveNotificationRoleRecipients } from "@/lib/notifications/role-recipients";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type DriftCounts = Record<"D1" | "D2" | "D3" | "D4" | "D5" | "D6", number>;

// Plan statuses awaiting a manager decision — the exact set the D4 detector flags.
const MANAGER_GAP_PLAN_STATUSES = ["submitted", "manager_returned", "ceo_returned"] as const;

export type WeeklyPlanManagerGapRecord = {
  planId: string;
  employeeHrId: string;
  employeeName: string;
  managerHrId: string | null;
  managerName: string | null;
  status: string;
  submittedAt: string | null;
};

// Active per the D4 SQL semantics: employment_status IN (active, on_leave); empty treated as active.
function isActiveEmploymentStatus(status: string | null | undefined) {
  const normalized = (status ?? "").trim().toLowerCase();
  return normalized === "" || normalized === "active" || normalized === "on_leave";
}

// JS-client twin of the D4 drift detector (scripts/weekly-plans-drift.sql): plans awaiting a
// manager decision whose manager_hr_id is null / missing from the directory / resigned or inactive.
// Enriches the D4 alert with real plan IDs + links and backs the Approvals Hub "stuck approvals"
// surface. Read-only — it never touches the SQL RPC.
export async function listWeeklyPlanManagerGapRecords(): Promise<WeeklyPlanManagerGapRecord[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("employee_plan_headers")
    .select("id,employee_hr_id,employee_name,manager_hr_id,manager_name,status,submitted_at")
    .in("status", MANAGER_GAP_PLAN_STATUSES as unknown as string[]);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    employee_hr_id: string;
    employee_name: string | null;
    manager_hr_id: string | null;
    manager_name: string | null;
    status: string;
    submitted_at: string | null;
  }>;
  if (rows.length === 0) return [];

  // includeInactive:true so we can tell "resigned/inactive" (present but not active) apart from
  // "missing" — both are gaps, matching D4's (manager IS NULL OR e.hr_id IS NULL OR status NOT IN…).
  const directoryRows = await getEmployeeDirectoryRows({ includeInactive: true });
  const statusByHrId = new Map<string, string | null>();
  for (const emp of directoryRows) {
    const key = normalizeHrId(emp.hrId);
    if (key) statusByHrId.set(key, emp.employmentStatus);
  }

  const gaps: WeeklyPlanManagerGapRecord[] = [];
  for (const row of rows) {
    const managerKey = normalizeHrId(row.manager_hr_id);
    const managerActive =
      !!managerKey &&
      statusByHrId.has(managerKey) &&
      isActiveEmploymentStatus(statusByHrId.get(managerKey) ?? null);
    if (!managerActive) {
      gaps.push({
        planId: row.id,
        employeeHrId: row.employee_hr_id,
        employeeName: row.employee_name ?? row.employee_hr_id,
        managerHrId: row.manager_hr_id,
        managerName: row.manager_name,
        status: row.status,
        submittedAt: row.submitted_at,
      });
    }
  }
  return gaps;
}

const DRIFT_DESCRIPTIONS: Record<keyof DriftCounts, string> = {
  D1: "final_approved plans missing final_approved_at timestamp",
  D2: "advanced-status plans missing submitted_at timestamp",
  D3: "manager decision actor/timestamp mismatch (XOR violation)",
  D4: "plans awaiting manager decision with NULL/terminated manager",
  D5: "header status does not match most recent decision row",
  D6: "hr_acknowledged plans with no acknowledgement row",
};

async function resolveDriftAlertRecipients(): Promise<string[]> {
  const roles = await resolveNotificationRoleRecipients("weekly_plans_drift_alert");
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("hr_id")
    .in("role", roles)
    .eq("is_active", true);
  if (error) return [];
  const hrIds = new Set<string>();
  (data ?? []).forEach((row) => {
    const hrId = String((row as { hr_id?: unknown }).hr_id ?? "").trim();
    if (hrId) hrIds.add(hrId);
  });
  return Array.from(hrIds);
}

export type WeeklyPlansDriftResult =
  | { ok: true; anomalies: number; driftCodes: string[]; sentCount: number }
  | { ok: false; anomalies: 0; driftCodes: []; sentCount: 0; error: string };

/** Top-level entry — wired into the daily-cron Promise.all. */
export async function runWeeklyPlansDriftCheck(): Promise<WeeklyPlansDriftResult> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc("phx_weekly_plans_drift_check");
    if (error) throw error;

    const counts = (data ?? {}) as DriftCounts;
    const anomalous = (Object.entries(counts) as [keyof DriftCounts, number][]).filter(([, n]) => n > 0);
    if (anomalous.length === 0) {
      return { ok: true, anomalies: 0, driftCodes: [], sentCount: 0 };
    }

    const totalAnomalies = anomalous.reduce((sum, [, n]) => sum + n, 0);
    const driftCodes = anomalous.map(([code]) => code);

    const lines: string[] = [
      `${totalAnomalies} impossible-state ${totalAnomalies === 1 ? "row was" : "rows were"} found in employee_plan_headers.`,
      "",
    ];
    anomalous.forEach(([code, count]) => {
      lines.push(`${code} (${count}): ${DRIFT_DESCRIPTIONS[code]}`);
    });

    // Enrich D4 (stuck manager approvals) with the actual plan IDs + reassignment links so the
    // alert is actionable, not just a count. Best-effort — a listing failure never blocks the alert.
    if (driftCodes.includes("D4")) {
      try {
        const gapRecords = await listWeeklyPlanManagerGapRecords();
        if (gapRecords.length > 0) {
          lines.push("");
          lines.push("D4 stuck plans — needs reassignment (Approvals Hub → Stuck approvals):");
          for (const record of gapRecords.slice(0, 25)) {
            const manager = record.managerName ?? record.managerHrId ?? "no manager";
            lines.push(
              `- ${record.employeeName} (${record.employeeHrId}) — ${record.status} — approver: ${manager} — /admin/weekly-plans?plan=${record.planId}`,
            );
          }
          if (gapRecords.length > 25) {
            lines.push(`…and ${gapRecords.length - 25} more.`);
          }
        }
      } catch (listError) {
        logError("Weekly plans drift D4 gap listing failed", {
          labels: { event: "weekly_plans_drift_d4_gap_listing_failed" },
          error: listError,
        });
      }
    }

    lines.push("");
    lines.push("Investigate before the next deploy. See scripts/weekly-plans-drift.sql for the full queries.");
    lines.push("Dashboard: /admin/weekly-plans");

    const title = `Weekly Plans Drift: ${totalAnomalies} anomal${totalAnomalies === 1 ? "y" : "ies"} (${driftCodes.join(", ")})`;
    const message = lines.join("\n");
    const today = new Date().toISOString().slice(0, 10);

    const recipients = await resolveDriftAlertRecipients();
    let sentCount = 0;
    for (const recipientHrId of recipients) {
      const result = await createSystemNotification({
        actionUrl: "/admin/weekly-plans",
        category: "weekly_plan",
        eventType: "drift_alert",
        message,
        metadata: {
          anomalies: totalAnomalies,
          driftCodes,
          idempotencyKey: `weekly_plans_drift:${recipientHrId}:${today}`,
        },
        module: "weekly_plans",
        priority: "high",
        recipientHrId,
        title,
      });
      if (result.deliveries.some((delivery) => delivery.status === "sent")) sentCount += 1;
    }

    return { ok: true, anomalies: totalAnomalies, driftCodes, sentCount };
  } catch (error) {
    return {
      ok: false,
      anomalies: 0,
      driftCodes: [],
      sentCount: 0,
      error: error instanceof Error ? error.message : "Weekly plans drift check failed.",
    };
  }
}
