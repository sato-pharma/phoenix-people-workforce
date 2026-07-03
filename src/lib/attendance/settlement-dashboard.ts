// Live settlement dashboard: real-time counts and the pending-action list
// across every employee's weekly digests for a cycle — the admin control-
// tower view, plus the remind-all action it hosts.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { cairoTodayIso } from "@/lib/attendance/working-days";
import { resolveDigestCycle } from "@/lib/attendance/digest-cycle";
import { getDigestSettings } from "@/lib/attendance/digest-recipients";
import { notifyDigestSent } from "@/lib/attendance/digest-notify";
import { getReadReceiptsForEvents } from "@/lib/attendance/digest-read-receipts";

export type DigestStatusCounts = Record<
  "draft" | "sent" | "settled" | "auto_confirmed" | "void",
  { count: number; totalDeductionValue: number }
>;

export type PendingDigestSummary = {
  id: number;
  employeeHrId: string;
  employeeName: string;
  weekIndex: number;
  weekStart: string;
  weekEnd: string;
  totalDeductionDays: number;
  totalDeductionValue: number;
  sentAt: string | null;
  autoConfirmAt: string | null;
  /** null = read-receipt not tracked for this digest (sent before this feature, or notification failed to queue). */
  hasBeenRead: boolean | null;
  firstReadAt: string | null;
};

export type SettlementDashboard = {
  cycleKey: string;
  byStatus: DigestStatusCounts;
  pendingDigests: PendingDigestSummary[];
  openDisputeCount: number;
};

const emptyStatusCounts = (): DigestStatusCounts => ({
  auto_confirmed: { count: 0, totalDeductionValue: 0 },
  draft: { count: 0, totalDeductionValue: 0 },
  sent: { count: 0, totalDeductionValue: 0 },
  settled: { count: 0, totalDeductionValue: 0 },
  void: { count: 0, totalDeductionValue: 0 },
});

/** The current 24->24 cycle key, or the caller's override. */
export async function resolveDashboardCycleKey(cycleKey?: string): Promise<string> {
  if (cycleKey) return cycleKey;
  const settings = await getDigestSettings();
  return resolveDigestCycle(cairoTodayIso(), settings.cycleAnchorDay).cycleKey;
}

export async function getSettlementDashboard(cycleKey?: string): Promise<SettlementDashboard> {
  const resolvedCycleKey = await resolveDashboardCycleKey(cycleKey);
  const supabase = getSupabaseAdmin();

  const { data: digestRows, error: digestError } = await supabase
    .from("attendance_weekly_digests")
    .select("id,employee_hr_id,week_index,week_start,week_end,status,sent_at,auto_confirm_at,total_deduction_days,total_deduction_value,notification_event_id")
    .eq("cycle_key", resolvedCycleKey)
    .order("week_index", { ascending: true });
  if (digestError) throw new Error(`Settlement dashboard digest lookup failed: ${digestError.message}`);

  const rows = (digestRows ?? []) as Array<{
    id: number;
    employee_hr_id: string;
    week_index: number;
    week_start: string;
    week_end: string;
    status: keyof DigestStatusCounts;
    sent_at: string | null;
    auto_confirm_at: string | null;
    total_deduction_days: number;
    total_deduction_value: number;
    notification_event_id: string | null;
  }>;

  const byStatus = emptyStatusCounts();
  const pendingRows = rows.filter((row) => row.status === "sent");
  for (const row of rows) {
    byStatus[row.status].count += 1;
    byStatus[row.status].totalDeductionValue += Number(row.total_deduction_value);
  }

  const employeeHrIds = Array.from(new Set(pendingRows.map((row) => row.employee_hr_id)));
  const nameByHrId = new Map<string, string>();
  if (employeeHrIds.length > 0) {
    const { data: employeeRows, error: employeeError } = await supabase
      .from("employees")
      .select("hr_id,full_name")
      .in("hr_id", employeeHrIds);
    if (employeeError) throw employeeError;
    for (const row of (employeeRows ?? []) as Array<{ hr_id: string; full_name: string | null }>) {
      const hrId = normalizeAttendanceHrId(row.hr_id);
      if (hrId) nameByHrId.set(hrId, row.full_name?.trim() || row.hr_id);
    }
  }

  const { count: openDisputeCount } = await supabase
    .from("attendance_digest_lines")
    .select("id", { count: "exact", head: true })
    .eq("action", "disputed");

  const readReceipts = await getReadReceiptsForEvents(
    pendingRows.map((row) => row.notification_event_id).filter((value): value is string => Boolean(value)),
  );

  return {
    byStatus,
    cycleKey: resolvedCycleKey,
    openDisputeCount: openDisputeCount ?? 0,
    pendingDigests: pendingRows.map((row) => {
      const receipt = row.notification_event_id ? readReceipts.get(row.notification_event_id) : undefined;
      return {
        autoConfirmAt: row.auto_confirm_at,
        employeeHrId: row.employee_hr_id,
        employeeName: nameByHrId.get(normalizeAttendanceHrId(row.employee_hr_id) ?? "") ?? row.employee_hr_id,
        firstReadAt: receipt?.firstReadAt ?? null,
        hasBeenRead: receipt ? receipt.hasBeenRead : null,
        id: row.id,
        sentAt: row.sent_at,
        totalDeductionDays: Number(row.total_deduction_days),
        totalDeductionValue: Number(row.total_deduction_value),
        weekEnd: row.week_end,
        weekIndex: row.week_index,
        weekStart: row.week_start,
      };
    }),
  };
}

/**
 * Re-sends the digest-sent notice to every employee with a currently pending
 * (sent, unconfirmed) digest — an admin nudging every non-responder at once
 * instead of chasing them individually. Best-effort: one failed send never
 * blocks the rest.
 */
export async function remindAllPendingDigests(cycleKey?: string): Promise<{ reminded: number; failed: number }> {
  const dashboard = await getSettlementDashboard(cycleKey);
  const settings = await getDigestSettings();

  let reminded = 0;
  let failed = 0;
  await Promise.all(
    dashboard.pendingDigests.map(async (digest) => {
      try {
        await notifyDigestSent({
          actionUrl: "/employee-portals/attendance/digests",
          autoConfirmHours: settings.autoConfirmHours,
          currency: "EGP",
          employeeHrId: digest.employeeHrId,
          totalDeductionValue: digest.totalDeductionValue,
          weekLabel: `${digest.weekStart} to ${digest.weekEnd} (reminder)`,
        });
        reminded += 1;
      } catch {
        failed += 1;
      }
    }),
  );

  return { failed, reminded };
}
