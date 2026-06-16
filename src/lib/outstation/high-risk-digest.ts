// Daily digest of high-risk outstation expense requests. Fires from the
// existing 04:00 UTC daily cron — no new Vercel cron (Hobby/Pro restraint).
// Sends to Super Admin / Finance Manager / CEO via createSystemNotification's
// per-recipient loop so each recipient's preferences and channels (email +
// in_app + telegram if enabled) are honoured.
//
// Empty-day behaviour: no rows → no notification (no zero-row spam). Idempotent
// per recipient per day via the outbox dedupe key.

import { createSystemNotification } from "@/lib/notifications/system";
import { highRiskReasons, isHighRiskRequest } from "@/lib/outstation/expense-risk";
import { listOutstationRequests } from "@/lib/outstation/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const DIGEST_LOOKBACK_HOURS = 24;
const DIGEST_RECIPIENT_ROLES = ["Super Admin", "Finance Manager", "CEO"] as const;
const MAX_ROWS_IN_MESSAGE = 15;

export type HighRiskDigestResult =
  | { ok: true; rowCount: number; recipientCount: number; sentCount: number }
  | { ok: false; rowCount: 0; recipientCount: 0; sentCount: 0; error: string };

function egpDisplay(value: number): string {
  // Server-side EGP formatter (no decimals); intentionally inlined so this file
  // has no client/component coupling.
  const safe = Number.isFinite(value) ? value : 0;
  return `EGP ${Math.round(safe).toLocaleString("en-GB")}`;
}

function isSchemaMissing(error: unknown, table: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes(table.toLowerCase());
}

async function resolveDigestRecipients(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from("app_auth_users")
      .select("hr_id, role, is_active")
      .in("role", DIGEST_RECIPIENT_ROLES as unknown as string[])
      .eq("is_active", true);
    if (error) throw error;
    const hrIds = new Set<string>();
    (data ?? []).forEach((row) => {
      const hrId = String((row as { hr_id?: unknown }).hr_id ?? "").trim();
      if (hrId) hrIds.add(hrId);
    });
    return Array.from(hrIds);
  } catch (error) {
    if (isSchemaMissing(error, "app_auth_users")) return [];
    throw error;
  }
}

/** Top-level entry — wired into the daily-cron Promise.all. */
export async function runOutstationHighRiskDigest(): Promise<HighRiskDigestResult> {
  try {
    const since = new Date(Date.now() - DIGEST_LOOKBACK_HOURS * 3_600_000);
    const sinceIso = since.toISOString();
    const day = sinceIso.slice(0, 10);

    const requests = await listOutstationRequests();
    const flagged = requests
      .filter((request) => {
        const stamp = request.submittedAt || request.createdAt;
        if (!stamp) return false;
        return new Date(stamp).getTime() >= since.getTime() && isHighRiskRequest(request);
      })
      .sort((left, right) => right.claimedTotalAmount - left.claimedTotalAmount);

    if (flagged.length === 0) {
      return { ok: true, rowCount: 0, recipientCount: 0, sentCount: 0 };
    }

    const recipients = await resolveDigestRecipients();
    if (recipients.length === 0) {
      return { ok: true, rowCount: flagged.length, recipientCount: 0, sentCount: 0 };
    }

    // Plain-text summary — the template wraps it. Cap rows in the message body so
    // a flood day still produces a readable email; the dashboard has the rest.
    const previewRows = flagged.slice(0, MAX_ROWS_IN_MESSAGE);
    const totalClaimed = flagged.reduce((sum, request) => sum + request.claimedTotalAmount, 0);
    const lines: string[] = [];
    lines.push(
      `${flagged.length} high-risk outstation expense ${flagged.length === 1 ? "row was" : "rows were"} submitted in the last ${DIGEST_LOOKBACK_HOURS}h (claimed ${egpDisplay(totalClaimed)}).`,
    );
    lines.push("");
    previewRows.forEach((request, index) => {
      const employee = request.employeeName || request.employeeHrId || "Unknown";
      const destination = request.toLabel || request.toCity || request.toArea || "—";
      const reasons = highRiskReasons(request).join("; ") || "flagged";
      lines.push(
        `${index + 1}. ${employee} → ${destination} · ${egpDisplay(request.claimedTotalAmount)} · ${reasons}`,
      );
    });
    if (flagged.length > previewRows.length) {
      lines.push("");
      lines.push(`+ ${flagged.length - previewRows.length} more on the dashboard.`);
    }
    lines.push("");
    lines.push("Review: /admin/outstation/expense-command");

    const title = `Outstation: ${flagged.length} high-risk request${flagged.length === 1 ? "" : "s"} (${egpDisplay(totalClaimed)})`;
    const message = lines.join("\n");

    let sentCount = 0;
    for (const recipientHrId of recipients) {
      const result = await createSystemNotification({
        actionUrl: "/admin/outstation/expense-command",
        category: "outstation",
        eventType: "high_risk_digest",
        message,
        metadata: {
          idempotencyKey: `outstation_high_risk_digest:${recipientHrId}:${day}`,
          rowCount: flagged.length,
          totalClaimed,
        },
        module: "outstation",
        priority: "high",
        recipientHrId,
        title,
      });
      if (result.deliveries.some((delivery) => delivery.status === "sent")) sentCount += 1;
    }

    return { ok: true, rowCount: flagged.length, recipientCount: recipients.length, sentCount };
  } catch (error) {
    return {
      ok: false,
      rowCount: 0,
      recipientCount: 0,
      sentCount: 0,
      error: error instanceof Error ? error.message : "Outstation high-risk digest failed.",
    };
  }
}
