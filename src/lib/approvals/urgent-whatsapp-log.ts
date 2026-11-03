/**
 * The ledger of approval reminders (`approval_whatsapp_reminders`). It is also the guard: the row is claimed BEFORE the
 * send, on a unique person and Cairo day, so two ticks cannot both message someone, and a run that dies mid-send never
 * messages them twice that day. Kept apart from the reader so the webhook can load it without the approval chains.
 */

import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { approvalReminderStatusPatch, type ApprovalCounts, type ApprovalsLineStatus } from "./urgent-whatsapp-rules";

const TABLE = "approval_whatsapp_reminders";

export type ApprovalReminderClaim = {
  hrId: string;
  cairoDay: string;
  toWaId: string | null;
  phoneNumberId: string;
  counts: ApprovalCounts;
  total: number;
  status: "claimed" | "no_number";
};

export type ApprovalReminderOutcome = {
  status: "accepted" | "failed";
  wamid: string | null;
  failureReason: string | null;
};

export async function readClaimedHrIds(cairoDay: string): Promise<Set<string>> {
  const { data, error } = await getSupabaseAdmin().from(TABLE).select("hr_id").eq("cairo_day", cairoDay);
  if (error) throw error;
  return new Set(((data ?? []) as Array<{ hr_id: string }>).map((row) => row.hr_id));
}

/** True only for the one caller that won the row. */
export async function claimApprovalReminder(claim: ApprovalReminderClaim): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .upsert(
      {
        cairo_day: claim.cairoDay,
        counts: claim.counts,
        hr_id: claim.hrId,
        phone_number_id: claim.phoneNumberId,
        status: claim.status,
        to_wa_id: claim.toWaId,
        total: claim.total,
      },
      { ignoreDuplicates: true, onConflict: "hr_id,cairo_day" },
    )
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export async function finishApprovalReminder(hrId: string, cairoDay: string, outcome: ApprovalReminderOutcome): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from(TABLE)
    .update({
      failure_reason: outcome.failureReason,
      status: outcome.status,
      updated_at: new Date().toISOString(),
      wamid: outcome.wamid,
    })
    .eq("hr_id", hrId)
    .eq("cairo_day", cairoDay);
  if (error) throw error;
}

/**
 * Meta's delivery ticks on the third number, applied to the ledger. "Accepted" only means Meta took the message, and a
 * number that is not on WhatsApp fails afterwards, so without this a dead number reads as a reminder sent. Called from
 * the webhook, so it never throws: a failed write here must not make Meta redeliver the applicants beside it.
 */
export async function applyApprovalsLineStatuses(statuses: readonly ApprovalsLineStatus[]): Promise<void> {
  for (const status of statuses) {
    const patch = approvalReminderStatusPatch(status);
    if (!patch) continue;
    try {
      const { error } = await getSupabaseAdmin()
        .from(TABLE)
        .update({ failure_reason: patch.failureReason, status: patch.status, updated_at: new Date().toISOString() })
        .eq("wamid", status.wamid)
        .in("status", [...patch.from]);
      if (error) throw error;
    } catch (error) {
      logError("An approval reminder's delivery tick was not recorded", {
        error,
        labels: { event: "approval_whatsapp_status_failed", webhook: "whatsapp" },
      });
    }
  }
}
