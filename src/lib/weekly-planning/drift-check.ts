// Daily drift detector for weekly/monthly plans — wired into /api/notifications/daily.
// Runs phx_weekly_plans_drift_check() (read-only RPC) and alerts Super Admins + HR
// Managers when any of the 6 impossible-state queries returns a non-zero count.
// Empty result → no notification (no zero-row spam). Idempotent via dedupe key.

import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type DriftCounts = Record<"D1" | "D2" | "D3" | "D4" | "D5" | "D6", number>;

const DRIFT_DESCRIPTIONS: Record<keyof DriftCounts, string> = {
  D1: "final_approved plans missing final_approved_at timestamp",
  D2: "advanced-status plans missing submitted_at timestamp",
  D3: "manager decision actor/timestamp mismatch (XOR violation)",
  D4: "plans awaiting manager decision with NULL/terminated manager",
  D5: "header status does not match most recent decision row",
  D6: "hr_acknowledged plans with no acknowledgement row",
};

const ALERT_RECIPIENT_ROLES = ["Super Admin", "HR Manager"] as const;

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
