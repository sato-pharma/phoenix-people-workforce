/**
 * Proactive monthly HR digest — Tier 2.3 of the FWC upscaling roadmap. Before this, FWC was
 * 100% pull: an admin had to remember to open the page. Rides the existing daily
 * notification cron (no new Vercel cron schedule — the Hobby/Pro sub-daily-cron constraint
 * still applies) but only acts on the 1st calendar day of the month, summarizing the
 * now-closed previous month.
 *
 * Per-manager threshold alert (the roadmap's other half of 2.3) is explicitly deferred — no
 * threshold number was confirmed for this pass. Only the monthly HR digest below is built.
 *
 * Recipients: Super Admin role only (narrower than outstation's high-risk digest, since this
 * is HR/compliance data, not a finance-adjacent alert). Idempotent per recipient per month via
 * the outbox dedupe key, matching every other digest in this codebase.
 */

import { fieldWorkforceMonthKey } from "@/lib/field-workforce-compliance/archive";
import {
  getFieldWorkforceComplianceLiveSnapshot,
  summarizeFieldWorkforceMirrorFreshness,
} from "@/lib/field-workforce-compliance/live-snapshots";
import { createSystemNotification, logNotificationSendFailure } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getLatestVisitsSyncRuns } from "@/lib/visits-report/service";

const DIGEST_RECIPIENT_ROLES = ["Super Admin"] as const;

export type FieldWorkforceComplianceDigestResult =
  | { ok: true; monthKey: null; recipientCount: 0; sentCount: 0; skipped: true }
  | { ok: true; monthKey: string; recipientCount: number; sentCount: number; skipped: false }
  | { ok: false; error: string; monthKey: null; recipientCount: 0; sentCount: 0; skipped: false };

/** Pure — exported for direct unit testing. Only the 1st calendar day of the month triggers
 * the digest, so it rides the existing daily cron without a new schedule; every other day
 * this is a fast no-op check, not a real computation. */
export function isFieldWorkforceDigestDay(nowIso: string): boolean {
  return nowIso.slice(8, 10) === "01";
}

/** Pure — exported for direct unit testing. The now-closed previous month's key relative to
 * `nowIso`, handling the January -> December-of-prior-year wraparound. */
export function previousFieldWorkforceMonthKey(nowIso: string): string {
  const year = Number(nowIso.slice(0, 4));
  const month = Number(nowIso.slice(5, 7));
  return month === 1 ? fieldWorkforceMonthKey(year - 1, 12) : fieldWorkforceMonthKey(year, month - 1);
}

async function resolveDigestRecipients(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
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
}

/** Top-level entry — wired into the daily-cron Promise.all. */
export async function runFieldWorkforceComplianceDigest(): Promise<FieldWorkforceComplianceDigestResult> {
  const nowIso = new Date().toISOString();
  if (!isFieldWorkforceDigestDay(nowIso)) {
    return { ok: true, monthKey: null, recipientCount: 0, sentCount: 0, skipped: true };
  }

  try {
    const monthKey = previousFieldWorkforceMonthKey(nowIso);
    const [snapshot, syncRuns] = await Promise.all([
      getFieldWorkforceComplianceLiveSnapshot({ monthKey }),
      getLatestVisitsSyncRuns(10),
    ]);

    const freshness = summarizeFieldWorkforceMirrorFreshness({ monthKey, nowIso, runs: syncRuns });
    const unresolvedCount = snapshot.preview.employees.filter(
      (employee) => employee.crmIdentity?.confidence === "unresolved",
    ).length;
    const highSeverityCount = snapshot.highSeverityCount;
    const employeeCount = snapshot.employeeCount;

    const recipients = await resolveDigestRecipients();
    if (recipients.length === 0) {
      return { ok: true, monthKey, recipientCount: 0, sentCount: 0, skipped: false };
    }

    const lines: string[] = [];
    lines.push(`Field Workforce Compliance for ${monthKey}: ${employeeCount} employees reviewed.`);
    lines.push("");
    lines.push(
      highSeverityCount > 0
        ? `${highSeverityCount} High-severity day(s) flagged across the month.`
        : "No High-severity days this month.",
    );
    if (unresolvedCount > 0) {
      lines.push(
        `${unresolvedCount} employee(s) have no CRM identity mapping — their "N" days are excluded from deduction candidates until fixed.`,
      );
    }
    if (freshness.isStale) {
      lines.push(
        `Warning: the visits mirror sync appears stale (last successful sync ${freshness.ageHours ?? "unknown"}h ago) — this month's report may be incomplete.`,
      );
    }
    lines.push("");
    lines.push("Review: /admin/field-workforce-compliance");

    const title = highSeverityCount > 0
      ? `Field Workforce Compliance: ${highSeverityCount} High-severity day(s) in ${monthKey}`
      : `Field Workforce Compliance: ${monthKey} clean month`;
    const message = lines.join("\n");

    let sentCount = 0;
    for (const recipientHrId of recipients) {
      const result = await createSystemNotification({
        actionUrl: "/admin/field-workforce-compliance",
        category: "field_workforce_compliance",
        eventType: "monthly_digest",
        message,
        metadata: {
          employeeCount,
          highSeverityCount,
          idempotencyKey: `field_workforce_compliance_digest:${recipientHrId}:${monthKey}`,
          monthKey,
          unresolvedCount,
        },
        module: "field_workforce_compliance",
        priority: highSeverityCount > 0 ? "high" : "normal",
        recipientHrId,
        title,
      });
      if (result.deliveries.some((delivery) => delivery.status === "sent")) sentCount += 1;
    }

    return { ok: true, monthKey, recipientCount: recipients.length, sentCount, skipped: false };
  } catch (error) {
    logNotificationSendFailure("fieldWorkforceCompliance.monthlyDigest", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Field Workforce Compliance monthly digest failed.",
      monthKey: null,
      recipientCount: 0,
      sentCount: 0,
      skipped: false,
    };
  }
}
