import { randomUUID } from "node:crypto";

import { getSupabaseAdmin } from "@/lib/supabase/server";

export type LeaveAuditEvent = {
  actorHrId?: string | null;
  actorRole?: string | null;
  correlationId?: string | null;
  employeeHrId?: string | null;
  eventType: string;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
};

export function createLeaveCorrelationId() {
  return randomUUID();
}

export async function writeLeaveAuditLog(event: LeaveAuditEvent) {
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("leave_audit_logs").insert({
      actor_hr_id: event.actorHrId ?? null,
      actor_role: event.actorRole ?? null,
      correlation_id: event.correlationId ?? createLeaveCorrelationId(),
      employee_hr_id: event.employeeHrId ?? null,
      event_type: event.eventType,
      metadata: event.metadata ?? {},
      request_id: event.requestId ?? null,
    });
    if (error) throw error;
  } catch (error) {
    console.warn("Leave audit log skipped", {
      error: error instanceof Error ? error.message : String(error),
      eventType: event.eventType,
    });
  }
}
