import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { LeaveWorkflowActor, LeaveWorkflowStatus } from "@/lib/leave/requests";

type JsonRecord = Record<string, unknown>;

export async function recordLeaveRequestEvent(input: {
  actorHrId?: string | null;
  actorRole: LeaveWorkflowActor | string;
  eventType: string;
  fromStatus?: string | null;
  overrideReason?: string | null;
  reason?: string | null;
  requestId: string;
  snapshot?: JsonRecord;
  toStatus?: string | null;
}) {
  const { error } = await getSupabaseAdmin().from("leave_request_events").insert({
    actor_hr_id: input.actorHrId ?? null,
    actor_role: input.actorRole,
    event_type: input.eventType,
    from_status: input.fromStatus ?? null,
    override_reason: input.overrideReason ?? null,
    payload_snapshot: input.snapshot ?? {},
    reason: input.reason ?? null,
    request_id: input.requestId,
    to_status: input.toStatus ?? null,
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function createLeaveNotificationAttempt(input: {
  channel: "email" | "in_app";
  errorText?: string | null;
  metadata?: JsonRecord;
  recipients: string[];
  requestId: string;
  stage: LeaveWorkflowStatus | string;
  status: "pending" | "sent" | "failed" | "skipped";
}) {
  const { data, error } = await getSupabaseAdmin()
    .from("leave_notification_attempts")
    .insert({
      channel: input.channel,
      error_text: input.errorText ?? null,
      provider_response: input.metadata ?? {},
      recipients: input.recipients,
      request_id: input.requestId,
      stage: input.stage,
      status: input.status,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return String(data?.id ?? "");
}

export async function updateLeaveNotificationAttempt(input: {
  attemptId: string;
  errorText?: string | null;
  metadata?: JsonRecord;
  status: "pending" | "sent" | "failed" | "skipped";
}) {
  const { error } = await getSupabaseAdmin()
    .from("leave_notification_attempts")
    .update({
      error_text: input.errorText ?? null,
      provider_response: input.metadata ?? {},
      status: input.status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.attemptId);

  if (error) {
    throw new Error(error.message);
  }
}
